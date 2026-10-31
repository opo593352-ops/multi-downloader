/**
 * playlist.mjs — 歌单 / 专辑 批量下载（剪辑线配乐用）
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么要单独一个模块
 * ═══════════════════════════════════════════════════════════════
 *
 *   music-dl.mjs 是「搜一首歌 → 货比三家 → 下一个」，
 *   歌单是「给一个链接 → 一次下几十首」。流程完全不同：
 *     · 要先解析歌单结构（各平台接口不一样）
 *     · 要限速（一口气 200 首必被封）
 *     · 要断点续传（下到第 87 首断了，不能从头再来）
 *     · 要跳过已存在的（重复跑不该重复下）
 *
 *   混进 music-dl 会让那个文件更难改。所以独立。
 *
 * ═══════════════════════════════════════════════════════════════
 * 各平台歌单接口实测（2026-10-28）
 * ═══════════════════════════════════════════════════════════════
 *
 *   网易云 ✅ 可用，且**不需要签名**
 *     https://music.163.com/api/playlist/detail?id=<id>
 *     → result.tracks[] { name, id, artists[{name}], album{name}, duration }
 *     实测「热歌榜」200 首一次拿全（614 KB）。
 *
 *   网易云专辑 ❌ 需要登录
 *     /api/album/<id> 返回 code:-462「绑定手机后，可进行下一步操作」
 *     → 所以专辑批量走「搜索 专辑名 + 歌手」的替代路径。
 *
 *   酷我歌单 ❌ musiclist 恒为空
 *     nplserver.kuwo.cn/pl.svc 只返回 total=33，musiclist:[] ——
 *     歌单存在但曲目不下发（已改成需要签名/登录）。
 *     → 酷我的歌单只能靠 music-dl 的单曲搜索替代，不在这里做。
 *
 *   QQ 歌单 ⚠️ 需要 uin + 签名，不稳定，暂不做。
 *
 * ═══════════════════════════════════════════════════════════════
 * 断点续传：靠「已存在就跳过」
 * ═══════════════════════════════════════════════════════════════
 *
 *   不维护额外的进度文件（那种文件一旦和实际文件不同步就会出错）。
 *   直接看目标目录里有没有同名音频：有就跳过。
 *   `--force` 可以强制重下。
 *
 *   这个设计的好处：用户手动删掉某个文件，重跑就会补回来；
 *   中断后重跑，已下好的不会重复下载。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { assertFeature } from '../dev/gate.mjs';
import { fetchMusicMeta } from './music-meta.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const OUT_DEFAULT = path.join(os.homedir(), 'Downloads', '歌单');

const log = (...a) => console.log(...a);
const warn = (...a) => console.error('[warn]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safeName(s, max = 80) {
  return String(s || 'track')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim()
    .slice(0, max) || 'track';
}

function fmtSize(b) {
  if (!b) return '-';
  if (b > 1024 ** 3) return (b / 1024 ** 3).toFixed(2) + ' GB';
  if (b > 1024 ** 2) return (b / 1024 ** 2).toFixed(2) + ' MB';
  return (b / 1024).toFixed(0) + ' KB';
}

function msToDur(ms) {
  if (!ms) return '';
  const s = Math.round(Number(ms) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

async function getJson(url, headers = {}, timeoutMs = 25000) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: '*/*', ...headers },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const t = await res.text();
  try { return JSON.parse(t); } catch { throw new Error('返回不是 JSON'); }
}

// ───────────────────── 歌单解析 ─────────────────────

/**
 * 从链接里认出平台和 ID。
 * 支持：
 *   https://music.163.com/playlist?id=3778678
 *   https://music.163.com/#/playlist?id=3778678
 *   https://y.music.163.com/m/playlist?id=3778678
 *   https://music.163.com/album?id=74715426
 *   （纯数字 = 网易云歌单 id，方便直接粘 id）
 */
