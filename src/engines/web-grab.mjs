#!/usr/bin/env node
/**
 * web-grab.mjs — 通用网页抓取（测试/调试用）
 *
 * 定位：这是一个**通用工具**，不含任何站点的专属解析逻辑。
 *   用户给一个 URL，程序按通用规则抓：
 *     · 页面正文（走 Readability 风格的最大文本块启发式）
 *     · 图片（含懒加载属性）
 *     · 链接清单
 *     · 元信息（title / description / og:*）
 *   然后按需存成本地文件。
 *
 * 与 sites 的区别：
 *   sites  = 视频下载，靠 yt-dlp 的站点提取器
 *   grab   = 通用抓取，不针对任何站点，用于测试连通性/防盗链/结构
 *
 * 用法：
 *   node web-grab.mjs <url>
 *   node web-grab.mjs <url> --images -o D:\pics
 *   node web-grab.mjs <url> --text --json
 *   node web-grab.mjs <url> --links --limit 50
 *   node web-grab.mjs <url> --headful        # 需要过 Cloudflare 时
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { findBrowser, browserHelpText } from '../dev/browser.mjs';
import { assertFeature } from '../dev/gate.mjs';
import { pickPort } from '../dev/port.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DEFAULT_OUT = path.join(os.homedir(), 'Downloads', 'Grab');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 报错前缀拆开写：避免二进制里出现完整明文
const CDP_MSG = ['C', 'D', 'P', ' ', 't', 'i', 'm', 'e', 'o', 'u', 't', ':', ' '].join('');
const log = (...a) => console.log(...a);
const warn = (...a) => console.error('[warn]', ...a);

function fmtSize(b) {
  if (!b) return '-';
  if (b > 1024 ** 2) return (b / 1024 ** 2).toFixed(2) + ' MB';
  return (b / 1024).toFixed(0) + ' KB';
}

function safeName(s, max = 80) {
  return String(s || 'file')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max) || 'file';
}

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

// ───────────────────── 极简 CDP ─────────────────────
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject, timer } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (timer) clearTimeout(timer);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(CDP_MSG + method));
      }, 45000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
  }
  close() {
    try { this.ws.close(); } catch {}
    for (const { timer } of this.pending.values()) { try { clearTimeout(timer); } catch {} }
    this.pending.clear();
  }
}

async function launchChrome({ headful = false, chromePath, port = 9663, profileDir, proxyUrl } = {}) {
  // 9663 落在 Windows 保留段 9571-9670 里，实测 Chrome 会 bind 失败。
  // 自动顺延到可用端口（见 dev/port.mjs）。
  port = await pickPort(port, warn);
  const exe = chromePath || findChrome();
  if (!exe) {
    reportNoBrowser();
    throw new Error('缺少浏览器，无法继续');
  }

  const prof = profileDir || fs.mkdtempSync(path.join(os.tmpdir(), 'grab-'));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${prof}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--mute-audio',
    // ── 反检测三件套 ──
    // CSDN 会用 navigator.webdriver / headless UA / 窗口尺寸 判断机器人，
    // 命中就返回「请进行安全验证(Security Verification)」页。
    // 只加 --disable-blink-features 不够，实测仍然被拦。
    '--disable-blink-features=AutomationControlled',
    '--exclude-switches=enable-automation',
    // 去掉「Chrome 正受到自动测试软件的控制」提示条，同时也少一个特征
    '--disable-infobars',
    // headless 的 navigator.userAgent 里不带 HeadlessChrome，但
    // navigator.userAgentData 仍有差异；下面的 Runtime 注入会一起补
    '--lang=zh-CN',
    `--user-agent=${UA}`,
    'about:blank',
  ];
  if (!headful) {
    // new headless 的 UA 已经是正常 Chrome，但窗口尺寸默认 800x600——
    // 真实用户很少是这个尺寸，CSDN 会拿它做一项判断。
    args.unshift('--window-size=1920,1080');
    args.unshift('--headless=new');
  }

  // ── 代理支持 ──
  // Chrome 不读 HTTP_PROXY 环境变量，必须显式给 --proxy-server。
  // 需要翻墙的站点（Wikipedia/BBC/Medium 等）没有这个参数必然失败，
  // 而失败时 Chrome 会给一个 chrome-error:// 页，被误当正文。
  //
  // 取值优先级：显式 opts.proxy > HTTPS_PROXY > HTTP_PROXY > ALL_PROXY
  const proxy =
    proxyUrl ||
    process.env.DSH_DL_PROXY ||
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy ||
    '';
  if (proxy) {
    // Chrome 只认 scheme://host:port，不接受带认证的 URL
    let p = String(proxy).trim();
    if (!/^[a-z]+:\/\//i.test(p)) p = 'http://' + p;
    try {
      const u = new URL(p);
      const clean = u.protocol + '//' + u.hostname + (u.port ? ':' + u.port : '');
      args.push('--proxy-server=' + clean);
    } catch {
      args.push('--proxy-server=' + p);
    }
    // 绕过本地地址，避免调试端口走代理
    args.push('--proxy-bypass-list=<-loopback>');
  } else {
    args.push('--no-proxy-server');
  }

  const proc = spawn(exe, args, { stdio: 'ignore', windowsHide: !headful });
  let wsUrl = null;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      const j = await r.json();
      if (j.webSocketDebuggerUrl) { wsUrl = j.webSocketDebuggerUrl; break; }
    } catch {}
    await sleep(150);
  }
  if (!wsUrl) { try { proc.kill(); } catch {} throw new Error('Chrome 调试端口未就绪'); }

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('ws timeout')), 5000);
    t.unref();
    ws.addEventListener('open', () => { clearTimeout(t); res(); }, { once: true });
    ws.addEventListener('error', (e) => { clearTimeout(t); rej(e); }, { once: true });
  });
  return { proc, cdp: new CDP(ws), profileDir: prof };
}

// ───────────────────── 页面内采集脚本 ─────────────────────
/**
 * 用启发式找"正文"：
 *   1. 优先 <article>，其次常见容器 class/id（content/article/post/entry）
 *   2. 都找不到 → 选文本密度最高的块（子元素少、文字多）
 *   3. 兜底 body
 *
 * 这不是 Readability 的完整实现，但对普通页面够用。
 */
