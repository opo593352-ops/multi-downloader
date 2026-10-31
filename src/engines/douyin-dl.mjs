#!/usr/bin/env node
/**
 * douyin-dl.mjs — 抖音全自动下载器（零依赖）
 *
 * 原理：
 *   1. 短链 302 展开 -> aweme_id
 *   2. 启动 Chrome（CDP），打开作品页让页面 JS 完成 a_bogus 签名环境初始化
 *   3. 在页面上下文里 fetch aweme/detail 接口（签名由页面自己算，cookie 全带）
 *   4. 解析 bit_rate[]，挑最高画质（优先 muxed mp4，dash 是纯视频无音轨）
 *   5. Node 侧带 Referer/UA 下载到 Downloads
 *
 * 用法：
 *   node douyin-dl.mjs <链接或分享文本> [更多链接...]
 *   node douyin-dl.mjs "https://v.douyin.com/xxx/" --out D:\videos
 *   node douyin-dl.mjs <url> --quality 1080
 *   node douyin-dl.mjs <url> --headful        # 显示浏览器窗口（遇验证码时用）
 *   node douyin-dl.mjs <url> --audio          # 图文作品顺带下原声
 *   node douyin-dl.mjs <url> --json           # 只输出元数据，不下载
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { findBrowser, browserHelpText } from '../dev/browser.mjs';
import { assertFeature, shortTicket } from '../dev/gate.mjs';
import { pickPort } from '../dev/port.mjs';

import { downloadFile as dlDownload } from '../dev/dl.mjs';
// ───────────────────────────── 配置 ─────────────────────────────
const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';
const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const DEFAULT_OUT = path.join(os.homedir(), 'Downloads');

// ─────────────────────────── 小工具 ───────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 报错前缀拆开：esbuild 会把 'a'+'b' 折叠成 'ab'，所以用数组 join 阻断
const CDP_MSG = ['C', 'D', 'P', ' ', 't', 'i', 'm', 'e', 'o', 'u', 't', ':', ' '].join('');
const log = (...a) => console.log(...a);
const warn = (...a) => console.error('[warn]', ...a);

function findChrome() {
  // 统一走 browser.mjs：注册表 → 常见路径 → App Paths
  // 覆盖 Chrome / Edge / Brave / Chromium，Firefox 不支持 CDP 会被跳过
  const r = findBrowser();
  if (r.ok) return r.path;
  return null;
}

/** 找不到浏览器时打印可操作的提示（而不是让用户对着 ENOENT 发呆） */
function reportNoBrowser() {
  const r = findBrowser();
  console.error(browserHelpText(r));
}

/** 从任意分享文本里抠出抖音链接 */
function extractLinks(text) {
  const out = [];
  const re = /https?:\/\/[^\s"'<>，。、；）)]+/g;
  for (const m of String(text || '').matchAll(re)) {
    const glued = m[0].replace(/[.,;)]+$/, '');
    for (const u of glued.split(/(?=https?:\/\/)/i).filter(Boolean)) {
      const clean = u.replace(/[.,;)]+$/, '');
      if (/douyin\.com|iesdouyin\.com/i.test(clean)) out.push(clean);
    }
  }
  return [...new Set(out)];
}

/** 文件名净化 */
function safeName(s, max = 80) {
  let t = (s || 'douyin')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();

  // 抖音标题里常带一堆 #话题#，叠起来文件名超长
  // 策略：从第一个 # 开始，后面全是话题，直接截断
  const hashIdx = t.indexOf('#');
  if (hashIdx > 10) {          // 保护：标题本身不以 # 开头
    t = t.slice(0, hashIdx).trim();
  }
  // 兜底：去掉残留的孤立 #xxx
  t = t.replace(/(\s*#[^\s]{1,30})+\s*$/g, '').trim();

  // Windows 路径总长限制 260，目录名留 60 比较安全
  t = t.slice(0, max).trim();

  // 去掉结尾的标点和下划线
  t = t.replace(/[\s_\-.,，。、]+$/, '');

  return t || 'douyin';
}

function fmtSize(bytes) {
  if (bytes > 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + ' GB';
  if (bytes > 1024 ** 2) return (bytes / 1024 ** 2).toFixed(2) + ' MB';
  return (bytes / 1024).toFixed(1) + ' KB';
}

// ─────────────────────── 短链展开 ───────────────────────
async function expandLink(url) {
  let cur = url;
  for (let i = 0; i < 6; i++) {
    const res = await fetch(cur, {
      redirect: 'manual',
      headers: { 'User-Agent': UA_MOBILE, Referer: 'https://www.douyin.com/' },
    });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      cur = new URL(loc, cur).href;
      continue;
    }
    break;
  }
  return cur;
}

function parseAwemeId(url) {
  const m = url.match(/(?:video|note|share\/video|share\/note)\/(\d{15,25})/);
  if (m) return m[1];
  const q = url.match(/[?&](?:modal_id|aweme_id|vid)=(\d{15,25})/);
  if (q) return q[1];
  const any = url.match(/(\d{18,20})/);
  return any ? any[1] : null;
}

// ─────────────────────── 极简 CDP 客户端 ───────────────────────
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (timer) clearTimeout(timer);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.handlers.get(msg.method) || []) {
          try { fn(msg.params, msg.sessionId); } catch {}
        }
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      // 超时定时器必须 unref + 响应到达时 clearTimeout。
      // 否则每次 CDP 调用都在事件循环里留一个 60 秒把手，
      // 下载早就完成了进程还要空转一整分钟才退出，UI 一直等 WaitForExit。
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(CDP_MSG + method));
      }, 60000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  /** 关掉底层连接，解除事件循环上的引用 */
  close() {
    try { this.ws.close(); } catch {}
    for (const { timer } of this.pending.values()) { try { clearTimeout(timer); } catch {} }
    this.pending.clear();
  }
}

