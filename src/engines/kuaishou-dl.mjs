/**
 * kuaishou-dl.mjs — 快手视频 / 图文下载
 *
 * ═══════════════════════════════════════════════════════════════
 * ⚠️ 状态：**未在真实链接上端到端验证过**（2026-10-29）
 * ═══════════════════════════════════════════════════════════════
 *
 * 为什么没验证完 —— 必须写清楚，别让接手的人以为它"已跑通"：
 *
 *   1. 快手首页/搜索页**强制登录**
 *      www.kuaishou.com/new-reco 渲染完只有 724 字，全是"登录即可享受…"
 *      搜索页同样：bodyLen=467，videoHrefs=[] —— 不登录就是空白壳。
 *
 *   2. 无登录的 H5 分享域 v.m.chenzhongtech.com 需要**真实 photoId**
 *      我用占位 id 请求，页面直接返回「参数格式错误，请仔细阅读API文档」。
 *      没有真实分享链接就没法往下验（不能凭空编一个有效 id）。
 *
 *   3. 页面挂了 `ksCdnProtector` / `$ksCdnWebProtector` 签名层
 *      CDN 请求要带签名参数，不能像抖音那样直接拿 play_addr 就下。
 *
 * 所以这个模块做的是「**结构上正确**」的实现：
 *   · 短链展开（v.kuaishou.com → 真实 photoId）
 *   · H5 分享页 SSR 数据解析
 *   · GraphQL 接口兜底
 *   · 登录态复用（--profile / --headful）
 *
 * 有真实链接时**大概率能跑**，但没经过验证就是没验证过。
 * 第一次用请加 --headful 看着跑，确认链路通了再进批处理。
 *
 * ═══════════════════════════════════════════════════════════════
 * 快手链接形态
 * ═══════════════════════════════════════════════════════════════
 *
 *   短链   https://v.kuaishou.com/xxxxx          需 302 展开
 *   网页   https://www.kuaishou.com/short-video/<photoId>
 *   分享页 https://v.m.chenzhongtech.com/fw/photo/<photoId>
 *   图文   https://www.kuaishou.com/short-video/<photoId>（图集，多张图）
 *
 * ═══════════════════════════════════════════════════════════════
 * 用法
 * ═══════════════════════════════════════════════════════════════
 *
 *   node kuaishou-dl.mjs <链接> [更多...]
 *   node kuaishou-dl.mjs <链接> --headful          首次建议（能看进度/过验证）
 *   node kuaishou-dl.mjs <链接> --profile          复用登录态（需先 --headful 登录一次）
 *   node kuaishou-dl.mjs <链接> -o D:\ks
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { findBrowser, browserHelpText } from '../dev/browser.mjs';
import { assertFeature } from '../dev/gate.mjs';
import { pickPort } from '../dev/port.mjs';

import { downloadFile as dlDownload } from '../dev/dl.mjs';
const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const OUT_DEFAULT = path.join(os.homedir(), 'Downloads', '快手');

const log = (...a) => console.log(...a);
const warn = (...a) => console.error('[warn]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────── 工具 ─────────────────────

function safeName(s, max = 80) {
  return String(s || 'kuaishou')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim()
    .slice(0, max) || 'kuaishou';
}

function fmtSize(b) {
  if (!b) return '-';
  if (b > 1024 ** 3) return (b / 1024 ** 3).toFixed(2) + ' GB';
  if (b > 1024 ** 2) return (b / 1024 ** 2).toFixed(2) + ' MB';
  return (b / 1024).toFixed(0) + ' KB';
}

/**
 * 从各种快手链接里抠 photoId。
 *
 * ⚠ 短链（v.kuaishou.com/xxx）里没有 id，必须 302 展开才知道。
 *   这里只处理能直接看出来的形态；短链走 expandShortLink()。
 */
function parsePhotoId(raw) {
  const s = String(raw || '').trim();

  // www.kuaishou.com/short-video/<id>
  let m = s.match(/kuaishou\.com\/short-video\/([A-Za-z0-9_-]+)/);
  if (m) return { id: m[1], kind: 'short-video' };

  // v.m.chenzhongtech.com/fw/photo/<id>
  m = s.match(/chenzhongtech\.com\/fw\/photo\/([A-Za-z0-9_-]+)/);
  if (m) return { id: m[1], kind: 'photo' };

  // www.kuaishou.com/fw/photo/<id>
  m = s.match(/kuaishou\.com\/fw\/photo\/([A-Za-z0-9_-]+)/);
  if (m) return { id: m[1], kind: 'photo' };

  // 纯 id（长这样：3xf8enb8dbj6uig）
  if (/^[A-Za-z0-9_-]{8,}$/.test(s) && !s.includes('.')) return { id: s, kind: 'id' };

  return null;
}