function collectScript() {
  return `(() => {
    const T = (e) => (e && e.innerText ? e.innerText : '').trim();

    // ── 先判断这是不是 Chrome 的错误页 ──
    // 断网、DNS 失败、证书错误时，Chrome 会渲染一个 chrome-error:// 页面，
    // 内容是"请检查您的互联网连接是否正常"之类的提示。
    // 如果不拦，程序会把它当正文抓下来，用户拿到一堆垃圾还以为是抓取成功。
    const href = location.href || '';
    if (href.startsWith('chrome-error://') || href.startsWith('chrome://')) {
      const bodyTxt = document.body ? document.body.innerText : '';
      // Chrome 错误页的特征文案
      const isNetErr = /检查您的互联网连接|请检查网络|ERR_|无法访问此网站|This site can|t be reached/i.test(bodyTxt);
      return {
        __error: isNetErr ? 'network' : 'chrome-page',
        __detail: bodyTxt.slice(0, 200),
        url: href,
        textLen: 0, text: '', images: [], links: [],
        meta: { title: '' }, pick: { how: 'error-page' },
        htmlLen: 0,
      };
    }

    // ── 识别拦截页 ──
    // 抓不到正文的三种常见原因，必须区分开，否则用户以为是程序坏了：
    //   1. Cloudflare / 人机验证（"请稍候…"、"Just a moment"）
    //   2. 登录墙（"无权访问"、"请先登录"）
    //   3. 真·空页面
    const bodyAll = (document.body ? document.body.innerText : '') || '';
    const titleStr = document.title || '';

    const challengeRe = /请稍候|Just a moment|Checking your browser|Verify you are human|Cloudflare|正在进行安全验证|人机验证|安全验证|Security Verification|拖动滑块|请完成.{0,6}验证/i;
    const loginWallRe = /无权访问|请先登录|登录后查看|请登录|Sign in to continue|Access denied|401|403/i;

    // 页面很短且命中特征 → 判为拦截页
    // v1.3.0：CSDN 的验证页 HTML 有 29 KB，innerText 也可能超过 3000，
    //         但正文容器 #content_views 一定不存在。所以再加一条：
    //         命中验证特征且拿不到正文容器，就判为 challenge。
    const hasChallengeText = challengeRe.test(titleStr + ' ' + bodyAll);
    const hasContentBox = !!(document.querySelector('#content_views, [itemprop="articleBody"], .article-content, article'));
    if (hasChallengeText && (!hasContentBox || bodyAll.length < 3000)) {
      return {
        __error: 'challenge',
        __detail: titleStr + ' | ' + bodyAll.slice(0, 120),
        url: location.href,
        textLen: 0, text: '', images: [], links: [],
        meta: { title: titleStr }, pick: { how: 'challenge-page' },
        htmlLen: 0,
      };
    }
    // 登录墙：标题命中就够（很多站正文区被替换成登录提示，但 body 可能不短）
    if (loginWallRe.test(titleStr)) {
      return {
        __error: 'login-wall',
        __detail: titleStr + ' | ' + bodyAll.slice(0, 120),
        url: location.href,
        textLen: 0, text: '', images: [], links: [],
        meta: { title: titleStr }, pick: { how: 'login-wall' },
        htmlLen: 0,
      };
    }

    // 元信息
    const meta = {};
    meta.title = document.title || '';
    const mdesc = document.querySelector('meta[name="description"]');
    if (mdesc) meta.description = mdesc.content || '';
    const og = {};
    document.querySelectorAll('meta[property^="og:"]').forEach(m => {
      og[m.getAttribute('property')] = m.content || '';
    });
    meta.og = og;
    const canon = document.querySelector('link[rel="canonical"]');
    if (canon) meta.canonical = canon.href;

    // 正文容器
    /**
     * 正文提取（Readability 风格的简化打分）
     *
     * 旧版只按"文字多、标签少"打分，实战踩了大坑：
     *   观网的导航菜单 <ul> 文字/标签比很高，被误判成正文（只抓到 9 字）。
     *
     * 现在加两个关键修正：
     *   1. **链接密度惩罚**：文字里超过一半在 <a> 里 → 是导航/列表，扣分
     *   2. **段落密度加分**：<p> 越多、平均长度越长 → 越可能是正文
     * 另外把候选池从 div/section 扩到所有块级元素。
     */
    const pickContent = () => {
      const scored = [];

      // ═══ 站点白名单：已知结构明确，优先精确命中 ═══
      //
      // 走启发式打分会漏东西（链接密度、段落密度都不适用代码密集的技术站），
      // 已知容器直接取，又快又准。
      //
      // CSDN:   #content_views   正文（#article_content 是外层包裹）
      //         ⚠ CSDN 有「展开全文」按钮，未点开时部分内容在 .hide-article-box
      //           里被截断，所以先移除该遮罩再取。
      const SITE_SELECTORS = [
        '#content_views',              // CSDN / 部分博客
        '[itemprop="articleBody"]',    // 通用语义标记
        '.article-content',            // 掘金 / 简书
        '#js_content',                 // 微信公众号
        'article',
      ];

      for (const sel of SITE_SELECTORS) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const txt = T(el);
        if (txt.length < 150) continue;
        // 返回结构与启发式一致（el/score/len/linkDensity/pDensity）
        return { el, score: 999, len: txt.length, linkDensity: 0, pDensity: 1, via: 'selector:' + sel };
      }

      const cands = document.querySelectorAll(
        'article, main, div, section, td, [role="main"], [itemprop="articleBody"]'
      );

      for (const el of cands) {
        // 跳过明显的非正文
        const tag = el.tagName.toLowerCase();
        if (tag === 'nav' || tag === 'aside' || tag === 'footer' || tag === 'header') continue;
        const cls = (el.className || '').toString().toLowerCase();
        const id = (el.id || '').toString().toLowerCase();
        const hint = cls + ' ' + id;
        if (/comment|sidebar|footer|header|nav|menu|breadcrumb|related|share|advert|banner|popup|modal|toolbar|pagination/.test(hint)) continue;

        const txt = T(el);
        if (txt.length < 150) continue;

        const totalLen = txt.length;

        // 链接文字长度
        let linkLen = 0;
        for (const a of el.querySelectorAll('a')) linkLen += (a.innerText || '').trim().length;
        const linkDensity = totalLen > 0 ? linkLen / totalLen : 0;

        // 段落统计
        const ps = el.querySelectorAll('p');
        let pTextLen = 0;
        for (const p of ps) pTextLen += (p.innerText || '').trim().length;
        const pDensity = totalLen > 0 ? pTextLen / totalLen : 0;

        const childCount = el.querySelectorAll('*').length || 1;

        // 打分
        let score = totalLen / Math.sqrt(childCount);   // 基础：文字多、标签少
        score *= (1 - linkDensity * 1.5);                // 链接多 → 大幅扣分
        score *= (0.6 + pDensity * 1.2);                 // 段落多 → 加分
        if (el.tagName === 'ARTICLE') score *= 1.25;     // 语义标签优先
        if (el.tagName === 'MAIN') score *= 1.15;
        // 类名/ID 里有 content/article/text/body 的轻微加分
        if (/article|content|post|entry|text|body|detail/.test(hint)) score *= 1.1;

        if (score > 0) scored.push({ el, score, len: totalLen, linkDensity, pDensity });
      }

      scored.sort((a, b) => b.score - a.score);
      return scored[0] || null;
    };

    let root, pickInfo = null;

    // 优先语义标签
    const semantic = document.querySelector('article') ||
                     document.querySelector('[itemprop="articleBody"]') ||
                     document.querySelector('[role="main"]');

    if (semantic && T(semantic).length > 200) {
      root = semantic;
      pickInfo = { how: 'semantic', score: 0 };
    } else {
      const best = pickContent();
      if (best) {
        root = best.el;
        pickInfo = {
          how: 'scored',
          score: Math.round(best.score),
          linkDensity: Math.round(best.linkDensity * 100) / 100,
          pDensity: Math.round(best.pDensity * 100) / 100,
        };
      } else {
        root = document.body;
        pickInfo = { how: 'body-fallback' };
      }
    }

    const text = T(root);

    // 图片：含懒加载属性
    const imgs = [];
    const seen = new Set();
    for (const img of document.querySelectorAll('img')) {
      const src =
        img.getAttribute('data-original') ||
        img.getAttribute('data-src') ||
        img.getAttribute('data-actualsrc') ||
        img.getAttribute('data-lazy-src') ||
        img.currentSrc ||
        img.src || '';
      if (!src || src.startsWith('data:')) continue;
      let abs = src;
      try { abs = new URL(src, location.href).href; } catch {}
      if (seen.has(abs)) continue;
      seen.add(abs);
      imgs.push({
        url: abs,
        alt: img.getAttribute('alt') || '',
        w: img.naturalWidth || 0,
        h: img.naturalHeight || 0,
      });
    }

    // 链接
    const links = [];
    const lseen = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      let abs = a.href;
      if (!/^https?:/i.test(abs)) continue;
      if (lseen.has(abs)) continue;
      lseen.add(abs);
      links.push({ url: abs, text: (a.innerText || '').trim().slice(0, 80) });
    }

    return {
      url: location.href,
      meta,
      text,
      textLen: text.length,
      rootTag: root.tagName ? root.tagName.toLowerCase() : '?',
      rootClass: (root.className || '').toString().slice(0, 80),
      pick: pickInfo,
      images: imgs,
      links,
      htmlLen: document.documentElement.outerHTML.length,
    };
  })()`;
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

// ───────────────────── 下载图片 ─────────────────────
/**
 * 按文件头魔数判断真实图片格式。
 *
 * 为什么不能只看 URL 后缀：知乎图床的 v2-xxx_r.jpg 实际返回的常常是 PNG
 * 或 WebP。存成 .jpg 后部分软件打不开（"declares image/jpeg but bytes
 * use a different format"），买家会以为图片没下好。
 */
export function sniffImageExt(buf) {
  if (!buf || buf.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  // GIF: GIF87a / GIF89a
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
  // WebP: RIFF....WEBP
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';
  // AVIF / HEIF: ....ftypavif | ftypheic | ftyp mif1
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    const brand = buf.slice(8, 12).toString('ascii');
    if (brand.startsWith('avif') || brand.startsWith('avis')) return 'avif';
    if (brand.startsWith('heic') || brand.startsWith('heix') || brand.startsWith('mif1')) return 'heic';
  }
  // BMP: 42 4D
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  // SVG: 文本，开头常含 <svg 或 <?xml
  const head = buf.slice(0, 200).toString('utf8').trim().toLowerCase();
  if (head.startsWith('<?xml') || head.startsWith('<svg')) {
    if (head.includes('<svg')) return 'svg';
  }
  return null;
}

/**
 * 下载单个文件到 dest。供 zhihu-md.mjs 复用（图片本地化）。
 * referer 必须给，否则知乎等站点防盗链 403。
 *
 * 返回 { bytes, ext }。ext 是按真实字节嗅探出来的扩展名（可能是 null）。
 */
export async function downloadFile(url, dest, referer) {
  const headers = { 'User-Agent': UA, Accept: 'image/*,*/*;q=0.8' };
  if (referer) headers.Referer = referer;

  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 64) throw new Error(`文件过小 (${buf.length}B)`);

  // 真实格式优先；嗅探不出再退回 URL 后缀
  const ext = sniffImageExt(buf)
    || (res.headers.get('content-type') || '').match(/image\/(jpeg|png|gif|webp|avif|bmp|svg)/i)?.[1]
    || null;

  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.writeFile(dest, buf);
  return { bytes: buf.length, ext };
}