async function waitForWs(wsUrl, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const ws = new WebSocket(wsUrl);
      await new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error('ws open timeout')), 3000);
        timer.unref();
        ws.addEventListener('open', () => { clearTimeout(timer); res(); }, { once: true });
        ws.addEventListener('error', (e) => { clearTimeout(timer); rej(e); }, { once: true });
      });
      return ws;
    } catch {
      await sleep(200);
    }
  }
  throw new Error('无法连接 CDP WebSocket');
}

/** 启动 Chrome 并返回 {proc, cdp, sessionId, port, profileDir} */
async function launchChrome({ headful = false, chromePath, port = 9333, profileDir: fixedProfile } = {}) {
  const exe = chromePath || findChrome();
  // 首选端口可能落在 Windows 保留段里（本机 9295-9394 就盖住了 9333，
  // 实测 Chrome 会 bind 失败直接起不来）—— 自动顺延到可用端口。
  // 完整说明见 dev/port.mjs。
  port = await pickPort(port, warn);
  // 持久化 profile：签名 cookie（__ac_signature / ttwid / odin_tt）会留在里面，
  // 下次直接复用，避免每次都要从零被风控拦一遍
  const profileDir = fixedProfile
    ? (fs.mkdirSync(fixedProfile, { recursive: true }), fixedProfile)
    // 临时 profile 目录名带授权票：没票就跑不起来（见 dev/gate.mjs）
    : (() => {
        const tk = shortTicket('video');
        if (!tk) { const e = new Error('video 缺少授权凭据，无法启动'); e.code = 'ELOCKED'; throw e; }
        return fs.mkdtempSync(path.join(os.tmpdir(), 'dydl-' + tk + '-'));
      })();
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-features=Translate,MediaRouter',
    '--mute-audio',
    // 反检测：去掉自动化特征，否则抖音 Argus 风控会以
    // "Uifid Not Found" 为由直接 403
    '--disable-blink-features=AutomationControlled',
    '--exclude-switches=enable-automation',
    '--no-service-autorun',
    '--password-store=basic',
    '--use-mock-keychain',
    '--lang=zh-CN',
    'about:blank',
  ];
  if (!headful) {
    // 新版 headless，UA 与真实 Chrome 一致；老版 --headless 的 UA 里带 "HeadlessChrome"
    args.unshift('--headless=new');
  }
  args.unshift(`--user-agent=${UA_DESKTOP}`);

  const proc = spawn(exe, args, { stdio: 'ignore', windowsHide: !headful });

  // 诊断：spawn 失败 / Chrome 早退都要能看见原因，否则只会看到"端口未就绪"
  let spawnErr = null;
  let exitInfo = null;
  proc.on('error', (e) => { spawnErr = e; });
  proc.on('exit', (code, signal) => { exitInfo = { code, signal }; });

  // 等 /json/version 可用
  let wsUrl = null;
  for (let i = 0; i < 80; i++) {
    if (spawnErr) break;
    if (exitInfo && exitInfo.code !== 0 && exitInfo.code !== null) break;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      const j = await r.json();
      wsUrl = j.webSocketDebuggerUrl;
      if (wsUrl) break;
    } catch {}
    await sleep(150);
  }
  if (!wsUrl) {
    try { proc.kill(); } catch {}
    const detail = [
      spawnErr ? `spawn错误: ${spawnErr.message}` : null,
      exitInfo ? `Chrome退出 code=${exitInfo.code} signal=${exitInfo.signal}` : null,
      `exe=${exe}`,
      `port=${port}`,
      `profileDir=${profileDir}`,
    ].filter(Boolean).join(' | ');
    throw new Error(`Chrome 调试端口未就绪 → ${detail}`);
  }

  const ws = await waitForWs(wsUrl);
  const cdp = new CDP(ws);
  return { proc, cdp, port, profileDir, exe };
}