/** 短链展开：跟 302 拿最终 URL */
async function expandShortLink(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA_DESKTOP },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });
  return res.url || url;
}

function extractUrls(text) {
  const out = [];
  const re = /https?:\/\/[^\s"'<>，。、；）)]+/g;
  for (const m of String(text).matchAll(re)) {
    const u = m[0].replace(/[.,;)\]]+$/, '');
    if (/kuaishou\.com|chenzhongtech\.com/.test(u)) out.push(u);
  }
  return out;
}

// ───────────────────── 极简 CDP ─────────────────────

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (timer) clearTimeout(timer);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      // 20 秒超时 + unref：不加的话 CDP 卡住会挂住整个进程（坑 0 的老毛病）
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 超时: ${method}`));
      }, 20000);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

async function evaluate(cdp, sessionId, expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  }, sessionId);
  if (r.exceptionDetails) {
    throw new Error('页面求值异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result?.value;
}

async function launchChrome(opts) {
  // ⚠ findBrowser() 返回的是对象 { ok, path, name, from }，**不是字符串**。
  //   直接当路径用会得到：
  //     TypeError: The "file" argument must be of type string.
  //     Received an instance of Object
  //   这个报错完全不提浏览器，看起来像别处的错（实测踩到，白查了一轮）。
  const exe = opts.chromePath || (() => {
    const r = findBrowser();
    if (!r || !r.ok) return null;
    return r.path;
  })();
  if (!exe) throw new Error('找不到 Chrome/Edge\n' + browserHelpText());

  const port = await pickPort(opts.port || 9511, warn);
  const profileDir = opts.profile
    ? path.join(os.homedir(), '.kuaishou-profile')
    : await fsp.mkdtemp(path.join(os.tmpdir(), 'ks-'));

  if (opts.profile) await fsp.mkdir(profileDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--mute-audio',
    '--disable-blink-features=AutomationControlled',
    '--lang=zh-CN',
    'about:blank',
  ];
  if (!opts.headful) args.unshift('--headless=new');

  const proc = spawn(exe, args, { stdio: 'ignore', windowsHide: !opts.headful });

  let wsUrl = null;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      const j = await r.json();
      wsUrl = j.webSocketDebuggerUrl;
      if (wsUrl) break;
    } catch {}
    await sleep(200);
  }
  if (!wsUrl) {
    try { proc.kill(); } catch {}
    throw new Error(`Chrome 调试端口未就绪（port=${port}）`);
  }

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true });
  });

  return { proc, cdp: new CDP(ws), profileDir, exe, port };
}

async function newPage(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  if (url) {
    await cdp.send('Page.navigate', { url }, sessionId);
  }
  return { targetId, sessionId };
}

// ───────────────────── 页面内提取 ─────────────────────

/**
 * 页面内脚本：从快手页面抓视频/图集信息。
 *
 * 快手的数据藏在几个地方，按可靠性排序：
 *   1. window.__APOLLO_STATE__     （GraphQL 缓存，最全）
 *   2. <video> 标签的 src           （渲染后一定有）
 *   3. 页面里的 JSON-LD
 *
 * ⚠ 模板字符串里所有反斜杠都要双写（见知乎专栏那个坑）。
 */
function extractScript() {
  return `(() => {
    const out = { videos: [], images: [], title: '', author: '', caption: '', src: null };

    // 标题/文案
    const t = document.querySelector('meta[property="og:title"]');
    if (t) out.title = t.content || '';
    const d = document.querySelector('meta[property="og:description"]');
    if (d) out.caption = d.content || '';
    if (!out.title) out.title = document.title || '';

    // 视频：<video> 标签
    for (const v of document.querySelectorAll('video')) {
      const src = v.src || (v.querySelector('source') && v.querySelector('source').src) || '';
      if (src && src.startsWith('http')) out.videos.push(src);
      if (v.poster && v.poster.startsWith('http')) out.images.push(v.poster);
    }

    // 图集：作品图片
    for (const img of document.querySelectorAll('img')) {
      const src = img.src || img.getAttribute('data-src') || '';
      if (!src.startsWith('http')) continue;
      // 排掉头像、图标
      if (/avatar|icon|logo|emoticon/i.test(src)) continue;
      if (img.naturalWidth && img.naturalWidth < 200) continue;
      if (!out.images.includes(src)) out.images.push(src);
    }

    // Apollo 缓存：从里面挖 photo 数据
    try {
      const st = window.__APOLLO_STATE__;
      if (st && typeof st === 'object') {
        const walk = (obj, depth) => {
          if (!obj || depth > 6 || typeof obj !== 'object') return;
          for (const [k, val] of Object.entries(obj)) {
            if (typeof val === 'string') {
              if (/^https?:\\/\\/.+\\.(mp4|m3u8)/i.test(val) && !out.videos.includes(val)) out.videos.push(val);
              if (/^https?:\\/\\/.+\\.(jpg|jpeg|png|webp)/i.test(val) && !out.images.includes(val)) out.images.push(val);
              if (k === 'caption' && val.length > (out.caption || '').length) out.caption = val;
              if ((k === 'userName' || k === 'name') && !out.author) out.author = val;
            } else if (typeof val === 'object') {
              walk(val, depth + 1);
            }
          }
        };
        walk(st, 0);
      }
    } catch (e) {}

    out.bodyLen = document.body ? document.body.innerText.length : 0;
    out.bodyHead = document.body ? document.body.innerText.slice(0, 200) : '';
    out.url = location.href;
    return out;
  })()`;
}

// ───────────────────── 下载 ─────────────────────

async function downloadFile(url, dest, referer) {
  // 走共享实现（带空闲检测 + 断点续传），见 dev/dl.mjs
  return await dlDownload(url, dest, { referer });
}

// ───────────────────── 单条处理 ─────────────────────

async function handleOne(rawUrl, opts, ctx) {
  log(`\n━━━ ${rawUrl}`);

  let url = rawUrl;
  // 短链先展开
  if (/v\.kuaishou\.com/.test(url) && !parsePhotoId(url)) {
    log('  展开短链…');
    url = await expandShortLink(url);
    log(`  → ${url.slice(0, 100)}`);
  }

  const info = parsePhotoId(url);
  if (!info) throw new Error('认不出快手视频 ID（链接形态不对）');
  log(`  photoId: ${info.id}`);

  const pageUrl = `https://www.kuaishou.com/short-video/${info.id}`;
  const { sessionId } = await newPage(ctx.cdp, pageUrl);
  await sleep(opts.waitMs);

  let data = null;
  for (let i = 0; i < 3; i++) {
    try {
      data = await evaluate(ctx.cdp, sessionId, extractScript());
      if (data && (data.videos.length || data.images.length)) break;
      // 有"登录"字样 = 被拦，给出可操作提示
      if (data && /登录/.test(data.bodyHead || '') && data.bodyLen < 600) {
        log(`  第 ${i + 1} 轮: 页面要求登录`);
        if (opts.headful && i === 0) {
          log('  窗口已打开，请手动登录（等待 30 秒）…');
          await sleep(30000);
        } else {
          await sleep(4000 + i * 3000);
        }
      } else {
        await sleep(3000 + i * 2000);
      }
    } catch (e) {
      warn(`  第 ${i + 1} 轮失败: ${e.message}`);
      await sleep(2000);
    }
  }

  if (!data) throw new Error('页面数据提取失败');

  if (!data.videos.length && !data.images.length) {
    const hint = /登录/.test(data.bodyHead || '')
      ? '页面要求登录。请加 --headful --profile，在弹出的窗口里登录一次（会存下来）。'
      : /参数格式错误/.test(data.bodyHead || '')
        ? 'photoId 无效（这个链接可能已删除，或不是完整链接）。'
        : '页面上没找到视频/图片。可能：链接失效、作品私密、或需要登录。';
    throw new Error(`没抓到内容\n     ${hint}\n     页面提示: ${(data.bodyHead || '').slice(0, 80)}`);
  }

  const base = safeName(data.title || data.caption || `kuaishou_${info.id}`, 70);
  await fsp.mkdir(opts.out, { recursive: true });

  const files = [];

  // 视频
  for (let i = 0; i < data.videos.length; i++) {
    const vurl = data.videos[i];
    const suffix = data.videos.length > 1 ? `_${i + 1}` : '';
    const dest = path.join(opts.out, `${base}${suffix}.mp4`);
    log(`  下载视频 ${i + 1}/${data.videos.length}…`);
    try {
      const r = await downloadFile(vurl, dest, pageUrl);
      log(`  ✓ ${path.basename(dest)}  ${fmtSize(r.bytes)}`);
      files.push(dest);
    } catch (e) {
      warn(`  ✗ 视频下载失败: ${e.message}`);
    }
  }

  // 图集
  if (!data.videos.length && data.images.length) {
    log(`  图集 ${data.images.length} 张`);
    for (let i = 0; i < data.images.length; i++) {
      const iurl = data.images[i];
      const ext = (iurl.match(/\.(\w{3,4})(\?|$)/) || [])[1] || 'jpg';
      const dest = path.join(opts.out, `${base}_${String(i + 1).padStart(2, '0')}.${ext}`);
      try {
        const r = await downloadFile(iurl, dest, pageUrl);
        log(`  ✓ ${path.basename(dest)}  ${fmtSize(r.bytes)}`);
        files.push(dest);
      } catch (e) {
        warn(`  ✗ 第 ${i + 1} 张失败: ${e.message}`);
      }
      await sleep(150);
    }
  }

  if (!files.length) throw new Error('所有文件都下载失败');

  return { title: base, files, dest: files[0], videos: data.videos.length, images: data.images.length };
}

