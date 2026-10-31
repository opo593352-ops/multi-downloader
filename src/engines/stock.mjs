/**
 * stock.mjs — 免版权素材（B-roll）批量下载
 *
 * ═══════════════════════════════════════════════════════════════
 * 数据源实测（2026-10-28/29）
 * ═══════════════════════════════════════════════════════════════
 *
 *   Coverr ✅ **无需 key**，直接能用（本模块默认源）
 *     https://coverr.co/api/videos?page=1&urls=true&query=nature
 *     → hits[] { title, slug, duration, fps, urls.mp4 / mp4_preview,
 *                thumbnail, is_premium, tags[] }
 *     实测 total=2281，120 个 1080p 直链，CDN 不防盗链。
 *
 *   Pixabay ⚠️ 必须 API key（免费申请，1 分钟）
 *     API   https://pixabay.com/api/videos/?key=K&q=...   无 key 返回 400
 *     网页  https://pixabay.com/videos/search/...         被 Cloudflare 挡 403
 *     → 做成"填一次 key 就存下来"的可选源。
 *
 *   Pexels ⚠️ 必须 API key
 *     https://api.pexels.com/videos/search    无 key 返回 401
 *     → 同上。
 *
 *   Mixkit ✅ 网页可抓，但没有公开 JSON 接口，结构变动风险高，暂不做。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么 key 设计成"存盘"
 * ═══════════════════════════════════════════════════════════════
 *
 *   剪辑师一次配置、长期使用。存到
 *     %APPDATA%\UnifiedDownloader\stock-keys.json
 *   下次自动读，不用每次贴。
 *
 *   key 是**免费**的，不需要付费——这不是"付费墙"，只是 API 门槛。
 *   Coverr 作为默认源保证「不填 key 也能用」。
 *
 * ═══════════════════════════════════════════════════════════════
 * B-roll 场景化搜索
 * ═══════════════════════════════════════════════════════════════
 *
 *   剪辑找素材是"按场景找"不是"按关键词搜"。所以内置一批场景预设：
 *     broll.mjs --scene 城市夜景
 *     broll.mjs --scene 自然
 *     broll.mjs --scene 办公
 *   每个场景映射到一组英文关键词（素材站的英文结果质量远高于中文）。
 *
 * ═══════════════════════════════════════════════════════════════
 * 用法
 * ═══════════════════════════════════════════════════════════════
 *
 *   node stock.mjs <关键词> [更多关键词...] [-n 10]
 *   node stock.mjs --scene 城市夜景 -n 10
 *   node stock.mjs nature -o D:\broll --min-height 1080
 *   node stock.mjs --set-key pixabay <你的key>
 *   node stock.mjs --list                         列出内置场景
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { assertFeature } from '../dev/gate.mjs';

import { downloadFile as dlDownload } from '../dev/dl.mjs';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const OUT_DEFAULT = path.join(os.homedir(), 'Downloads', '素材');

function keysPath() {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, 'UnifiedDownloader', 'stock-keys.json');
}

const log = (...a) => console.log(...a);
const warn = (...a) => console.error('[warn]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safeName(s, max = 80) {
  return String(s || 'clip')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim()
    .slice(0, max) || 'clip';
}

function fmtSize(b) {
  if (!b) return '-';
  if (b > 1024 ** 3) return (b / 1024 ** 3).toFixed(2) + ' GB';
  if (b > 1024 ** 2) return (b / 1024 ** 2).toFixed(2) + ' MB';
  return (b / 1024).toFixed(0) + ' KB';
}

function fmtDur(sec) {
  const s = Math.round(Number(sec) || 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ───────────────────── 场景预设 ─────────────────────

/**
 * 剪辑师用"场景"思考，素材站吃"英文关键词"。
 * 这里做映射，比让用户自己想英文词有用得多。
 */
const SCENES = {
  '城市夜景': ['city night', 'neon street', 'urban night traffic'],
  '城市':     ['city', 'street', 'downtown'],
  '自然':     ['nature', 'forest', 'landscape'],
  '山':       ['mountain', 'peak', 'aerial mountain'],
  '海':       ['ocean', 'waves', 'sea aerial'],
  '天空':     ['sky', 'clouds', 'sunset timelapse'],
  '办公':     ['office', 'workspace', 'business meeting'],
  '科技':     ['technology', 'digital', 'circuit abstract'],
  '咖啡':     ['coffee', 'cafe', 'pouring coffee'],
  '人物':     ['people', 'portrait', 'walking person'],
  '抽象':     ['abstract', 'gradient', 'particles'],
  '慢动作':   ['slow motion', 'water splash', 'smoke'],
  '航拍':     ['aerial', 'drone', 'aerial view'],
  '美食':     ['food', 'cooking', 'restaurant'],
  '运动':     ['sport', 'running', 'fitness'],
  '雨雪':     ['rain', 'snow', 'weather'],
};