async function newPage(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);

  // 每个新文档加载前注入反检测脚本，抹掉 navigator.webdriver 等无头特征。
  // 抖音的 UIFID 生成逻辑会检测这些标志，检测到就不种 cookie。
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN','zh','en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
      window.chrome = window.chrome || { runtime: {} };
      const origQuery = window.navigator.permissions && window.navigator.permissions.query;
      if (origQuery) {
        window.navigator.permissions.query = (p) =>
          p && p.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : origQuery.call(window.navigator.permissions, p);
      }
    `,
  }, sessionId);

  if (url) {
    await cdp.send('Page.navigate', { url }, sessionId);
  }
  return { targetId, sessionId };
}

/** 在页面里求值，返回 JS 值 */
async function evaluate(cdp, sessionId, expression) {
  const r = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: true },
    sessionId
  );
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error('页面求值异常: ' + (d.exception?.description || d.text));
  }
  return r.result?.value;
}

/** 读出当前浏览器里 douyin.com 的 cookie 名集合 */
async function douyinCookieNames(cdp, sessionId) {
  try {
    // 注意：Network.getAllCookies 必须带 sessionId，否则 Chrome 会报
    // "'Network.getAllCookies' wasn't found" 或返回空集
    const r = await cdp.send('Network.getAllCookies', {}, sessionId);
    return new Set(
      (r.cookies || [])
        .filter((c) => c.domain.includes('douyin'))
        .map((c) => c.name)
    );
  } catch {
    return new Set();
  }
}

/**
 * 暖场：把签名 cookie 养齐再取数。
 * 抖音的 detail 接口要 a_bogus + 一整套 cookie（__ac_signature / ttwid / odin_tt /
 * s_v_web_id / msToken ...），这些是首页 JS 分几层种下来的，页面刚打开时往往不全。
 */
async function warmUp(cdp, sessionId, opts, needCount = 5) {
  // msToken 不是持久 cookie，是页面动态生成的 query 参数，不计入门槛
  const KEY = ['ttwid', '__ac_signature', 'odin_tt', 's_v_web_id', 'UIFID'];
  let best = 0;
  for (let round = 0; round < 3; round++) {
    const names = await douyinCookieNames(cdp, sessionId);
    const hit = KEY.filter((k) => names.has(k)).length;
    if (hit > best) best = hit;
    if (hit >= Math.min(needCount, KEY.length)) {
      log(`  签名环境就绪 (${hit}/${KEY.length} 关键 cookie)`);
      return true;
    }
    log(`  暖场 ${round + 1}/3 — cookie ${hit}/${KEY.length}，继续等...`);
    try {
      // 回首页养 cookie（视频页不一定触发全部种 cookie 逻辑）
      await cdp.send('Page.navigate', { url: 'https://www.douyin.com/' }, sessionId);
    } catch {}
    await sleep(2500 + round * 1500);
  }
  log(`  警告: 只拿到 ${best}/${KEY.length} 关键 cookie，仍尝试取数`);
  return false;
}

// ─────────────── 页面内取 detail 的注入脚本 ───────────────
function detailScript(awemeId, referer) {
  const q = new URLSearchParams({
    aweme_id: awemeId,
    device_platform: 'webapp',
    aid: '6383',
    channel: 'channel_pc_web',
    pc_client_type: '1',
    version_code: '170400',
    version_name: '17.4.0',
    cookie_enabled: 'true',
    screen_width: '1920',
    screen_height: '1080',
    browser_language: 'zh-CN',
    browser_platform: 'Win32',
    browser_name: 'Chrome',
    browser_version: '131.0.0.0',
    browser_online: 'true',
    engine_name: 'Blink',
    engine_version: '131.0.0.0',
    os_name: 'Windows',
    os_version: '10',
    cpu_core_num: '16',
    device_memory: '8',
    platform: 'PC',
    downlink: '10',
    effective_type: '4g',
    round_trip_time: '50',
  });
  return `(async () => {
    // 接口路径分段拼接，避免明文（这行原本是模板字符串，路径是常量部分）
    const API_PATH = ['/aweme', '/v1', '/web', '/aweme', '/detail/'].join('');
    const r = await fetch('https://www.douyin.com' + API_PATH + '?' + ${JSON.stringify(q.toString())}, {
      headers: { 'accept': 'application/json, text/plain, */*', 'referer': ${JSON.stringify(referer)} },
      credentials: 'include'
    });
    const t = await r.text();
    if (r.status !== 200) return { __err: 'http ' + r.status, head: t.slice(0, 400) };
    let j; try { j = JSON.parse(t); } catch (e) { return { __err: 'bad json', head: t.slice(0, 400) }; }
    const d = j.aweme_detail;
    if (!d) {
      // ── 视频取不到时，把**真实原因**翻出来 ──
      //
      // 实测（2026-10-28）：随手一个短链，接口返回
      //   {"aweme_detail":null,
      //    "filter_detail":{"detail_msg":"因作品权限或已被删除，无法观看…",
      //                     "filter_reason":"status_self_see",
      //                     "notice":"抱歉，作品不见了"}}
      // 旧代码一律报 "no aweme_detail"，用户看到这句完全不知道发生了什么，
      // 只会以为软件坏了 —— 我自己就先误判成"接口挂了"，白查了半天。
      //
      // 抖音把原因放在 filter_detail 里，直接透给用户。
      const fd = j.filter_detail || {};
      if (fd.detail_msg || fd.notice) {
        return {
          __err: 'video-unavailable',
          reason: fd.detail_msg || fd.notice,
          filterReason: fd.filter_reason || '',
          awemeId: fd.aweme_id || '',
        };
      }
      return { __err: 'no aweme_detail', keys: Object.keys(j) };
    }
    const v = d.video || {};
    const rates = (v.bit_rate || []).map(b => {
      const pa = b.play_addr || {};
      return {
        gear: b.gear_name, w: pa.width, h: pa.height,
        kbps: Math.round((b.bit_rate || 0) / 1000),
        fmt: b.format,
        url: (pa.url_list || [])[0] || null
      };
    }).filter(x => x.url);
    return {
      desc: d.desc,
      createTime: d.create_time,
      duration: v.duration,
      metaW: v.width, metaH: v.height, ratio: v.ratio,
      isImages: Array.isArray(d.images) && d.images.length > 0,
      images: (d.images || []).map(x => (x.url_list || [])[0]).filter(Boolean),
      playAddr: (v.play_addr && v.play_addr.url_list) || [],
      music: (() => {
        if (!d.music) return null;
        // 优先 music.play_url，其次 video.play_addr 里的 mp3（图文作品常见）
        const fromMusic = (d.music.play_url && d.music.play_url.url_list || [])[0] || null;
        const fromVideo = (v.play_addr && v.play_addr.url_list || []).find(u => u.toLowerCase().includes('.mp3')) || null;
        return {
          title: d.music.title,
          url: fromMusic || fromVideo || null
        };
      })(),
      rates
    };
  })()`;
}

// ─────────────── 画质挑选 ───────────────
function pickRate(rates, want = 'best') {
  if (!rates.length) return null;
  // mp4 = 音视频已封装；dash = 纯视频流（无音轨）
  const muxed = rates.filter((r) => r.fmt === 'mp4');
  const pool = muxed.length ? muxed : rates;

  const sorted = [...pool].sort((a, b) => (b.h - a.h) || (b.kbps - a.kbps));

  if (want === 'best') return sorted[0];
  const map = { '4k': 2160, '2160': 2160, '1440': 1440, '1080': 1080, '720': 720, '540': 540 };
  const target = map[String(want).toLowerCase()];
  if (!target) return sorted[0];
  // 找 <= target 的最高档
  const fit = sorted.filter((r) => r.h <= target + 40).sort((a, b) => (b.h - a.h) || (b.kbps - a.kbps));
  return fit[0] || sorted[0];
}

// ─────────────── 下载 ───────────────
async function downloadOnce(url, destPath, referer) {
  // 走共享实现：带空闲检测（防"卡在最后一点"）+ 断点续传。
  // 见 dev/dl.mjs 顶部说明。
  const r = await dlDownload(url, destPath, { referer });
  return r.bytes;
}

async function downloadFile(url, destPath, referer = 'https://www.douyin.com/', retries = 3) {
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    try {
      return await downloadOnce(url, destPath, referer);
    } catch (e) {
      lastErr = e;
      try { await fsp.rm(destPath, { force: true }); } catch {}
      if (i < retries - 1) {
        process.stderr.write(`\n  下载中断(${e.message})，重试 ${i + 1}/${retries - 1}...\n`);
        await sleep(1200 * (i + 1));
      }
    }
  }
  throw lastErr;
}

// ─────────────── 主流程 ───────────────
async function handleOne(rawUrl, opts, ctx) {
  log(`\n━━━ 处理: ${rawUrl}`);

  const expanded = await expandLink(rawUrl);
  log(`  展开: ${expanded.slice(0, 120)}`);

  const awemeId = parseAwemeId(expanded);
  if (!awemeId) throw new Error('无法解析 aweme_id');
  log(`  aweme_id: ${awemeId}`);

  const pageUrl = `https://www.douyin.com/video/${awemeId}`;
  const { sessionId } = await newPage(ctx.cdp, pageUrl);

  // 等页面把签名环境跑起来
  await sleep(opts.waitMs);

  // 养齐签名 cookie（持久化 profile 命中时会很快返回）
  await warmUp(ctx.cdp, sessionId, opts);

  const referer = `https://www.douyin.com/video/${awemeId}`;
  let data = null;
  let lastErr = null;

  // 三轮取数，每轮之间重新导航一次再试
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      data = await evaluate(ctx.cdp, sessionId, detailScript(awemeId, referer));
      if (data && !data.__err) break;

      // 「视频不存在 / 私密 / 已删除」是**确定性结果**，重试没有意义。
      // 继续重试只会让用户多等 20 秒，最后还是同一句话。
      if (data && data.__err === 'video-unavailable') break;

      lastErr = new Error(data?.__err || 'unknown');
    } catch (e) {
      lastErr = e;
    }
    if (attempt < 2) {
      log(`  取数失败(${lastErr?.message})，重试 ${attempt + 1}/2...`);
      try {
        await cdp.send('Page.navigate', { url: 'https://www.douyin.com/' }, sessionId);
        await sleep(3000 + attempt * 2000);
        await cdp.send('Page.navigate', { url: pageUrl }, sessionId);
        await sleep(opts.waitMs + 2000);
      } catch {}
    }
  }
  if (!data || data.__err) {
    // 把抖音自己给的原因翻译成人话，别丢一句 "no aweme_detail" 让用户猜
    if (data && data.__err === 'video-unavailable') {
      const why = String(data.reason || '').trim();
      const hint = {
        'status_self_see': '（该作品仅作者自己可见）',
        'status_delete': '（作品已被删除）',
        'status_friend_see': '（仅好友可见）',
        'status_private': '（私密作品）',
      }[data.filterReason] || '';
      throw new Error(
        `这个视频取不到：${why || '作品不可见'}${hint}\n` +
        `     aweme_id: ${data.awemeId || awemeId}\n` +
        `     这种情况换链接重试也没用，请确认该视频在浏览器里能正常播放。`
      );
    }
    throw new Error(`detail 接口取数失败: ${lastErr?.message || JSON.stringify(data)}`);
  }

  const info = {
    id: awemeId,
    desc: data.desc,
    duration: data.duration,
    isImages: data.isImages,
    imageCount: (data.images || []).length,
    meta: `${data.metaW}x${data.metaH} (${data.ratio})`,
    rates: data.rates.map((r) => `${r.h}p/${r.kbps}kbps/${r.fmt}`),
  };
  log(`  标题: ${data.desc}`);
  log(`  类型: ${data.isImages ? `图文(${info.imageCount}张)` : `视频 ${info.meta} ${(data.duration / 1000).toFixed(1)}s`}`);
  if (!data.isImages) log(`  档位: ${info.rates.join(' | ') || '无'}`);

  if (opts.jsonOnly) {
    return { ...info, raw: data };
  }

  const results = [];

  if (data.isImages) {
    // 图文：下图片 + 可选原声
    const baseName = safeName(data.desc, 60) || `douyin_${awemeId}`;
    for (let i = 0; i < data.images.length; i++) {
      const ext = /\.(jpe?g|png|webp)/i.exec(new URL(data.images[i]).pathname)?.[1] || 'webp';
      const dest = path.join(opts.out, baseName, `${baseName}_${String(i + 1).padStart(2, '0')}.${ext}`);
      try {
        const { bytes } = await downloadFile(data.images[i], dest, referer);
        log(`  ✓ 图片${i + 1}: ${path.basename(dest)} (${fmtSize(bytes)})`);
        results.push(dest);
      } catch (e) {
        warn(`图片${i + 1} 失败: ${e.message}`);
      }
    }
    if (opts.audio && data.music?.url) {
      const dest = path.join(opts.out, baseName, `原声_${safeName(data.music.title, 40)}.mp3`);
      try {
        const { bytes } = await downloadFile(data.music.url, dest, referer);
        log(`  ✓ 原声: ${path.basename(dest)} (${fmtSize(bytes)})`);
        results.push(dest);
      } catch (e) {
        warn(`原声失败: ${e.message}`);
      }
    }
    return { ...info, files: results };
  }

  // 视频
  let chosen = pickRate(data.rates, opts.quality);
  if (!chosen) {
    // 兜底：用 play_addr
    if (!data.playAddr.length) throw new Error('没有任何可用播放地址');
    chosen = { url: data.playAddr[0], h: data.metaH, kbps: 0, fmt: 'mp4' };
  }
  log(`  选定: ${chosen.h}p / ${chosen.kbps}kbps / ${chosen.fmt}`);

  const baseName = safeName(data.desc, 60) || `douyin_${awemeId}`;
  const dest = path.join(opts.out, `${baseName}_${chosen.h}p.mp4`);
  const { bytes } = await downloadFile(chosen.url, dest, referer);
  log(`  ✓ 视频: ${path.basename(dest)} (${fmtSize(bytes)})`);
  results.push(dest);

  return { ...info, files: results, chosen };
}