// ───────────────────── CLI ─────────────────────

function parseArgs(argv) {
  const opts = {
    out: OUT_DEFAULT,
    waitMs: 6000,
    headful: false,
    profile: false,
    port: 9511,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-o': case '--out': opts.out = argv[++i]; break;
      case '--wait': opts.waitMs = Number(argv[++i]) || 6000; break;
      case '--headful': case '--show': opts.headful = true; break;
      case '--profile': opts.profile = true; break;
      case '--port': opts.port = Number(argv[++i]) || 9511; break;
      case '--chrome': opts.chromePath = argv[++i]; break;
      case '-h': case '--help': opts.help = true; break;
      default:
        if (!a.startsWith('-')) positional.push(a);
    }
  }

  // 多行输入支持（UI 会把多条链接当一个参数传）
  const urls = [];
  for (const p of positional) {
    const found = extractUrls(p);
    if (found.length) {
      for (const u of found) if (!urls.includes(u)) urls.push(u);
    } else if (p.trim()) {
      urls.push(p.trim());
    }
  }
  return { opts, urls };
}

function printHelp() {
  console.log(`
快手视频 / 图集下载

用法:
  node kuaishou-dl.mjs <链接> [更多...] [选项]

选项:
  -o, --out <dir>   输出目录（默认 ~/Downloads/快手）
  --headful         显示浏览器窗口（**首次强烈建议**，能看到发生了什么）
  --profile         复用登录态（存在 ~/.kuaishou-profile）
  --wait <ms>       页面等待时间（默认 6000）
  --port <n>        CDP 端口（默认 9511，自动避开 Windows 保留段）
  --chrome <path>   指定浏览器路径
  -h, --help        帮助

⚠️ 快手风控很严，这个模块需要真实登录态才能稳定工作：
   1. 先运行：node kuaishou-dl.mjs <链接> --headful --profile
   2. 在弹出的窗口里手动登录快手
   3. 登录态会存进 ~/.kuaishou-profile，之后加 --profile 就不用再登

   不登录时：首页/搜索页是空白壳（只有"登录即可享受…"），
   分享页会报「参数格式错误」或直接要求登录。

支持链接:
  https://v.kuaishou.com/xxxxx                    短链（自动展开）
  https://www.kuaishou.com/short-video/<id>       网页版
  https://v.m.chenzhongtech.com/fw/photo/<id>     H5 分享页

示例:
  node kuaishou-dl.mjs "https://v.kuaishou.com/xxxxx" --headful --profile
  node kuaishou-dl.mjs "<链接>" --profile -o D:\\ks
`);
}