function resolveKeyword(raw, opts) {
  if (opts.scene) {
    const kws = SCENES[opts.scene];
    if (!kws) {
      throw new Error(
        `未知场景「${opts.scene}」\n可用场景：${Object.keys(SCENES).join('、')}`
      );
    }
    return kws;
  }
  return [raw];
}

// ───────────────────── key 管理 ─────────────────────

function loadKeys() {
  try { return JSON.parse(fs.readFileSync(keysPath(), 'utf-8')); } catch { return {}; }
}

function saveKeys(obj) {
  const p = keysPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
  return p;
}

/** 取某个源的 key：先环境变量，再存盘文件 */
function getKey(name) {
  const env = process.env[`${name.toUpperCase()}_API_KEY`];
  if (env) return env;
  const k = loadKeys();
  return k[name] || '';
}

// ───────────────────── Coverr（默认源，无需 key） ─────────────────────

async function searchCoverr(keyword, opts) {
  const page = opts.page || 1;
  const url =
    `https://coverr.co/api/videos?page=${page}&urls=true` +
    `&query=${encodeURIComponent(keyword)}`;

  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`Coverr HTTP ${res.status}`);
  const j = await res.json();

  const hits = j.hits || [];
  return hits
    .filter((h) => !h.is_premium)                    // 付费素材不下（下不到，且可能侵权）
    .map((h) => {
      const u = h.urls || {};
      // 优先 1080p 下载链，退回播放链
      const dl = u.mp4_download || u.mp4 || u.mp4_preview;
      return {
        source: 'coverr',
        id: h.id || h.slug || '',
        title: h.title || h.slug || 'clip',
        duration: Number(h.duration) || 0,
        width: Number(h.max_width) || 0,
        height: Number(h.max_height) || 0,
        fps: Number(h.fps) || 0,
        url: dl,
        previewUrl: u.mp4_preview || '',
        thumb: h.thumbnail || h.poster || '',
        vertical: !!h.is_vertical,
        tags: h.tags || [],
        license: 'Coverr License（免费商用，无需署名）',
        pageUrl: h.slug ? `https://coverr.co/videos/${h.slug}` : '',
      };
    })
    .filter((x) => x.url);
}

// ───────────────────── Pixabay（需 key） ─────────────────────

async function searchPixabay(keyword, opts) {
  const key = getKey('pixabay');
  if (!key) {
    throw new Error(
      '没有 Pixabay key。\n' +
      '     申请（免费，1 分钟）：https://pixabay.com/api/docs/\n' +
      '     存下来：node stock.mjs --set-key pixabay <你的key>'
    );
  }
  const per = Math.min(200, Math.max(3, opts.perPage || 20));
  const url =
    `https://pixabay.com/api/videos/?key=${encodeURIComponent(key)}` +
    `&q=${encodeURIComponent(keyword)}&per_page=${per}&safesearch=true`;

  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Pixabay HTTP ${res.status} ${t.slice(0, 120)}`);
  }
  const j = await res.json();

  return (j.hits || []).map((h) => {
    const v = h.videos || {};
    // 挑分辨率最高的那个
    const pick =
      v.large || v.medium || v.small || v.tiny || {};
    return {
      source: 'pixabay',
      id: String(h.id || ''),
      title: (h.tags || '').split(',')[0] || `pixabay_${h.id}`,
      duration: Number(h.duration) || 0,
      width: Number(pick.width) || 0,
      height: Number(pick.height) || 0,
      fps: 0,
      url: pick.url || '',
      previewUrl: (v.tiny && v.tiny.url) || '',
      thumb: (v.medium && v.medium.thumbnail) || '',
      vertical: false,
      tags: (h.tags || '').split(',').map((s) => s.trim()).filter(Boolean),
      license: 'Pixabay Content License（免费商用，无需署名）',
      pageUrl: h.pageURL || '',
    };
  }).filter((x) => x.url);
}

// ───────────────────── Pexels（需 key） ─────────────────────

async function searchPexels(keyword, opts) {
  const key = getKey('pexels');
  if (!key) {
    throw new Error(
      '没有 Pexels key。\n' +
      '     申请（免费）：https://www.pexels.com/api/\n' +
      '     存下来：node stock.mjs --set-key pexels <你的key>'
    );
  }
  const per = Math.min(80, Math.max(1, opts.perPage || 15));
  const url =
    `https://api.pexels.com/videos/search?query=${encodeURIComponent(keyword)}` +
    `&per_page=${per}&size=medium`;

  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Authorization: key, Accept: 'application/json' },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`Pexels HTTP ${res.status}`);
  const j = await res.json();

  return (j.videos || []).map((v) => {
    // files 里挑最高分辨率
    const files = (v.video_files || []).slice().sort((a, b) => (b.width || 0) - (a.width || 0));
    const best = files[0] || {};
    return {
      source: 'pexels',
      id: String(v.id || ''),
      title: `pexels_${v.id}`,
      duration: Number(v.duration) || 0,
      width: Number(best.width) || 0,
      height: Number(best.height) || 0,
      fps: Number(best.fps) || 0,
      url: best.link || '',
      previewUrl: '',
      thumb: v.image || '',
      vertical: (v.height || 0) > (v.width || 0),
      tags: [],
      license: 'Pexels License（免费商用，无需署名）',
      pageUrl: v.url || '',
    };
  }).filter((x) => x.url);
}

