#!/usr/bin/env node
/**
 * novel-dl.mjs — 笔趣阁系小说下载
 *
 * 定位：
 *   面向「零反爬」的笔趣阁镜像站。不做字体解密，只处理纯 HTML 页面。
 *   番茄那种字体混淆站点不在这里处理（需要 OCR，另算）。
 *
 * 已验证的站点（2026-10-26 实测）：
 *   biquge365.net
 *     · 书籍页   /book/{bookId}/           → 最新章节（只有 20 条左右）
 *     · 全目录   /newbook/{bookId}/        → 全部章节 ★ 关键入口
 *     · 章节页   /chapter/{bookId}/{cid}.html
 *     · 正文容器 <div id="txt">
 *     · 无字体混淆、无验证码、无签名
 *
 * 用法：
 *   node novel-dl.mjs <书籍URL>
 *   node novel-dl.mjs <书籍URL> -o D:\novels
 *   node novel-dl.mjs <书籍URL> --from 10 --to 20
 *   node novel-dl.mjs <书籍URL> --list          只列章节，不下载
 *   node novel-dl.mjs <书籍URL> --delay 800     每章间隔（默认 600ms）
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { assertFeature } from '../dev/gate.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const OUT_DEFAULT = path.join(os.homedir(), 'Downloads', '小说');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const warn = (...a) => console.error('[warn]', ...a);

// ───────────────────── 站点适配 ─────────────────────
/**
 * 站点配置。新增站点只需要在这里加一条。
 * 目前只验证了 biquge365，其它镜像站结构类似，可按需扩展。
 */
const SITES = [
  {
    name: 'biquge365',
    hosts: ['biquge365.net', 'www.biquge365.net'],
    bookIdFrom: /\/(?:book|newbook)\/(\d+)\/?/,
    catalog: (id) => `https://www.biquge365.net/newbook/${id}/`,
    chapterHref: /^\/chapter\/(\d+)\/(\d+)\.html$/,
    contentSelector: /<div[^>]*id="txt"[^>]*>([\s\S]*?)<\/div>/i,
    titleSelector: /<h1[^>]*>([\s\S]*?)<\/h1>/i,
  },
];

function matchSite(url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  return SITES.find((s) => s.hosts.some((h) => host === h || host.endsWith('.' + h))) || null;
}

// ───────────────────── 网络 ─────────────────────
/**
 * 取页面文本。
 *
 * ⚠ 为什么不用 fetch / https：
 *   实测该站点对 Node 的 TLS 指纹做了降速处理 ——
 *   curl 单章 1.7 秒，Node fetch 连续请求到第 8 次后开始挂起，
 *   Node https 更是第 1 次就超时 22 秒。
 *   改用系统 curl 子进程，稳定在 1~2 秒/章。
 *
 * Windows 10 1803+ 自带 curl.exe，无需额外安装。
 */
function haveCurl() {
  try {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['curl'], {
      encoding: 'utf-8', windowsHide: true, timeout: 5000,
    });
    return r.status === 0 && String(r.stdout || '').trim().length > 0;
  } catch { return false; }
}

const CURL_OK = haveCurl();

/**
 * fetch 回退。
 *
 * 交接文档坑 19 明确写了：该站点对 Node 的 TLS ClientHello 指纹降速，
 * 连续请求到第 8 次后开始挂起，`Node https` 更是一次都拿不到。
 * 所以 curl 是**首选**，但 v1.0.0 的问题是没有回退 ——
 * 一旦 `where curl` 失败（精简系统、被安全软件拦、PATH 被裁），
 * 所有请求都走 curlGet 直接 spawn 失败，用户看到的是满屏
 * "spawn curl ENOENT"，而不是"请安装 curl"或"降级能跑但慢"。
 *
 * 这里补上回退：curl 不可用 → 用 fetch（会慢，但至少能跑），
 * 并且只提示一次，不刷屏。
 */
let _fallbackWarned = false;