// ─────────────── CLI ───────────────
function parseArgs(argv) {
  const opts = {
    out: DEFAULT_OUT,
    quality: 'best',
    headful: false,
    audio: false,
    jsonOnly: false,
    waitMs: 6000,
    chromePath: null,
    port: 9333,
    keepProfile: true,
    profileDir: path.join(os.homedir(), '.douyin-dl-profile'),
  };
  const urls = [];
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--out': case '-o': opts.out = argv[++i]; break;
      case '--quality': case '-q': opts.quality = argv[++i]; break;
      case '--headful': opts.headful = true; break;
      case '--audio': opts.audio = true; break;
      case '--json': opts.jsonOnly = true; break;
      case '--wait': opts.waitMs = Number(argv[++i]) || 6000; break;
      case '--chrome': opts.chromePath = argv[++i]; break;
      case '--port': opts.port = Number(argv[++i]) || 9333; break;
      case '--profile': opts.profileDir = argv[++i]; break;
      case '--fresh': opts.keepProfile = false; break;
      case '--selftest': opts.selftest = true; break;
      case '--help': case '-h': opts.help = true; break;
      default:
        if (a.startsWith('-')) warn(`未知参数: ${a}`);
        else positional.push(a);
    }
  }

  const found = extractLinks(positional.join(' '));
  if (found.length) urls.push(...found);
  else {
    for (const p of positional) {
      if (/^\d{15,25}$/.test(p)) urls.push(`https://www.douyin.com/video/${p}`);
    }
  }
  return { opts, urls };
}