const SOURCES = {
  coverr: searchCoverr,
  pixabay: searchPixabay,
  pexels: searchPexels,
};

// ───────────────────── 下载 ─────────────────────

async function downloadClip(clip, outDir, opts) {
  const ext = (clip.url.match(/\.(\w+)(\?|$)/) || [])[1] || 'mp4';
  const base = safeName(`${clip.title}_${clip.source}_${clip.id}`, 80);
  const dest = path.join(outDir, `${base}.${ext}`);

  if (fs.existsSync(dest) && !opts.force) {
    // ⚠ 光看"文件存在"不够。
    //   下载被中断（Ctrl+C、管道被关、断网）会留下一个**残缺文件**，
    //   而"存在就跳过"会让它永远残缺 —— 用户下次跑看到"已存在"，
    //   结果剪进去才发现视频是坏的。实测踩过：一个 10 KB 的残缺 mp4
    //   被当成"已完成"，ffmpeg 报 Packet corrupt。
    //
    //   所以要校验：拿不到预期大小就按残缺处理，重下。
    try {
      const st = fs.statSync(dest);
      if (st.size < 1024) {
        // 太小，肯定是残缺
        fs.unlinkSync(dest);
      } else if (clip.sizeHint && st.size !== clip.sizeHint) {
        fs.unlinkSync(dest);
      }
    } catch {}
    if (fs.existsSync(dest)) return { skipped: true, dest };
  }

  // 走共享实现：带空闲检测（防"卡在最后一点"）+ 断点续传 + .part 保护。
  // 见 dev/dl.mjs 顶部说明。
  const r = await dlDownload(clip.url, dest, {
    quiet: opts.quiet,
    force: opts.force,
    onProgress: (got, total) => {
      if (total && !opts.quiet) {
        process.stderr.write(
          `\r      下载 ${((got / total) * 100).toFixed(0)}%  ${fmtSize(got)}/${fmtSize(total)}   `
        );
      }
    },
  });
  if (!opts.quiet) process.stderr.write('\n');
  return { dest, bytes: r.bytes };
}