async function fetchGet(url, referer, timeoutMs) {
  if (!_fallbackWarned) {
    _fallbackWarned = true;
    warn('  未找到 curl，改用内置 HTTP（可能被站点降速，整本下载会更慢）');
  }
  const headers = {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Connection: 'close',
  };
  if (referer) headers.Referer = referer;

  const res = await fetch(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 200) throw new Error(`响应过短 (${buf.length}B)`);
  return buf;
}

/** 统一入口：有 curl 用 curl，没有就降级 */
function httpGet(url, referer, timeoutMs) {
  return CURL_OK ? curlGet(url, referer, timeoutMs) : fetchGet(url, referer, timeoutMs);
}

function curlGet(url, referer, timeoutMs) {
  return new Promise((resolve, reject) => {
    const args = [
      '-sS',                         // 静默但显示错误
      '-L',                          // 跟随重定向
      '--max-time', String(Math.ceil(timeoutMs / 1000)),
      '--connect-timeout', '15',
      '-A', UA,
      '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      '-H', 'Accept-Language: zh-CN,zh;q=0.9',
      '-H', 'Connection: close',
    ];
    if (referer) args.push('-H', 'Referer: ' + referer);
    args.push(url);

    const p = spawn('curl', args, { windowsHide: true });
    const out = [];
    const err = [];
    p.stdout.on('data', (c) => out.push(c));
    p.stderr.on('data', (c) => err.push(c));
    const timer = setTimeout(() => { try { p.kill(); } catch {} }, timeoutMs + 3000);
    timer.unref?.();

    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const msg = Buffer.concat(err).toString('utf8').trim().slice(0, 200);
        return reject(new Error(`curl exit ${code}${msg ? ': ' + msg : ''}`));
      }
      const buf = Buffer.concat(out);
      if (buf.length < 200) return reject(new Error(`响应过短 (${buf.length}B)`));
      resolve(buf);
    });
  });
}