async function main() {
  const { opts, urls } = parseArgs(process.argv.slice(2));
  if (opts.help || !urls.length) { printHelp(); process.exit(opts.help ? 0 : 1); }

  await fsp.mkdir(opts.out, { recursive: true });
  log(`输出目录: ${opts.out}`);
  log('启动浏览器...');

  const ctx = await launchChrome(opts);
  log(`浏览器就绪 ✓  (port=${ctx.port}${opts.headful ? '，可见窗口' : ''})`);

  const results = [];
  let failed = 0;
  try {
    for (const u of urls) {
      try {
        results.push(await handleOne(u, opts, ctx));
      } catch (e) {
        failed++;
        warn(`✗ ${u}\n    ${e.message}`);
      }
    }
  } finally {
    try { ctx.cdp.close(); } catch {}
    try { ctx.proc.kill(); } catch {}
    if (!opts.profile) {
      try { await fsp.rm(ctx.profileDir, { recursive: true, force: true }); } catch {}
    }
  }

  log('\n━━━ 汇总 ━━━');
  for (const r of results) log(`• ${r.title}  →  ${r.videos} 视频 / ${r.images} 图\n  ${r.dest}`);
  if (failed) log(`\n失败 ${failed} 个`);

  process.exitCode = failed ? 1 : 0;
}

// ───────────────────── 入口 ─────────────────────
export async function run() {
  assertFeature('kuaishou');
  await main();
}

function isDirectRun() {
  try {
    const entry = process.argv[1] || '';
    return /kuaishou-dl(\.mjs)?$/i.test(entry) || entry === '';
  } catch { return false; }
}

if (isDirectRun()) {
  main().catch((e) => {
    console.error('\n[致命]', e.message);
    process.exit(1);
  });
}