/** 顺手把缩略图存下来 —— 剪辑选片时看缩略图比开文件快 */
async function saveThumb(clip, outDir, baseNoExt) {
  if (!clip.thumb) return null;
  try {
    const res = await fetch(clip.thumb, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = buf[0] === 0x89 ? 'png' : 'jpg';
    const p = path.join(outDir, `${baseNoExt}.thumb.${ext}`);
    await fsp.writeFile(p, buf);
    return p;
  } catch { return null; }
}

// ───────────────────── 主流程 ─────────────────────

async function runSearch(keywords, opts) {
  const sourceName = opts.source || 'coverr';
  const fn = SOURCES[sourceName];
  if (!fn) throw new Error(`未知素材源「${sourceName}」（支持：${Object.keys(SOURCES).join(', ')}）`);

  const perKw = Math.max(1, Math.ceil((opts.limit || 10) / Math.max(1, keywords.length)));
  let all = [];

  for (const kw of keywords) {
    log(`\n━━━ 搜索[${sourceName}]: ${kw}`);
    try {
      let items = await fn(kw, { ...opts, perPage: perKw * 2 });
      // 分辨率过滤
      if (opts.minHeight > 0) {
        const before = items.length;
        items = items.filter((x) => !x.height || x.height >= opts.minHeight);
        if (items.length < before) log(`  高度过滤 ${opts.minHeight}p：${before} → ${items.length}`);
      }
      if (opts.landscape) items = items.filter((x) => !x.vertical);
      if (opts.vertical) items = items.filter((x) => x.vertical);

      items = items.slice(0, perKw);
      log(`  找到 ${items.length} 条`);
      for (const it of items) {
        log(`    · ${it.title.slice(0, 42).padEnd(44)} ${String(it.height || '?')}p  ${fmtDur(it.duration)}  ${it.vertical ? '竖屏' : '横屏'}`);
      }
      all.push(...items);
    } catch (e) {
      warn(`  ✗ ${e.message}`);
    }
    await sleep(400);
  }

  if (!all.length) throw new Error('没有搜到任何素材');

  // 目录按关键词分
  const dirName = safeName(opts.scene || keywords[0], 50);
  const outDir = path.join(opts.out, dirName);
  await fsp.mkdir(outDir, { recursive: true });

  log(`\n━━━ 下载 ${all.length} 条 → ${outDir}`);

  let ok = 0, skip = 0, fail = 0, bytes = 0;
  const manifest = [];

  for (let i = 0; i < all.length; i++) {
    const it = all[i];
    log(`  [${i + 1}/${all.length}] ${it.title.slice(0, 50)}`);
    try {
      const r = await downloadClip(it, outDir, opts);
      if (r.skipped) {
        log(`      ⏭ 已存在`);
        skip++;
      } else {
        ok++;
        bytes += r.bytes;
        log(`      ✓ ${path.basename(r.dest)}  ${fmtSize(r.bytes)}`);
        // 缩略图 + 元数据，便于后续选片
        const baseNoExt = path.basename(r.dest, path.extname(r.dest));
        await saveThumb(it, outDir, baseNoExt);
        manifest.push({
          file: path.basename(r.dest),
          thumb: `${baseNoExt}.thumb.jpg`,
          title: it.title,
          source: it.source,
          width: it.width, height: it.height, fps: it.fps,
          duration: it.duration,
          license: it.license,
          pageUrl: it.pageUrl,
          tags: it.tags,
        });
      }
    } catch (e) {
      fail++;
      warn(`      ✗ ${e.message}`);
    }
    await sleep(opts.delay);
  }

  // 写清单：剪辑时要核对授权、要找原页
  if (manifest.length) {
    const mp = path.join(outDir, '_manifest.json');
    let old = [];
    try { old = JSON.parse(await fsp.readFile(mp, 'utf-8')); } catch {}
    const merged = [...old.filter((o) => !manifest.some((m) => m.file === o.file)), ...manifest];
    await fsp.writeFile(mp, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
    log(`\n  清单: ${mp}`);
  }

  // 授权说明：商用素材必须留痕
  const licPath = path.join(outDir, '授权说明.txt');
  if (!fs.existsSync(licPath)) {
    await fsp.writeFile(licPath, [
      '本目录素材来自免版权素材站，可免费商用（无需署名），但请遵守各站条款：',
      '',
      '· Coverr  https://coverr.co/license',
      '· Pixabay  https://pixabay.com/service/license-summary/',
      '· Pexels   https://www.pexels.com/license/',
      '',
      '通用限制（三家都一样的红线）：',
      '  ✗ 不能把素材原样转售、再分发到其他素材站',
      '  ✗ 不能用于诋毁、色情、违法内容',
      '  ✗ 不能暗示素材中的人物/品牌为你的产品背书',
      '  ✓ 可以用于视频、广告、网站、社交媒体（含商用）',
      '  ✓ 可以剪辑、调色、加特效',
      '',
      '建议：成片发布时保留本目录，便于日后核对授权。',
      '_manifest.json 里记录了每个文件的来源页和授权类型。',
      '',
    ].join('\n'), 'utf-8');
  }

  log(`\n━━━ 完成 ━━━`);
  log(`  成功 ${ok} 条（${fmtSize(bytes)}），跳过 ${skip}，失败 ${fail}`);
  log(`  目录: ${outDir}`);
  return { dir: outDir, ok, skip, fail, bytes };
}

// ───────────────────── CLI ─────────────────────

function parseArgs(argv) {
  const opts = {
    out: OUT_DEFAULT,
    limit: 10,
    minHeight: 0,
    source: 'coverr',
    force: false,
    quiet: false,
    delay: 600,
  };
  const positional = [];
  let setKey = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-o': case '--out': opts.out = argv[++i]; break;
      case '-n': case '--limit': opts.limit = Number(argv[++i]) || 10; break;
      case '--min-height': opts.minHeight = Number(argv[++i]) || 0; break;
      case '--source': opts.source = argv[++i]; break;
      case '--scene': opts.scene = argv[++i]; break;
      case '--landscape': opts.landscape = true; break;
      case '--vertical': opts.vertical = true; break;
      case '--force': opts.force = true; break;
      case '--quiet': opts.quiet = true; break;
      case '--delay': opts.delay = Math.max(0, Number(argv[++i]) || 600); break;
      case '--set-key': setKey = { name: argv[++i], value: argv[++i] }; break;
      case '-h': case '--help': opts.help = true; break;
      default:
        if (!a.startsWith('-')) positional.push(a);
    }
  }
  return { opts, positional, setKey };
}