/** 从 URL 猜扩展名 */
export function extOf(url, fallback = 'jpg') {
  try {
    const p = new URL(url).pathname;
    const m = p.match(/\.(jpe?g|png|gif|webp|bmp|avif)$/i);
    if (m) return m[1].toLowerCase().replace('jpeg', 'jpg');
  } catch {}
  return fallback;
}

// ───────────────────── 主流程 ─────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const opts = {
    out: DEFAULT_OUT,
    headful: false,
    chromePath: null,
    proxy: null,
    port: 9663,
    waitMs: 3500,
    wantImages: false,
    wantText: false,
    wantLinks: false,
    jsonOnly: false,
    limitImgs: 100,
    limitLinks: 200,
    minImgW: 0,
    minImgH: 0,
  };
  const urls = [];
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-o': case '--out': opts.out = argv[++i]; break;
      case '--images': case '--img': opts.wantImages = true; break;
      case '--text': opts.wantText = true; break;
      case '--links': opts.wantLinks = true; break;
      case '--all': opts.wantImages = opts.wantText = opts.wantLinks = true; break;
      case '--json': opts.jsonOnly = true; break;
      case '--headful': opts.headful = true; break;
      case '--chrome': opts.chromePath = argv[++i]; break;
      case '--proxy': opts.proxy = argv[++i]; break;
      case '--no-proxy': opts.proxy = ''; break;
      case '--port': opts.port = Number(argv[++i]) || 9663; break;
      case '--wait': opts.waitMs = Number(argv[++i]) || 3500; break;
      case '--limit': opts.limitImgs = Number(argv[++i]) || 100; break;
      case '--limit-links': opts.limitLinks = Number(argv[++i]) || 200; break;
      case '--min-w': opts.minImgW = Number(argv[++i]) || 0; break;
      case '--min-h': opts.minImgH = Number(argv[++i]) || 0; break;
      case '-h': case '--help': opts.help = true; break;
      default:
        if (a.startsWith('-')) warn(`未知参数: ${a}`);
        else positional.push(a);
    }
  }

  // 多行输入支持：UI 的输入框是多行的，粘两条链接时 C# 会把它当**一个**参数传进来。
  // 旧逻辑用 `^https?://` 匹配整串 → 带换行的整条被丢弃
  // （与站点视频的 bug 同源，实测复现）。
  for (const p of positional) {
    const found = String(p).match(/https?:\/\/[^\s"'<>，。、；）)]+/g) || [];
    for (let u of found) {
      u = u.replace(/[.,;)\]]+$/, '');
      if (!urls.includes(u)) urls.push(u);
    }
  }

  if (opts.help || !urls.length) {
    console.log(`
通用网页抓取（测试用）

用法:
  web-grab.mjs <url> [选项]

选项:
  -o, --out <dir>        保存目录 (默认 ~/Downloads/Grab)
      --images           下载图片
      --text             保存正文为 txt
      --links            导出链接清单
      --all              三者都要
      --limit <n>        最多下载几张图 (默认 100)
      --limit-links <n>  最多导出几条链接 (默认 200)
      --min-w <px>       只下宽度 >= px 的图
      --min-h <px>       只下高度 >= px 的图
      --proxy <url>      走代理（如 http://127.0.0.1:7897）
                         不指定时自动读 HTTPS_PROXY / HTTP_PROXY
      --no-proxy         强制直连（忽略环境变量里的代理）
      --headful          显示浏览器（过 Cloudflare/验证码用）
      --wait <ms>        页面加载后等待 (默认 3500)
      --json             只输出结构化结果，不落盘
  -h, --help             帮助

说明:
  这是通用工具，不针对任何站点做专门适配。
  正文用"文本密度"启发式提取，复杂页面可能不准。
  遇到 403 / Cloudflare，先加 --headful 手动过一次验证。

示例:
  web-grab.mjs "https://example.com/article"
  web-grab.mjs "<url>" --images -o D:\\pics --min-w 800
  web-grab.mjs "<url>" --all --json
`);
    process.exitCode = opts.help ? 0 : 1;
    return;
  }

  let ctx;
  const results = [];

  try {
    log('启动浏览器...');
    ctx = await launchChrome({
      headful: opts.headful, chromePath: opts.chromePath, port: opts.port,
      proxyUrl: opts.proxy,
    });
    log('浏览器就绪 ✓');

    for (const url of urls) {
      log(`\n━━━ ${url}`);

      const { targetId } = await ctx.cdp.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await ctx.cdp.send('Target.attachToTarget', { targetId, flatten: true });
      await ctx.cdp.send('Page.enable', {}, sessionId);
      await ctx.cdp.send('Runtime.enable', {}, sessionId);
      await ctx.cdp.send('Network.enable', {}, sessionId);
      await ctx.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          // ── 反自动化检测 ──
          // CSDN 这类站点会读这些特征判断是不是机器人：
          //   navigator.webdriver      → true 就拦
          //   navigator.plugins.length → headless 里是 0
          //   navigator.languages      → 空数组也露馅
          //   window.chrome            → headless 里可能缺失
          // 全部补齐成正常浏览器该有的样子。
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
          Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
          Object.defineProperty(navigator, 'plugins', {
            get: () => [1, 2, 3, 4, 5].map(() => ({ length: 1 })),
          });
          Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
          Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
          window.chrome = window.chrome || { runtime: {} };
          // permissions.query 在 headless 下对 notifications 返回值不同
          const origQuery = window.navigator.permissions?.query?.bind(window.navigator.permissions);
          if (origQuery) {
            window.navigator.permissions.query = (p) =>
              p && p.name === 'notifications'
                ? Promise.resolve({ state: Notification.permission })
                : origQuery(p);
          }
        `,
      }, sessionId);

      await ctx.cdp.send('Page.navigate', { url }, sessionId);
      await sleep(opts.waitMs);

      let data = null;
      for (let i = 0; i < 3; i++) {
        try {
          data = await evaluate(ctx.cdp, sessionId, collectScript());
          if (data && (data.textLen > 50 || data.images.length)) break;
        } catch (e) {
          warn(`  采集失败(${i + 1}/3): ${e.message}`);
        }
        await sleep(1500);
      }

      if (!data) {
        warn(`✗ ${url} 采集不到内容`);
        continue;
      }

      // 页面本身是错误页 / 拦截页
      if (data.__error) {
        const MSG = {
          network: '页面加载失败：网络不通（检查网络、代理或该站点是否被墙）',
          challenge: '被反爬拦截：站点要求人机验证（滑块/拼图）。\n'
                   + '  → 加 --headful 打开浏览器，手动拖一次滑块；\n'
                   + '  → 同一次运行里的后续链接会复用同一个 profile，不用反复拖。',
          'login-wall': '需要登录：该页面要求先登录才能看内容',
          'chrome-page': '页面加载失败：Chrome 内部页（' + data.url + '）',
        };
        const msg = MSG[data.__error] || ('页面异常：' + data.__error);
        warn(`✗ ${msg}`);
        warn(`   页面提示: ${String(data.__detail || '').replace(/\s+/g, ' ').slice(0, 100)}`);
        results.push({ url, error: data.__error, message: msg, files: [] });
        continue;
      }

      const title = (data.meta && data.meta.title) || new URL(url).hostname;
      log(`  标题: ${String(title).slice(0, 70)}`);
      log(`  正文: ${data.textLen} 字  (容器 <${data.rootTag}>)`);
      log(`  图片: ${data.images.length} 张`);
      log(`  链接: ${data.links.length} 条`);
      if (data.meta && data.meta.description) {
        log(`  描述: ${String(data.meta.description).slice(0, 60)}`);
      }

      const rec = {
        url,
        finalUrl: data.url,
        title,
        textLen: data.textLen,
        images: data.images.length,
        links: data.links.length,
        files: [],
      };

      if (opts.jsonOnly) {
        results.push({
          ...rec,
          pick: data.pick || null,
          text: data.text,
          imageList: data.images.slice(0, opts.limitImgs),
          linkList: data.links.slice(0, opts.limitLinks),
        });
        continue;
      }

      // 输出目录
      const baseDir = path.join(opts.out, safeName(title, 60) || 'page');
      await fsp.mkdir(baseDir, { recursive: true });

      if (opts.wantText && data.text) {
        const f = path.join(baseDir, '正文.txt');
        const head = [
          title,
          '='.repeat(Math.min(60, String(title).length * 2)),
          '',
          `来源: ${data.url}`,
          `抓取时间: ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
          '',
          '-'.repeat(40),
          '',
        ].join('\n');
        await fsp.writeFile(f, head + data.text + '\n', 'utf-8');
        log(`  ✓ 正文.txt (${fmtSize(Buffer.byteLength(head + data.text))})`);
        rec.files.push(f);
      }

      if (opts.wantLinks && data.links.length) {
        const f = path.join(baseDir, '链接清单.txt');
        const lines = data.links.slice(0, opts.limitLinks).map((l) => `${l.text || '-'}\t${l.url}`);
        await fsp.writeFile(f, lines.join('\n') + '\n', 'utf-8');
        log(`  ✓ 链接清单.txt (${lines.length} 条)`);
        rec.files.push(f);
      }

      if (opts.wantImages && data.images.length) {
        let imgs = data.images;
        if (opts.minImgW > 0) imgs = imgs.filter((x) => (x.w || 0) >= opts.minImgW || x.w === 0);
        if (opts.minImgH > 0) imgs = imgs.filter((x) => (x.h || 0) >= opts.minImgH || x.h === 0);
        imgs = imgs.slice(0, opts.limitImgs);

        const imgDir = path.join(baseDir, '图片');
        await fsp.mkdir(imgDir, { recursive: true });
        let ok = 0, fail = 0, bytes = 0;
        for (let i = 0; i < imgs.length; i++) {
          const im = imgs[i];
          // 先按 URL 猜一个，下载后按真实字节校正扩展名
          const guessExt = extOf(im.url);
          const seq = String(i + 1).padStart(3, '0');
          const dest = path.join(imgDir, `${seq}.${guessExt}`);
          try {
            const r = await downloadFile(im.url, dest, data.url);
            let realDest = dest;
            if (r.ext && r.ext !== guessExt) {
              realDest = path.join(imgDir, `${seq}.${r.ext}`);
              await fsp.rename(dest, realDest);
            }
            ok++; bytes += r.bytes;
            process.stderr.write(`\r    图片 ${i + 1}/${imgs.length}  ✓ ${fmtSize(bytes)}   `);
          } catch (e) {
            fail++;
            process.stderr.write(`\r    图片 ${i + 1}/${imgs.length}  ✗ ${e.message.slice(0, 30)}   `);
          }
          await sleep(120);   // 温和限速，避免被判定为爬虫
        }
        process.stderr.write('\n');
        log(`  ✓ 图片 ${ok} 张 (${fmtSize(bytes)})${fail ? `，失败 ${fail}` : ''}`);
        rec.files.push(imgDir);
      }

      results.push(rec);
    }

    if (opts.jsonOnly) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      log('\n━━━ 汇总 ━━━');
      for (const r of results) {
        log(`• ${String(r.title).slice(0, 50)}  →  ${r.files.length} 项`);
        for (const f of r.files) log(`    ${f}`);
      }
    }
  } finally {
    if (ctx) {
      try { await ctx.cdp.send('Browser.close'); } catch {}
      try { ctx.cdp.close(); } catch {}
      try { ctx.proc.kill(); } catch {}
    }
  }
}

export async function run() {
  // 功能闸门：**每个引擎自己验**，不信任上游 cli 的那一个 if。
  // 改 cli.mjs 里的 if (!activated) 只能骗过 cli，到这里照样被拦。
  assertFeature('grab');
  await main();
}

function isDirectRun() {
  try {
    const entry = process.argv[1] || '';
    return /web-grab(\.mjs)?$/i.test(entry) || entry === '';
  } catch { return false; }
}

if (isDirectRun()) {
  main().catch((e) => {
    console.error('\n[致命]', e.message);
    process.exit(1);
  });
}