async function fetchText(url, { retries = 4, timeout = 45000 } = {}) {
  const origin = (() => { try { return new URL(url).origin + '/'; } catch { return undefined; } })();
  let lastErr;

  for (let i = 0; i <= retries; i++) {
    try {
      const buf = await httpGet(url, origin, timeout);

      let text = buf.toString('utf8');
      if ((text.match(/\uFFFD/g) || []).length > 20) {
        try { text = new TextDecoder('gbk').decode(buf); } catch {}
      }

      // 被拦截的特征（返回 200 但内容是提示页）
      if (/访问过于频繁|请稍后再试|系统检测到|安全验证/.test(text) && text.length < 3000) {
        throw new Error('被站点拦截（内容为提示页）');
      }

      return text;
    } catch (e) {
      lastErr = e;
      if (i < retries) {
        const wait = Math.min(10000, 1000 * Math.pow(2, i)) + Math.random() * 700;
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}

// ───────────────────── 解析 ─────────────────────
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** 从书籍 URL 取 bookId */
function parseBookId(site, url) {
  const m = String(url).match(site.bookIdFrom);
  return m ? m[1] : null;
}

/** 解析全目录页，返回 [{ index, cid, title, url }] */
function parseCatalog(site, html, baseUrl) {
  const items = [];
  const seen = new Set();

  // 匹配 <a href="/chapter/{bookId}/{cid}.html">标题</a>
  const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    const title = clean(m[2].replace(/<[^>]+>/g, ''));

    const cm = href.match(site.chapterHref);
    if (!cm) continue;

    const cid = cm[2];
    if (seen.has(cid)) continue;
    // 跳过「开始阅读」这类导航链接
    if (!title || /^(开始阅读|最新章节|加入书架|推荐|章节目录|目录)$/.test(title)) continue;
    // 章节标题应该带「第…章」或者至少有些长度
    if (title.length < 2) continue;

    seen.add(cid);
    items.push({
      index: items.length + 1,
      cid,
      title,
      url: new URL(href, baseUrl).toString(),
    });
  }

  return items;
}

/** 从章节页提取标题与正文 */
function parseChapter(site, html) {
  const titleM = html.match(site.titleSelector);
  const title = titleM ? clean(titleM[1].replace(/<[^>]+>/g, '')) : '';

  const contentM = html.match(site.contentSelector);
  if (!contentM) return { title, text: '', ok: false };

  let raw = contentM[1];

  // 去掉 <script>/<style>
  raw = raw.replace(/<script[\s\S]*?<\/script>/gi, '');
  raw = raw.replace(/<style[\s\S]*?<\/style>/gi, '');

  // <br> → 换行
  raw = raw.replace(/<br\s*\/?>/gi, '\n');
  raw = raw.replace(/<\/p>/gi, '\n');

  // 去所有标签
  raw = raw.replace(/<[^>]+>/g, '');

  // HTML 实体
  raw = raw
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&ldquo;/gi, '"')
    .replace(/&rdquo;/gi, '"')
    .replace(/&hellip;/gi, '…');

  // 按行处理
  const lines = raw.split('\n').map((l) => l.replace(/\u00a0/g, ' ').trim());

  const out = [];
  for (let line of lines) {
    if (!line) continue;

    // 去广告：常见站点署名
    if (/一秒记住|更新快|无弹窗|笔趣阁|biquge/i.test(line) && line.length < 60) continue;
    if (/^第\d+\/\d+页$/.test(line)) continue;
    if (/手机版|电脑版|请收藏|最新章节/.test(line) && line.length < 40) continue;

    // 去掉开头混进来的章节标题行（(第x/y页) 残留）
    line = line.replace(/\(第\d+\/\d+页\)/g, '').trim();
    if (!line) continue;

    out.push(line);
  }

  // 正文首行常重复一遍章节标题（页面上是 h1 + 正文首行都有），去掉重复
  const titleNorm = (x) => String(x || '').replace(/\s+/g, '');
  if (out.length && titleNorm(out[0]) === titleNorm(title)) {
    out.shift();
  }
  // 首行如果是「第x章标题」（无空格分隔），也去掉
  if (out.length && /^第[0-9一二三四五六七八九十百千]+章/.test(out[0]) && out[0].length < 40) {
    const first = out[0];
    if (titleNorm(first).startsWith(titleNorm(title).slice(0, 6)) || titleNorm(title).includes(titleNorm(first).slice(0, 6))) {
      out.shift();
    }
  }

  return { title, text: out.join('\n'), ok: out.length > 0 };
}

// ───────────────────── 文件名 ─────────────────────
function safeName(s, max = 100) {
  return String(s || 'novel')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, max);
}

function pad(n, w = 4) {
  return String(n).padStart(w, '0');
}