function printHelp() {
  console.log(`
免版权素材下载（B-roll，可商用）

用法:
  node stock.mjs <关键词> [更多...] [选项]
  node stock.mjs --scene <场景> [选项]

选项:
  -o, --out <dir>      输出目录（默认 ~/Downloads/素材）
  -n, --limit <n>      总共下多少条（默认 10）
  --min-height <px>    只要这个高度以上（如 1080）
  --landscape          只要横屏
  --vertical           只要竖屏
  --source <name>      素材源：coverr(默认) | pixabay | pexels
  --scene <场景>       按场景搜（见下方场景列表）
  --force              已存在的也重下
  --delay <ms>         每条间隔（默认 600）
  --set-key <源> <key> 保存 API key（pixabay / pexels）
  --list               列出所有场景
  -h, --help           帮助

素材源:
  ✅ Coverr   **无需 key**，直接能用（默认）
  ⚠️ Pixabay  需免费 key  https://pixabay.com/api/docs/
  ⚠️ Pexels   需免费 key  https://www.pexels.com/api/

  没有 key 也能用 Coverr。要用另两家就：
    node stock.mjs --set-key pixabay 你的key
  key 存在 %APPDATA%\\UnifiedDownloader\\stock-keys.json，
  下次自动读，不用重复贴。

内置场景（--scene）:
${Object.keys(SCENES).map((k) => '  ' + k).join('\n')}

输出:
  视频 + 缩略图（.thumb.jpg）+ _manifest.json（来源/授权/分辨率）
  + 授权说明.txt

示例:
  node stock.mjs --scene 城市夜景 -n 8
  node stock.mjs nature -n 5 --min-height 1080
  node stock.mjs "office" "cafe" --landscape -o D:\\broll
`);
}

async function main() {
  const { opts, positional, setKey } = parseArgs(process.argv.slice(2));

  // 存 key
  if (setKey && setKey.name && setKey.value) {
    if (!SOURCES[setKey.name]) {
      throw new Error(`未知素材源「${setKey.name}」（支持：${Object.keys(SOURCES).join(', ')}）`);
    }
    const k = loadKeys();
    k[setKey.name] = setKey.value.trim();
    const p = saveKeys(k);
    log(`✓ 已保存 ${setKey.name} key → ${p}`);
    log(`  测试一下：node stock.mjs nature -n 1 --source ${setKey.name}`);
    return;
  }

  if (opts.list) {
    log('内置场景：');
    for (const [k, v] of Object.entries(SCENES)) {
      log(`  ${k.padEnd(8)} → ${v.join(' / ')}`);
    }
    return;
  }

  if (opts.help || (!positional.length && !opts.scene)) {
    printHelp();
    process.exit(opts.help ? 0 : 1);
  }

  // 关键词：场景优先，否则用位置参数（多行也支持）
  let keywords = [];
  if (opts.scene) {
    keywords = resolveKeyword(null, opts);
  } else {
    for (const p of positional) {
      for (const w of String(p).split(/[\n,，;；]+/)) {
        const t = w.trim();
        if (t && !keywords.includes(t)) keywords.push(t);
      }
    }
  }
  if (!keywords.length) { printHelp(); process.exit(1); }

  await runSearch(keywords, opts);
}

// ───────────────────── 入口 ─────────────────────
export async function run() {
  assertFeature('stock');
  await main();
}

function isDirectRun() {
  try {
    const entry = process.argv[1] || '';
    return /stock(\.mjs)?$/i.test(entry) || entry === '';
  } catch { return false; }
}

if (isDirectRun()) {
  main().catch((e) => {
    console.error('\n[致命]', e.message);
    process.exit(1);
  });
}