/** 程序名：SEA/EXE 下用自身文件名，源码运行时用 node <script> */
function progName() {
  const exe = path.basename(process.execPath || 'node.exe').toLowerCase();
  const isSea = exe !== 'node.exe' && exe !== 'node';
  return isSea ? path.basename(process.execPath) : 'douyin-dl.mjs';
}

function printHelp() {
  const P = progName();
  const isSea = P !== 'douyin-dl.mjs';
  const run = isSea ? P : `node ${P}`;
  console.log(`
抖音全自动下载器

用法:
  ${run} <链接/分享文本> [更多...]  [选项]
  ${run}                              不带参数时进入交互模式

选项:
  -o, --out <dir>      输出目录 (默认: ~/Downloads)
  -q, --quality <q>    画质: best|4k|2160|1440|1080|720|540 (默认 best)
      --audio          图文作品顺带下原声 mp3
      --json           只打印元数据 JSON，不下载
      --headful        显示浏览器窗口 (遇验证码时用)
      --wait <ms>      页面加载后等待时长 (默认 6000)
      --chrome <path>  指定 Chrome/Edge 可执行文件
      --port <n>       CDP 端口 (默认 9333)
      --profile <dir>  浏览器 profile 目录 (默认 ~/.douyin-dl-profile)
      --fresh          不持久化 profile，每次全新会话 (风控严时更易 403)
  -h, --help           显示本帮助

示例:
  ${run} "https://v.douyin.com/xxx/"
  ${run} "3.87 abc:/ 复制此链接 https://v.douyin.com/xxx/" -q 1080
  ${run} <url> -o D:\\videos --audio
`);
}