// ───────────────────── 主流程 ─────────────────────
async function downloadBook(bookUrl, opts) {
  const site = matchSite(bookUrl);
  if (!site) throw new Error('不支持的站点：' + bookUrl + '\n目前支持：' + SITES.map(s => s.name).join(', '));

  const bookId = parseBookId(site, bookUrl);
  if (!bookId) throw new Error('无法从 URL 解析书籍 ID：' + bookUrl);

  log(`站点: ${site.name}   书籍ID: ${bookId}`);

  // 1. 取目录
  const catalogUrl = site.catalog(bookId);
  log(`取目录: ${catalogUrl}`);
  const catHtml = await fetchText(catalogUrl);
  let chapters = parseCatalog(site, catHtml, catalogUrl);

  if (!chapters.length) throw new Error('目录解析为空，站点结构可能变了');

  // 按章节号排序（目录页通常是倒序）
  chapters = sortChapters(chapters);

  log(`共 ${chapters.length} 章`);

  // 2. 区间过滤
  const from = opts.from || 1;
  const to = opts.to || chapters.length;
  const picked = chapters.filter((c) => c.index >= from && c.index <= to);
  log(`下载区间: ${from} ~ ${to}（${picked.length} 章）`);

  if (opts.listOnly) {
    console.log('');
    for (const c of picked) console.log(`  ${pad(c.index)}  ${c.title}`);
    console.log('');
    return { chapters: picked.length, ok: 0, fail: 0, files: [] };
  }

  // 3. 逐章下载
  const bookTitle = opts.title || guessBookTitle(catHtml, bookUrl);
  const bookDir = path.join(opts.out, safeName(bookTitle, 80));
  await fsp.mkdir(bookDir, { recursive: true });
  log(`输出目录: ${bookDir}`);
  log('');

  let ok = 0, fail = 0, consecutiveFail = 0;
  const files = [];
  const mergedParts = [];

  for (let i = 0; i < picked.length; i++) {
    const c = picked[i];
    const tag = `[${i + 1}/${picked.length}] ${c.title}`;
    try {
      const html = await fetchText(c.url);
      const parsed = parseChapter(site, html);

      if (!parsed.ok) {
        fail++;
        consecutiveFail++;
        warn(`${tag}  ✗ 正文为空`);
        if (consecutiveFail >= 8) {
          warn(`\n连续 ${consecutiveFail} 章失败，可能被限流，暂停 30 秒后继续...`);
          await sleep(30000);
          consecutiveFail = 0;
        }
        continue;
      }

      const fname = `${pad(c.index)}_${safeName(parsed.title || c.title, 60)}.txt`;
      const fpath = path.join(bookDir, fname);
      const body = `${parsed.title || c.title}\n\n${parsed.text}\n`;
      await fsp.writeFile(fpath, body, 'utf8');

      mergedParts.push(`${parsed.title || c.title}\n\n${parsed.text}`);
      files.push(fpath);
      ok++;
      consecutiveFail = 0;   // 成功就重置熔断计数

      const kb = (Buffer.byteLength(body, 'utf8') / 1024).toFixed(1);
      process.stderr.write(`\r  ${i + 1}/${picked.length}  ${parsed.title.slice(0, 30)}  ${kb}KB   `);
    } catch (e) {
      fail++;
      consecutiveFail++;
      warn(`\n${tag}  ✗ ${e.message}`);
      if (consecutiveFail >= 8) {
        warn(`连续 ${consecutiveFail} 章失败，暂停 30 秒...`);
        await sleep(30000);
        consecutiveFail = 0;
      }
    }

    if (i < picked.length - 1) await sleep(opts.delay);
  }
  if (picked.length) process.stderr.write('\n');

  // 4. 合并整本
  if (mergedParts.length > 1) {
    const mergedPath = path.join(opts.out, `${safeName(bookTitle, 80)}.txt`);
    const head = `${bookTitle}\n${'='.repeat(40)}\n\n`;
    await fsp.writeFile(mergedPath, head + mergedParts.join('\n\n\n'), 'utf8');
    const mb = (fs.statSync(mergedPath).size / 1024 / 1024).toFixed(2);
    log(`\n合并文件: ${mergedPath}  (${mb} MB)`);
    files.push(mergedPath);
  }

  return { chapters: picked.length, ok, fail, files, bookDir, bookTitle };
}

/** 目录页一般倒序，按标题里的章节号排正序 */
function sortChapters(chapters) {
  const cnNum = (s) => {
    // 提取「第xxx章」里的数字，支持阿拉伯数字和中文数字
    const m = String(s).match(/第([0-9]+|[零一二三四五六七八九十百千万]+)章/);
    if (!m) return null;
    const v = m[1];
    if (/^\d+$/.test(v)) return parseInt(v, 10);
    return cnToNum(v);
  };

  const cnToNum = (cn) => {
    const map = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    const unit = { 十: 10, 百: 100, 千: 1000, 万: 10000 };
    let total = 0, section = 0, num = 0;
    for (const ch of cn) {
      if (map[ch] !== undefined) {
        num = map[ch];
      } else if (unit[ch]) {
        const u = unit[ch];
        if (u === 10000) {
          section = (section + num) * u;
          total += section;
          section = 0;
        } else {
          section += (num || 1) * u;
        }
        num = 0;
      }
    }
    return total + section + num;
  };

  const withNum = chapters.map((c) => ({ ...c, num: cnNum(c.title) }));
  const anyNum = withNum.some((c) => c.num !== null);

  if (!anyNum) return chapters;

  // 有数字的按数字排，没数字的排最后（保持原序）
  withNum.sort((a, b) => {
    if (a.num === null && b.num === null) return 0;
    if (a.num === null) return 1;
    if (b.num === null) return -1;
    return a.num - b.num;
  });

  return withNum.map((c, i) => ({ ...c, index: i + 1 }));
}