function parsePlaylistUrl(raw) {
  const s = String(raw || '').trim();

  // 纯数字：当网易云歌单 id
  if (/^\d+$/.test(s)) return { platform: 'netease', kind: 'playlist', id: s };

  const idm = s.match(/[?&#]id=(\d+)/);
  const id = idm ? idm[1] : null;

  if (/music\.163\.com/.test(s) && id) {
    const kind = /\/album/.test(s) ? 'album' : 'playlist';
    return { platform: 'netease', kind, id };
  }

  // 酷我 / QQ 的歌单链接先认出来，给出明确的"不支持"原因
  if (/kuwo\.cn/.test(s)) return { platform: 'kuwo', kind: 'unsupported', id: null };
  if (/y\.qq\.com|qq\.com\/n\/ryqq/.test(s)) return { platform: 'qq', kind: 'unsupported', id: null };

  return null;
}

/** 网易云歌单 → 曲目列表 */
async function fetchNeteasePlaylist(id, opts) {
  const j = await getJson(
    `https://music.163.com/api/playlist/detail?id=${encodeURIComponent(id)}`,
    { Referer: 'https://music.163.com/' }
  );
  const res = j && j.result;
  if (!res) throw new Error('歌单接口没返回数据（可能是私密歌单或 ID 不对）');

  const tracks = (res.tracks || []).map((t) => ({
    platform: 'netease',
    id: String(t.id),
    title: t.name || '',
    artist: (t.artists || t.ar || []).map((a) => a.name).filter(Boolean).join(' / '),
    album: (t.album || t.al || {}).name || '',
    duration: msToDur(t.duration),
    fee: t.fee,          // 1/4 = 付费，后面跳过
    status: t.status,    // <0 = 下架
  }));

  return {
    name: res.name || `netease_${id}`,
    total: res.trackCount || tracks.length,
    tracks,
    creator: (res.creator && res.creator.nickname) || '',
    cover: res.coverImgUrl || '',
  };
}

// ───────────────────── 下载 ─────────────────────

/**
 * 用 music-dl 的搜索+解析链路下一首。
 *
 * 为什么复用 music-dl 而不是自己写解析：
 *   网易云的直链解析、QQ 的 vkey、酷我的 anti.s 都已经在 music-dl 里
 *   调通并处理过各种失败情况。这里只需要"给歌名+歌手，下一首回来"。
 */
async function downloadOne(track, outDir, opts) {
  const keyword = `${track.title} ${track.artist}`.trim();

  // 动态 import：playlist.mjs 会被 cli 静态 import，
  // 而 music-dl 里也有自己的 assertFeature（music），
  // 直接静态 import 会让两个闸门都跑一遍，日志噪音大。
  const music = await import('./music-dl.mjs');

  // music-dl 的 main 读 process.argv，不能直接调。
  // 用它的内部命令函数 —— 但它没导出，所以这里改成调 run() 的等价路径：
  // 临时改写 argv 太脏，改为直接走 CLI 子进程？也不行（SEA 里没 node）。
  //
  // 结论：复用 searchAll/resolveAll 需要它们被导出。
  // 见文件末尾的 export 补丁（在 music-dl.mjs 里加）。
  if (typeof music.searchAndResolve !== 'function') {
    throw new Error('music-dl 未导出 searchAndResolve（版本不匹配）');
  }
  return music.searchAndResolve(keyword, {
    out: outDir,
    limit: 3,
    pick: 1,
    best: true,
    meta: opts.meta,
    quiet: opts.quiet,
  });
}

// ───────────────────── 主流程 ─────────────────────

async function runPlaylist(rawUrl, opts) {
  const info = parsePlaylistUrl(rawUrl);
  if (!info) throw new Error(`认不出这是哪个平台的歌单链接：${rawUrl}`);

  if (info.kind === 'unsupported') {
    const why = {
      kuwo: '酷我歌单接口已改成需要签名，拿不到曲目列表（实测 2026-10-28）。\n' +
            '     替代方案：用 music search 逐首搜，或用网易云歌单。',
      qq: 'QQ 歌单需要 uin + 签名，不稳定，暂不支持。\n' +
          '     替代方案：用网易云歌单，或 music search 逐首搜。',
    }[info.platform];
    throw new Error(why || '该平台歌单暂不支持');
  }

  log(`\n━━━ 解析歌单: ${rawUrl}`);
  let pl;
  if (info.platform === 'netease' && info.kind === 'playlist') {
    pl = await fetchNeteasePlaylist(info.id, opts);
  } else if (info.platform === 'netease' && info.kind === 'album') {
    throw new Error(
      '网易云专辑接口需要登录（返回 -462「绑定手机后…」）。\n' +
      '     替代方案：用歌单链接，或 music get "专辑名 歌手" 逐首下。'
    );
  } else {
    throw new Error('暂不支持该类型');
  }

  log(`  歌单: ${pl.name}`);
  log(`  作者: ${pl.creator || '-'}   共 ${pl.total} 首`);

  // 过滤：付费/下架的先剔掉，别让用户以为程序坏了
  const usable = pl.tracks.filter((t) => {
    if (t.status !== undefined && t.status < 0) return false;
    if (t.fee === 1 || t.fee === 4) return false;   // 付费专辑/数字专辑
    return true;
  });
  const skippedFee = pl.tracks.length - usable.length;
  if (skippedFee > 0) {
    warn(`  跳过 ${skippedFee} 首（付费/下架）`);
  }

  // 区间切片（--from / --to，1 基，方便"接着上次下"）
  let list = usable;
  if (opts.from > 0 || opts.to > 0) {
    const from = Math.max(1, opts.from || 1);
    const to = opts.to > 0 ? Math.min(opts.to, usable.length) : usable.length;
    list = usable.slice(from - 1, to);
    log(`  区间: 第 ${from} ~ ${to} 首（共 ${list.length} 首）`);
  }
  if (opts.limit > 0) list = list.slice(0, opts.limit);

  // 歌单子目录
  const dirName = safeName(`${pl.name}`, 70);
  const outDir = path.join(opts.out, dirName);
  await fsp.mkdir(outDir, { recursive: true });
  log(`  输出: ${outDir}`);
  log('');

  let ok = 0, fail = 0, skip = 0;
  const failedList = [];

  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    const label = `${t.title} - ${t.artist}`;
    const base = safeName(label, 70);

    // 断点续传：同名音频已存在就跳过（不维护额外进度文件）
    if (!opts.force) {
      const exists = await fsp.readdir(outDir).catch(() => []);
      const hit = exists.find((f) => f.startsWith(base + '.') &&
        /\.(mp3|m4a|flac|aac|wav|ogg)$/i.test(f));
      if (hit) {
        log(`  [${i + 1}/${list.length}] ${label}  ⏭ 已存在`);
        skip++;
        continue;
      }
    }

    log(`  [${i + 1}/${list.length}] ${label}`);
    try {
      const r = await downloadOne(t, outDir, opts);
      if (r && r.skipped) {
        log(`      ⏭ ${r.skipped}`);
        skip++;
      } else {
        ok++;
      }
    } catch (e) {
      fail++;
      failedList.push({ track: label, error: e.message });
      warn(`      ✗ ${e.message}`);
    }

    // 限速：一口气几十首必被平台限流
    if (i < list.length - 1) await sleep(opts.delay);
  }

  log('');
  log(`━━━ 歌单完成 ━━━`);
  log(`  成功 ${ok} 首，跳过 ${skip} 首，失败 ${fail} 首`);
  log(`  目录: ${outDir}`);
  if (failedList.length) {
    log(`  失败清单（可重跑，已下的会跳过）：`);
    for (const f of failedList.slice(0, 10)) log(`    · ${f.track}  ← ${f.error}`);
    if (failedList.length > 10) log(`    … 还有 ${failedList.length - 10} 首`);
  }

  return { name: pl.name, dir: outDir, ok, skip, fail, total: list.length };
}

// ───────────────────── CLI ─────────────────────

function parseArgs(argv) {
  const opts = {
    out: OUT_DEFAULT,
    delay: 1500,      // 每首间隔（毫秒）
    from: 0,
    to: 0,
    limit: 0,
    force: false,
    meta: false,
    quiet: false,
    listOnly: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-o': case '--out': opts.out = argv[++i]; break;
      case '--delay': opts.delay = Math.max(0, Number(argv[++i]) || 1500); break;
      case '--from': opts.from = Number(argv[++i]) || 0; break;
      case '--to': opts.to = Number(argv[++i]) || 0; break;
      case '-n': case '--limit': opts.limit = Number(argv[++i]) || 0; break;
      case '--force': opts.force = true; break;
      case '--meta': opts.meta = true; break;
      case '--list': opts.listOnly = true; break;
      case '--quiet': opts.quiet = true; break;
      case '-h': case '--help': opts.help = true; break;
      default:
        if (!a.startsWith('-')) positional.push(a);
    }
  }
  return { opts, urls: positional };
}