/** 交互模式：双击 EXE 时用，粘链接 + 选画质，循环处理 */
async function interactive(opts) {
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // 行缓冲模型：readline 在输入流提前 EOF 时会静默吞掉尚未 resolve 的 question，
  // 导致管道/重定向场景下卡死。这里自己管队列，TTY 与管道行为一致。
  const lineQueue = [];
  const lineWaiters = [];
  let stdinClosed = false;
  rl.on('line', (l) => {
    const w = lineWaiters.shift();
    if (w) w(l);
    else lineQueue.push(l);
  });
  rl.on('close', () => {
    stdinClosed = true;
    while (lineWaiters.length) lineWaiters.shift()('');
  });
  const ask = (q) => {
    process.stdout.write(q);
    if (lineQueue.length) {
      const v = lineQueue.shift();
      process.stdout.write(v + '\n');
      return Promise.resolve(v);
    }
    if (stdinClosed) return Promise.resolve('');
    return new Promise((res) => lineWaiters.push(res));
  };

  const QUALITY_MAP = { '1': 'best', '2': '4k', '3': '1440', '4': '1080', '5': '720', '6': '540' };

  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║        抖音全自动下载器  ·  交互模式         ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
  console.log(`  输出目录: ${opts.out}`);
  console.log('');

  let ctx = null;
  try {
    while (true) {
      const input = (await ask('粘贴抖音链接或分享文本（直接回车退出）:\n> ')).trim();
      if (!input) break;

      let urls = extractLinks(input);
      if (!urls.length && /^\d{15,25}$/.test(input)) {
        urls = [`https://www.douyin.com/video/${input}`];
      }
      if (!urls.length) {
        console.log('  ✗ 没识别到抖音链接，再试一次\n');
        continue;
      }

      console.log('');
      console.log('  画质:  [1] 最高(默认)  [2] 4K  [3] 1440p  [4] 1080p  [5] 720p  [6] 540p');
      const qc = (await ask('  选择 (回车=最高): ')).trim();
      const quality = QUALITY_MAP[qc] || 'best';

      if (!ctx) {
        console.log('\n  启动浏览器...');
        ctx = await launchChrome({
          headful: opts.headful,
          chromePath: opts.chromePath,
          port: opts.port,
          profileDir: opts.keepProfile ? opts.profileDir : undefined,
        });
        console.log('  浏览器就绪 ✓\n');
      }

      for (const u of urls) {
        try {
          const r = await handleOne(u, { ...opts, quality }, ctx);
          console.log('\n  ✅ 完成');
          for (const f of r.files || []) console.log(`     ${f}`);
        } catch (e) {
          console.log(`\n  ❌ 失败: ${e.message}`);
        }
        console.log('');
      }
    }
  } finally {
    rl.close();
    if (ctx) {
      try { await ctx.cdp.send('Browser.close'); } catch {}
      try { ctx.proc.kill(); } catch {}
      await sleep(500);
      if (!opts.keepProfile) {
        try { await fsp.rm(ctx.profileDir, { recursive: true, force: true }); } catch {}
      }
    }
  }
}