/** 从目录页 <title> 猜书名 */
function guessBookTitle(html, url) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (m) {
    let t = clean(m[1].replace(/<[^>]+>/g, ''));
    // 常见格式：「书名小说_作者_新笔趣阁_书名最新章节_笔趣阁」
    t = t.split(/[_|]/)[0].trim();

    // 反复剥掉各种后缀（可能叠加，比如「...最新章节列表」）
    const SUFFIX = /(最新章节列表|最新章节|全文阅读|无弹窗|免费阅读|小说|列表)$/;
    for (let i = 0; i < 5 && SUFFIX.test(t); i++) {
      t = t.replace(SUFFIX, '').trim();
    }
    if (t) return t;
  }
  return 'novel_' + (url.match(/\d+/) || ['x'])[0];
}

// ───────────────────── CLI ─────────────────────
function parseArgs(argv) {
  const opts = {
    out: OUT_DEFAULT,
    from: 0,
    to: 0,
    delay: 800,
    listOnly: false,
    title: '',
  };
  const urls = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-o': case '--out': opts.out = argv[++i]; break;
      case '--from': opts.from = Math.max(0, parseInt(argv[++i], 10) || 0); break;
      case '--to': opts.to = Math.max(0, parseInt(argv[++i], 10) || 0); break;
      case '--delay': opts.delay = Math.max(0, parseInt(argv[++i], 10) || 0); break;
      case '--list': opts.listOnly = true; break;
      case '--title': opts.title = argv[++i] || ''; break;
      case '-h': case '--help': opts.help = true; break;
      default:
        if (!a.startsWith('-')) urls.push(a);
    }
  }
  return { opts, urls };
}

function printHelp() {
  console.log(`
用法:
  node novel-dl.mjs <书籍URL> [选项]

选项:
  -o, --out <dir>     输出目录（默认 ~/Downloads/小说）
  --from <n>          从第 n 章开始（默认 1）
  --to <n>            到第 n 章结束（默认全部）
  --delay <ms>        每章间隔毫秒（默认 800，别设太小）
  --list              只列出章节，不下载
  --title <name>      手动指定书名
  -h, --help          帮助

示例:
  node novel-dl.mjs "https://www.biquge365.net/book/004552/"
  node novel-dl.mjs "https://www.biquge365.net/book/004552/" --list
  node novel-dl.mjs "https://www.biquge365.net/book/004552/" --from 1 --to 20 -o D:\\novels

支持的站点:
${SITES.map((s) => '  · ' + s.name + '  (' + s.hosts[0] + ')').join('\n')}

说明:
  仅用于抓取公开可访问的免费章节，供个人学习、备份、离线阅读。
  不支持付费章节 / VIP 内容。
`);
}

async function main() {
  const { opts, urls } = parseArgs(process.argv.slice(2));
  if (opts.help || !urls.length) { printHelp(); process.exit(opts.help ? 0 : 1); }

  await fsp.mkdir(opts.out, { recursive: true });

  for (const url of urls) {
    log('');
    log('══════════════════════════════════════');
    log(url);
    log('══════════════════════════════════════');
    try {
      const r = await downloadBook(url, opts);
      log('');
      log(`✓ 完成：${r.bookTitle || ''}   成功 ${r.ok} 章${r.fail ? `，失败 ${r.fail} 章` : ''}`);
    } catch (e) {
      warn(`✗ 失败：${e.message}`);
      process.exitCode = 1;
    }
  }
}

export async function run() {
  // 功能闸门：**每个引擎自己验**，不信任上游 cli 的那一个 if。
  // 改 cli.mjs 里的 if (!activated) 只能骗过 cli，到这里照样被拦。
  assertFeature('novel');
  await main();
}

const isDirect = (() => {
  try {
    return process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
  } catch { return false; }
})();

if (isDirect) {
  main().catch((e) => {
    console.error('[致命]', e.message);
    process.exit(1);
  });
}