function printHelp() {
  console.log(`
歌单批量下载（剪辑配乐用）

用法:
  node playlist.mjs <歌单链接> [更多...] [选项]

选项:
  -o, --out <dir>     输出目录（默认 ~/Downloads/歌单）
  --from <n>          从第 n 首开始（1 基，接着上次下用）
  --to <n>            到第 n 首结束
  -n, --limit <n>     只下前 n 首（试水用）
  --delay <ms>        每首间隔（默认 1500，别设太小）
  --force             已存在的也重下
  --meta              顺带抓歌词和封面
  --list              只列清单，不下载
  -h, --help          帮助

支持的歌单:
  ✅ 网易云  https://music.163.com/playlist?id=3778678
  ✅ 纯数字 id 直接当网易云歌单
  ❌ 酷我    接口已需签名，拿不到曲目（会给出替代方案）
  ❌ QQ     需要 uin + 签名，暂不支持

断点续传:
  已下好的同名文件会自动跳过。中断后重跑即可，不会重复下载。

示例:
  node playlist.mjs "https://music.163.com/playlist?id=3778678"
  node playlist.mjs 3778678 -n 5 -o D:\\music
  node playlist.mjs 3778678 --from 50 --to 80 --meta
`);
}

async function main() {
  const { opts, urls } = parseArgs(process.argv.slice(2));
  if (opts.help || !urls.length) { printHelp(); process.exit(opts.help ? 0 : 1); }

  await fsp.mkdir(opts.out, { recursive: true });

  let failed = 0;
  const results = [];
  for (const u of urls) {
    try {
      // --list 只解析不下载
      if (opts.listOnly) {
        const info = parsePlaylistUrl(u);
        if (!info) throw new Error('认不出歌单链接');
        if (info.kind !== 'playlist' || info.platform !== 'netease') {
          throw new Error('该平台/类型不支持列清单');
        }
        const pl = await fetchNeteasePlaylist(info.id, opts);
        log(`\n━━━ ${pl.name}  （${pl.total} 首）`);
        pl.tracks.forEach((t, i) => log(`  ${String(i + 1).padStart(3)}. ${t.title} - ${t.artist}  ${t.duration}`));
        results.push({ name: pl.name, total: pl.total });
        continue;
      }
      results.push(await runPlaylist(u, opts));
    } catch (e) {
      failed++;
      warn(`✗ ${u}\n    ${e.message}`);
    }
  }

  process.exitCode = failed ? 1 : 0;
}

// ───────────────────── 入口 ─────────────────────
export async function run() {
  // 功能闸门：走 music 的授权（歌单属于音乐线）
  assertFeature('music');
  await main();
}

function isDirectRun() {
  try {
    const entry = process.argv[1] || '';
    return /playlist(\.mjs)?$/i.test(entry) || entry === '';
  } catch { return false; }
}

if (isDirectRun()) {
  main().catch((e) => {
    console.error('\n[致命]', e.message);
    process.exit(1);
  });
}