async function main() {
  const { opts, urls } = parseArgs(process.argv.slice(2));

  if (opts.help) { printHelp(); return; }

  // 自检：确认运行环境（EXE 打包后排查用）
  if (opts.selftest) {
    console.log('--- 环境自检 ---');
    console.log('exe      :', process.execPath);
    console.log('argv     :', process.argv.join(' '));
    console.log('cwd      :', process.cwd());
    console.log('homedir  :', os.homedir());
    console.log('tmpdir   :', os.tmpdir());
    console.log('node ver :', process.version);

    const testDir = path.join(os.homedir(), 'Downloads', '_dydl_selftest');
    try {
      await fsp.mkdir(testDir, { recursive: true });
      const probe = path.join(testDir, 'probe.txt');
      await fsp.writeFile(probe, 'ok');
      console.log('fs write : OK ->', probe);
      await fsp.rm(testDir, { recursive: true, force: true });
    } catch (e) {
      console.log('fs write : FAIL ->', e.code, e.message);
    }

    try {
      const chrome = opts.chromePath || findChrome();
      console.log('chrome   :', chrome);
      const t0 = Date.now();
      const p = spawn(chrome, ['--version'], { stdio: 'pipe', windowsHide: true });
      const out = await new Promise((res) => {
        let buf = '';
        // ⚠ 这个 15 秒定时器必须 unref + 收到结果时清掉。
        //   旧写法只 `setTimeout(() => res('timeout'), 15000)`：
        //   进程 exit 后定时器仍在事件循环里挂着 15 秒，
        //   `--selftest` 跑完不退出、看起来像卡死（实测踩到）。
        //   和交接文档坑 0 / 坑 23 是同一类错误。
        const timer = setTimeout(() => res('timeout'), 15000);
        timer.unref?.();
        const done = (v) => { clearTimeout(timer); res(v); };
        p.stdout?.on('data', (d) => (buf += d));
        p.on('error', (e) => done('SPAWN_ERR: ' + e.message));
        p.on('exit', (c) => done(`exit=${c} out=${buf.trim()}`));
      });
      console.log('spawn    :', out, `(${Date.now() - t0}ms)`);
    } catch (e) {
      console.log('spawn    : FAIL ->', e.message);
    }

    try {
      const { proc, cdp } = await launchChrome({
        headful: opts.headful, chromePath: opts.chromePath, port: opts.port,
        profileDir: opts.keepProfile ? opts.profileDir : undefined,
      });
      console.log('CDP      : OK');
      try { await cdp.send('Browser.close'); } catch {}
      try { proc.kill(); } catch {}
    } catch (e) {
      console.log('CDP      : FAIL ->', e.message);
    }
    console.log('--- 自检结束 ---');
    // 自检走完必须显式退出。
    // 只 `return` 的话，残留的 Chrome 子进程 / CDP WebSocket / 定时器
    // 会把事件循环拖住，命令行看起来就是"卡死不返回"（实测踩到）。
    await flushAndExit(0);
    return;
  }

  await fsp.mkdir(opts.out, { recursive: true });

  // 无参数 = 双击 EXE / 直接运行 → 进交互模式
  if (!urls.length) { await interactive(opts); return; }

  log(`输出目录: ${opts.out}`);
  log(`画质策略: ${opts.quality}`);

  let ctx;
  try {
    log('启动浏览器...');
    ctx = await launchChrome({
      headful: opts.headful,
      chromePath: opts.chromePath,
      port: opts.port,
      profileDir: opts.keepProfile ? opts.profileDir : undefined,
    });
    log(`浏览器就绪 ✓${opts.keepProfile ? ' (持久化 profile)' : ''}`);

    const all = [];
    let failed = 0;
    for (const u of urls) {
      try {
        const r = await handleOne(u, opts, ctx);
        all.push(r);
      } catch (e) {
        failed++;
        warn(`✗ ${u}\n    ${e.message}`);
      }
    }

    log('\n━━━ 汇总 ━━━');
    for (const r of all) {
      log(`• ${r.desc || '(无标题)'}  →  ${(r.files || []).length} 个文件`);
      for (const f of r.files || []) log(`    ${f}`);
    }
    if (failed) log(`\n失败 ${failed} 个`);

    if (opts.jsonOnly) console.log(JSON.stringify(all, null, 2));
    process.exitCode = failed ? 1 : 0;
  } finally {
    if (ctx) {
      try { await ctx.cdp.send('Browser.close'); } catch {}
      try { ctx.cdp.close(); } catch {}
      try { ctx.proc.kill(); } catch {}
      await sleep(600);
      // 持久化 profile 必须保留，临时 profile 才删
      if (!opts.keepProfile) {
        try { await fsp.rm(ctx.profileDir, { recursive: true, force: true }); } catch {}
      }
    }
    // 兜底：跑完立刻退，别让残留的 CDP 把手把进程拖住（UI 会一直等 WaitForExit）
    if (!opts.stayAlive) await flushAndExit(process.exitCode || 0);
  }
}

/**
 * 等 stdout/stderr 排空后再退出。
 * 直接 process.exit() 会截断管道里的异步写入，UI 日志会少最后几行。
 */
function flushAndExit(code) {
  return new Promise((resolve) => {
    let pending = 2;
    const done = () => { if (--pending <= 0) process.exit(code); };
    try { process.stdout.write('', done); } catch { done(); }
    try { process.stderr.write('', done); } catch { done(); }
    const t = setTimeout(() => process.exit(code), 800);
    t.unref();
    resolve();
  });
}

/** 双击 EXE 运行时，结束后停住等回车，避免窗口闪退看不到结果 */
async function pauseIfExe() {
  if (progName() === 'douyin-dl.mjs') return;      // 源码运行不停
  if (!process.stdin.isTTY) return;                 // 管道/重定向不停
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((r) => rl.question('\n按回车退出...', () => { rl.close(); r(); }));
}

// ─────────────────────────── 入口 ───────────────────────────
// 既支持 `node douyin-dl.mjs ...` 直接跑，也支持被 cli.mjs 导入后调 run()
export async function run() {
  // 功能闸门：**每个引擎自己验**，不信任上游 cli 的那一个 if。
  // 改 cli.mjs 里的 if (!activated) 只能骗过 cli，到这里照样被拦。
  assertFeature('video');
  await main();
}

// 仅当本文件被直接执行时才自动跑（被 import 时不触发）
function isDirectRun() {
  try {
    const entry = process.argv[1] || '';
    return /douyin-dl(\.mjs)?$/i.test(entry) || entry === '';
  } catch { return false; }
}

if (isDirectRun()) {
  main()
    .then(pauseIfExe)
    .catch(async (e) => {
      console.error('\n[致命]', e.message);
      await pauseIfExe().catch(() => {});
      process.exit(1);
    });
}
