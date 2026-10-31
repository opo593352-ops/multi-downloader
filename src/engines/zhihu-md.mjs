#!/usr/bin/env node
/**
 * zhihu-md.mjs — 知乎文章转 Markdown
 *
 * 为什么必须用浏览器：
 *   知乎内容页返回 403 + `zh-zse-ck` JS 挑战载荷，需要在真实浏览器里执行
 *   JS 生成 `__zse_ck` cookie 才能通过。纯 HTTP 抓取拿不到正文。
 *
 * 策略：
 *   启动 Chrome → 打开文章页 → 等 JS 挑战通过 → 在页面上下文把
 *   article DOM 转成 Markdown → 落盘。
 *
 * 用法：
 *   node zhihu-md.mjs <url> [更多url...]
 *   node zhihu-md.mjs <url> -o D:\notes
 *   node zhihu-md.mjs <url> --headful        # 显示窗口（首次过验证/登录用）
 *   node zhihu-md.mjs <url> --profile <dir>  # 用你自己的 Chrome 登录态
 *   node zhihu-md.mjs <url> --json           # 只输出元数据
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { findBrowser, browserHelpText } from '../dev/browser.mjs';
import { exportAs } from './doc-export.mjs';
import { downloadFile, extOf } from './web-grab.mjs';
import { assertFeature } from '../dev/gate.mjs';
import { pickPort } from '../dev/port.mjs';

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

const OUT_DEFAULT = path.join(os.homedir(), 'Downloads', '知乎');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 报错前缀拆开：esbuild 会把 'a'+'b' 折叠成 'ab'，所以用数组 join 阻断
const CDP_MSG = ['C', 'D', 'P', ' ', 't', 'i', 'm', 'e', 'o', 'u', 't', ':', ' '].join('');
const log = (...a) => console.log(...a);
const warn = (...a) => console.error('[warn]', ...a);

// ─────────────────────────── 工具 ───────────────────────────
/**
 * 把 Markdown 里的远程图片下载到本地 `{baseName}.assets/`，
 * 并把 `![](https://...)` 改写成相对路径 `![](./xxx.assets/img_001.jpg)`。
 *
 * 为什么要做：只写 URL 的话，断网/换目录/发给别人，图片全丢。
 * 失败的单张保留原链接，不中断整篇。
 */
async function localizeImages(md, outDir, baseName, referer, opts = {}) {
  const urls = [];
  const re = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;
  let m;
  while ((m = re.exec(md)) !== null) urls.push(m[1]);

  const uniq = [...new Set(urls)];
  if (!uniq.length) return { md, ok: 0, fail: 0 };

  const assetsName = `${baseName}.assets`;
  const assetsDir = path.join(outDir, assetsName);
  await fsp.mkdir(assetsDir, { recursive: true });

  const map = new Map();
  let ok = 0, fail = 0, bytes = 0;

  for (let i = 0; i < uniq.length; i++) {
    const url = uniq[i];
    // 先按 URL 后缀猜一个，下载完成后按真实字节校正（知乎 .jpg 常是 PNG/WebP）
    const guessExt = extOf(url, 'jpg');
    const seq = String(i + 1).padStart(3, '0');
    let name = `img_${seq}.${guessExt}`;
    let dest = path.join(assetsDir, name);

    try {
      const r = await downloadFile(url, dest, referer || 'https://zhuanlan.zhihu.com/');
      if (r.ext && r.ext !== guessExt) {
        const realName = `img_${seq}.${r.ext}`;
        const realDest = path.join(assetsDir, realName);
        try {
          await fsp.rename(dest, realDest);
          name = realName;
          dest = realDest;
        } catch { /* 改名失败就保留原名 */ }
      }
      map.set(url, `./${assetsName}/${name}`);
      ok++; bytes += r.bytes;
      if (!opts.quiet) process.stderr.write(`\r    图片 ${i + 1}/${uniq.length}  ✓ ${fmtSize(bytes)}   `);
    } catch (e) {
      fail++;
      if (!opts.quiet) process.stderr.write(`\r    图片 ${i + 1}/${uniq.length}  ✗ ${String(e.message).slice(0, 28)}   `);
    }
    // 温和限速，避免被知乎判定为爬虫
    await sleep(120);
  }
  if (!opts.quiet && uniq.length) process.stderr.write('\n');

  // 失败时 map 里没有该 URL，原样保留远程链接
  const outMd = md.replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (full, alt, url) => {
    const local = map.get(url);
    return local ? `![${alt}](${local})` : full;
  });

  return { md: outMd, ok, fail, bytes };
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

function safeName(s, max = 100) {
  return String(s || 'zhihu')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max) || 'zhihu';
}

function fmtSize(b) {
  if (b > 1024 ** 2) return (b / 1024 ** 2).toFixed(2) + ' MB';
  return (b / 1024).toFixed(1) + ' KB';
}

function extractUrls(text) {
  const out = [];
  const re = /https?:\/\/[^\s"'<>，。、；）)]+/g;
  for (const m of text.matchAll(re)) {
    const u = m[0].replace(/[.,;)]+$/, '');
    if (/zhihu\.com|zhuanlan\.zhihu\.com/.test(u)) out.push(u);
  }
  return out;
}

function parseArticleId(url) {
  const m = url.match(/\/p\/(\d+)/);
  if (m) return { kind: 'article', id: m[1] };
  const a = url.match(/\/answer\/(\d+)/);
  if (a) return { kind: 'answer', id: a[1] };
  const q = url.match(/\/question\/(\d+)/);
  if (q) return { kind: 'question', id: q[1] };
  // 专栏有两种地址形态，都要认（实测 2026-10-28）：
  //   1) https://zhuanlan.zhihu.com/<slug>       旧版
  //   2) https://www.zhihu.com/column/c_<数字>    现行版
  // 只写第 1 种时，第 2 种会被当成普通页面去抓，
  // 表现为「待处理 1 篇」—— 抓的是专栏首页本身，不是文章列表。
  const c1 = url.match(/zhuanlan\.zhihu\.com\/(?!p\/)([A-Za-z0-9_-]+)/);
  if (c1) return { kind: 'column', id: c1[1] };
  const c2 = url.match(/zhihu\.com\/column\/([A-Za-z0-9_-]+)/);
  if (c2) return { kind: 'column', id: c2[1] };
  return null;
}

// ─────────────────────── 极简 CDP 客户端 ───────────────────────
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
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      // 超时定时器必须 unref + 收到响应时 clearTimeout：
      // 否则每次 CDP 调用都会往事件循环里挂一个 60 秒的把手，
      // 任务早就干完了，Node 还要空转整整 60 秒才肯退出 ——
      // UI 线程卡在 WaitForExit()，进度条就停在起点不动（曾被误判为"卡死"）。
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(CDP_MSG + method));
      }, 60000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
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
        // 这里的 open 超时同样要 unref，否则连接成功后定时器还在跑
        const timer = setTimeout(() => rej(new Error('ws timeout')), 3000);
        timer.unref();
        ws.addEventListener('open', () => { clearTimeout(timer); res(); }, { once: true });
        ws.addEventListener('error', (e) => { clearTimeout(timer); rej(e); }, { once: true });
      });
      return ws;
    } catch {
      await sleep(200);
    }
  }
  throw new Error('无法连接 CDP');
}

async function launchChrome({ headful = false, chromePath, port = 9444, profileDir: fixed } = {}) {
  // 9444 目前没撞上保留段，但用户机器上的保留段是变的 —— 一样做探测。
  // 见 dev/port.mjs。
  port = await pickPort(port, warn);
  const exe = chromePath || findChrome();
  const profileDir = fixed
    ? (fs.mkdirSync(fixed, { recursive: true }), fixed)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'zhmd-'));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-features=Translate,MediaRouter',
    '--mute-audio',
    '--disable-blink-features=AutomationControlled',
    '--exclude-switches=enable-automation',
    '--lang=zh-CN',
    `--user-agent=${UA_DESKTOP}`,
    'about:blank',
  ];
  if (!headful) args.unshift('--headless=new');

  const proc = spawn(exe, args, { stdio: 'ignore', windowsHide: !headful });

  let wsUrl = null;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      const j = await r.json();
      wsUrl = j.webSocketDebuggerUrl;
      if (wsUrl) break;
    } catch {}
    await sleep(150);
  }
  if (!wsUrl) { try { proc.kill(); } catch {} throw new Error('Chrome 调试端口未就绪'); }

  const ws = await waitForWs(wsUrl);
  return { proc, cdp: new CDP(ws), profileDir, exe };
}

async function newPage(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);
  // 抹掉无头特征
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN','zh','en'] });
      window.chrome = window.chrome || { runtime: {} };
    `,
  }, sessionId);
  if (url) await cdp.send('Page.navigate', { url }, sessionId);
  return { targetId, sessionId };
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

// ─────────────── 页面内：DOM → Markdown ───────────────
// 这段在浏览器里跑，返回 {title, author, content, meta}
function extractScript() {
  return `(() => {
    const pick = (sels) => { for (const s of sels) { const e = document.querySelector(s); if (e) return e; } return null; };
    const FENCE = String.fromCharCode(96, 96, 96);

    // 判定是否被风控
    const bodyText = (document.body && document.body.innerText) || '';
    if (bodyText.includes('请求存在异常') || bodyText.includes('"code":40362')) {
      return { __blocked: true, reason: 'IP 风控 (40362)', head: bodyText.slice(0, 200) };
    }
    if (bodyText.includes('请登录后查看') || bodyText.includes('登录后继续')) {
      return { __blocked: true, reason: '需要登录', head: bodyText.slice(0, 200) };
    }

    const root = pick([
      '.Post-RichTextContainer .RichText',
      '.Post-RichText',
      'article .RichText',
      '.RichText',
      '.QuestionAnswer-content',
      'article'
    ]);
    if (!root) {
      return { __blocked: true, reason: '未找到正文容器', head: bodyText.slice(0, 300) };
    }

    const title = (pick(['h1.Post-Title', '.Post-Title', 'h1.QuestionHeader-title', 'h1']) || {}).innerText || document.title || '';
    const author = (pick(['.AuthorInfo-name', '.Post-Author .AuthorInfo-name', '.UserLink-link']) || {}).innerText || '';

    // ---- DOM → MD ----
    const esc = (t) => String(t || '').replace(/\\n{3,}/g, '\\n\\n');

    function inline(el) {
      let out = '';
      for (const n of el.childNodes) {
        if (n.nodeType === 3) { out += n.textContent; continue; }
        if (n.nodeType !== 1) continue;
        const tag = n.tagName.toLowerCase();
        const inner = inline(n);
        switch (tag) {
          case 'strong': case 'b': out += inner.trim() ? '**' + inner + '**' : inner; break;
          case 'em': case 'i': out += inner.trim() ? '*' + inner + '*' : inner; break;
          case 'del': case 's': out += inner.trim() ? '~~' + inner + '~~' : inner; break;
          case 'code': out += String.fromCharCode(96) + inner + String.fromCharCode(96); break;
          case 'a': {
            const href = n.getAttribute('href') || '';
            const abs = href.startsWith('//') ? 'https:' + href : href;
            // 知乎站内搜索/话题跳转链接又长又没用，只保留文字
            const isJunk = abs.indexOf('zhida.zhihu.com/search') >= 0
              || abs.indexOf('link.zhihu.com/?target=') >= 0
              || abs.indexOf('www.zhihu.com/search') >= 0;
            if (isJunk) { out += inner; break; }
            out += inner.trim() ? '[' + inner + '](' + abs + ')' : abs;
            break;
          }
          case 'br': out += '  \\n'; break;
          case 'img': {
            const src = n.getAttribute('data-original') || n.getAttribute('data-actualsrc') || n.getAttribute('src') || '';
            const abs = src.startsWith('//') ? 'https:' + src : src;
            const alt = n.getAttribute('alt') || '';
            out += abs ? '\\n\\n![' + alt + '](' + abs + ')\\n\\n' : '';
            break;
          }
          case 'sup': out += '^' + inner + '^'; break;
          case 'sub': out += '~' + inner + '~'; break;
          default: out += inner;
        }
      }
      return out;
    }

    function block(el, depth) {
      let md = '';
      for (const n of el.children) {
        const tag = n.tagName.toLowerCase();
        switch (tag) {
          case 'h1': md += '\\n# ' + inline(n).trim() + '\\n\\n'; break;
          case 'h2': md += '\\n## ' + inline(n).trim() + '\\n\\n'; break;
          case 'h3': md += '\\n### ' + inline(n).trim() + '\\n\\n'; break;
          case 'h4': md += '\\n#### ' + inline(n).trim() + '\\n\\n'; break;
          case 'h5': md += '\\n##### ' + inline(n).trim() + '\\n\\n'; break;
          case 'h6': md += '\\n###### ' + inline(n).trim() + '\\n\\n'; break;
          case 'p': {
            const t = inline(n).trim();
            if (t) md += t + '\\n\\n';
            break;
          }
          case 'blockquote': {
            const t = block(n, depth + 1).trim().split('\\n').map(l => '> ' + l).join('\\n');
            md += t + '\\n\\n';
            break;
          }
          case 'ul': case 'ol': {
            const ordered = tag === 'ol';
            let i = 1;
            for (const li of n.children) {
              if (li.tagName.toLowerCase() !== 'li') continue;
              const marker = ordered ? (i++) + '. ' : '- ';
              const inner = block(li, depth + 1).trim() || inline(li).trim();
              const lines = inner.split('\\n');
              md += marker + lines[0] + '\\n';
              for (let k = 1; k < lines.length; k++) {
                md += '  ' + lines[k] + '\\n';
              }
            }
            md += '\\n';
            break;
          }
          case 'pre': {
            const codeEl = n.querySelector('code') || n;
            const lang = (codeEl.className.match(/language-([\\w+-]+)/) || [])[1] || '';
            md += '\\n' + FENCE + lang + '\\n' + codeEl.textContent.replace(/\\n+$/, '') + '\\n' + FENCE + '\\n\\n';
            break;
          }
          case 'figure': case 'div': {
            const img = n.querySelector('img');
            if (img && !n.querySelector('p, h2, h3, li')) {
              const src = img.getAttribute('data-original') || img.getAttribute('data-actualsrc') || img.getAttribute('src') || '';
              const abs = src.startsWith('//') ? 'https:' + src : src;
              if (abs) md += '![' + (img.getAttribute('alt') || '') + '](' + abs + ')\\n\\n';
            } else {
              md += block(n, depth + 1);
            }
            break;
          }
          case 'table': {
            const rows = [...n.querySelectorAll('tr')];
            if (rows.length) {
              rows.forEach((tr, ri) => {
                const cells = [...tr.children].map(td => inline(td).trim().replace(/\\|/g, '\\\\|'));
                md += '| ' + cells.join(' | ') + ' |\\n';
                if (ri === 0) md += '|' + cells.map(() => ' --- ').join('|') + '|\\n';
              });
              md += '\\n';
            }
            break;
          }
          case 'hr': md += '\\n---\\n\\n'; break;
          case 'br': md += '\\n'; break;
          default: {
            const t = inline(n).trim();
            if (t) md += t + '\\n\\n';
            else md += block(n, depth + 1);
          }
        }
      }
      return md;
    }

    const content = block(root, 0).replace(/\\n{3,}/g, '\\n\\n').trim();
    const imgs = root.querySelectorAll('img').length;

    return {
      title: title.trim(),
      author: author.trim(),
      content,
      stats: { chars: content.length, images: imgs },
      url: location.href
    };
  })()`;
}

// ─────────────── 专栏批量 ───────────────
/**
 * 页面内脚本：从专栏页抓文章列表。
 *
 * ── 为什么在页面里抓，不用 API ──
 *   知乎专栏有接口（/api/v4/columns/<slug>/items），但需要 `x-zse-96`
 *   签名，算法随版本变。用真浏览器渲染好的 DOM 反而稳 ——
 *   专栏列表页本来就把文章链接渲染出来了。
 *
 * ── 为什么选择器写这么多兜底 ──
 *   知乎前端改版频繁，class 名换过好几轮（Column-ArticleCard / ArticleItem /
 *   ContentItem 都出现过）。这里同时按**结构特征**兜底：
 *   只要 `a[href*="/p/"]` 且能取到标题，就当文章链接。
 */
function columnListScript() {
  return `(() => {
    const out = [];
    const seen = new Set();

    const links = document.querySelectorAll(
      'a[href*="/p/"], .Column-ArticleCard a, .ArticleItem a, .ContentItem a'
    );

    for (const a of links) {
      const href = a.href || '';
      // ⚠ 这段在**模板字符串**里，会被 JS 解析一次再交给浏览器。
      //   所以**所有反斜杠都要双写**：
      //     模板里 \\/  → 浏览器看到 \/   （转义斜杠，避免提前结束正则）
      //     模板里 \\.  → 浏览器看到 \.   （字面点，否则匹配任意字符）
      //     模板里 \\d  → 浏览器看到 \d   （数字，否则匹配字母 d）
      //   只写单反斜杠会被模板解析吃掉，实测表现为：
      //     SyntaxError: Invalid regular expression flags
      //   而报错又被外层 try/catch 吞了，界面上只看到"没找到文章链接"，
      //   极难定位。这个坑我踩了两次（先过度转义、再转义不足）。
      const m = href.match(/zhuanlan\\.zhihu\\.com\\/p\\/(\\d+)/);
      if (!m) continue;
      const id = m[1];
      if (seen.has(id)) continue;

      let title = (a.innerText || a.textContent || '').trim();
      if (!title || title.length < 2) {
        const box = a.closest('.Column-ArticleCard, .ArticleItem, .ContentItem, li, article');
        if (box) {
          const h = box.querySelector('h2, h3, .Title, .ContentItem-title');
          if (h) title = (h.innerText || '').trim();
        }
      }
      if (/^(阅读全文|查看全文|更多|展开)$/.test(title)) title = '';

      seen.add(id);
      out.push({ id, url: 'https://zhuanlan.zhihu.com/p/' + id, title: title || ('p/' + id) });
    }

    const nextBtn = document.querySelector(
      'button.PaginationButton-next, .Pagination button:last-child, button[aria-label="下一页"]'
    );
    const hasNext = !!(nextBtn && !nextBtn.disabled);

    return {
      items: out,
      hasNext,
      columnTitle: (document.querySelector('h1, .ColumnHeader-title') || {}).innerText || document.title || '',
      url: location.href
    };
  })()`;
}

/**
 * 展开专栏：翻页收集所有文章链接。
 * @returns {Promise<Array<{id,url,title}>>}
 */
async function expandColumn(ctx, rawUrl, opts) {
  const base = rawUrl.split('?')[0].replace(/\/$/, '');
  const maxPages = Math.max(1, Number(opts.columnPages) || 20);
  const all = [];
  const seen = new Set();

  for (let page = 1; page <= maxPages; page++) {
    const pageUrl = page === 1 ? base : `${base}?page=${page}`;
    log(`  专栏第 ${page} 页…`);

    const { sessionId } = await newPage(ctx.cdp, pageUrl);
    await sleep(opts.waitMs);

    let data = null;
    for (let i = 0; i < 3; i++) {
      try {
        data = await evaluate(ctx.cdp, sessionId, columnListScript());
        if (data && data.items && data.items.length) break;
        if (data && data.__blocked) {
          if (opts.headful && i === 0) await sleep(20000);
          else await sleep(3000 + i * 2000);
          await ctx.cdp.send('Page.navigate', { url: pageUrl }, sessionId);
          await sleep(opts.waitMs);
        }
      } catch { await sleep(1500); }
    }

    if (!data || !data.items || !data.items.length) {
      if (page === 1) throw new Error('专栏页没找到文章链接（可能需要登录，或该专栏为空）');
      log(`    本页没有文章，视为最后一页`);
      break;
    }

    let added = 0;
    for (const it of data.items) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      all.push(it);
      added++;
    }
    log(`    新增 ${added} 篇（累计 ${all.length} 篇）`);

    // 没有新增 = 翻页没生效（知乎有时忽略 page 参数），别空转
    if (added === 0) { log(`    本页无新文章，停止翻页`); break; }
    if (!data.hasNext) { log(`    已到最后一页`); break; }
    await sleep(1200);
  }

  return all;
}

// ─────────────── 单篇处理 ───────────────
async function handleOne(rawUrl, opts, ctx) {
  log(`\n━━━ ${rawUrl}`);

  const info = parseArticleId(rawUrl);
  if (!info) throw new Error('不是知乎文章/回答链接');

  const { sessionId } = await newPage(ctx.cdp, rawUrl);
  await sleep(opts.waitMs);

  // 尝试提取，最多重试 3 轮（JS 挑战需要时间）
  let data = null;
  let lastReason = '';
  for (let i = 0; i < 3; i++) {
    try {
      data = await evaluate(ctx.cdp, sessionId, extractScript());
      if (data && !data.__blocked) break;
      lastReason = data?.reason || 'unknown';
      if (data?.__blocked) {
        log(`  第 ${i + 1} 轮: ${data.reason}`);
        if (opts.headful && i === 0) {
          log('  窗口已打开，请手动完成验证/登录（等待 25 秒）...');
          await sleep(25000);
        } else {
          await sleep(4000 + i * 3000);
        }
        await ctx.cdp.send('Page.navigate', { url: rawUrl }, sessionId);
        await sleep(opts.waitMs);
      }
    } catch (e) {
      lastReason = e.message;
      await sleep(2000);
    }
  }

  if (!data || data.__blocked) {
    throw new Error(`抓取失败: ${data?.reason || lastReason}${data?.head ? ' | ' + String(data.head).slice(0, 120) : ''}`);
  }

  const title = data.title || `zhihu_${info.id}`;
  const baseName = safeName(`${title}_${info.id}`, 90);

  // 组装 Markdown
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const header = [
    `# ${title}`,
    '',
    `> 来源: ${rawUrl}`,
    data.author ? `> 作者: ${data.author}` : null,
    `> 抓取时间: ${now}`,
    `> 字数: ${data.stats.chars}　图片: ${data.stats.images}`,
    '',
    '---',
    '',
  ].filter((x) => x !== null).join('\n');

  let body = header + data.content + '\n';

  // 图片本地化：默认开启，--no-images 可关闭
  // 老版本只把 https://pic1.zhimg.com/... 写进 Markdown，断网即失效，这里补上真实下载。
  let imgStat = { ok: 0, fail: 0, bytes: 0 };
  if (!opts.noImages && data.stats && data.stats.images > 0) {
    log(`  下载图片 ${data.stats.images} 张 → ${baseName}.assets/`);
    try {
      const r = await localizeImages(body, opts.out, baseName, rawUrl);
      body = r.md;
      imgStat = r;
      log(`  ✓ 图片 ${r.ok} 张 (${fmtSize(r.bytes)})${r.fail ? `，失败 ${r.fail}` : ''}`);
    } catch (e) {
      warn(`  图片本地化失败（保留远程链接）: ${e.message}`);
    }
  }

  // 输出格式：默认 md；可一次导出多种
  const formats = (opts.formats && opts.formats.length) ? opts.formats : ['md'];
  const meta = {
    title,
    author: data.author,
    source: rawUrl,
    capturedAt: now,
    stats: data.stats,
  };

  const written = [];
  for (const f of formats) {
    if (!['md', 'txt', 'docx'].includes(f)) {
      warn(`  未知格式 ${f}，跳过（支持 md/txt/docx）`);
      continue;
    }
    try {
      const r = await exportAs(f, body, opts.out, baseName, meta);
      written.push(r);
      log(`  ✓ ${path.basename(r.dest)}  (${fmtSize(r.bytes)})`);
    } catch (e) {
      warn(`  导出 ${f} 失败: ${e.message}`);
    }
  }

  if (!written.length) throw new Error('所有格式都导出失败');

  log(`    字数 ${data.stats.chars}  图片 ${data.stats.images}`);
  for (const w of written) log(`    ${w.dest}`);

  return {
    title,
    dest: written[0].dest,
    files: written.map(w => w.dest),
    formats: written.map(w => w.format),
    chars: data.stats.chars,
    images: data.stats.images,
    imagesLocalized: imgStat.ok,
    imagesFailed: imgStat.fail,
    assetsDir: imgStat.ok ? path.join(opts.out, `${baseName}.assets`) : null,
    author: data.author,
  };
}

// ─────────────── CLI ───────────────
function parseArgs(argv) {
  const opts = {
    out: OUT_DEFAULT,
    headful: false,
    jsonOnly: false,
    waitMs: 6000,
    chromePath: null,
    port: 9444,
    profileDir: path.join(os.homedir(), '.zhihu-md-profile'),
    keepProfile: true,
    formats: null,   // ['md'] | ['docx','txt'] | ... 默认 md
    noImages: false, // true = 不下载图片，只保留远程链接
    listOnly: false,   // 专栏展开后只列清单不下载
    columnPages: 20,   // 专栏最多翻多少页
  };
  const urls = [];
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-o': case '--out': opts.out = argv[++i]; break;
      case '--headful': opts.headful = true; break;
      case '--json': opts.jsonOnly = true; break;
      case '--wait': opts.waitMs = Number(argv[++i]) || 6000; break;
      case '--chrome': opts.chromePath = argv[++i]; break;
      case '--port': opts.port = Number(argv[++i]) || 9444; break;
      case '--profile': opts.profileDir = argv[++i]; break;
      case '--fresh': opts.keepProfile = false; break;
      case '--no-images': opts.noImages = true; break;
      case '--list': opts.listOnly = true; break;
      case '--column-pages': opts.columnPages = Number(argv[++i]) || 20; break;
      case '--images': opts.noImages = false; break;
      case '-f': case '--format': {
        const v = String(argv[++i] || '').toLowerCase();
        if (!opts.formats) opts.formats = [];
        for (const x of v.split(/[,\s]+/)) {
          const f = x.replace(/^\./, '');
          if (f && !opts.formats.includes(f)) opts.formats.push(f);
        }
        break;
      }
      case '-h': case '--help': opts.help = true; break;
      default:
        if (a.startsWith('-')) warn(`未知参数: ${a}`);
        else positional.push(a);
    }
  }
  for (const p of positional) {
    const found = extractUrls(p);
    if (found.length) urls.push(...found);
    else if (/zhihu\.com/.test(p)) urls.push(p);
  }
  return { opts, urls };
}

function printHelp() {
  console.log(`
知乎文章 → Markdown

用法:
  node zhihu-md.mjs <知乎链接> [更多...] [选项]

选项:
  -o, --out <dir>     输出目录 (默认 ~/Downloads/知乎)
  -f, --format <list> 输出格式: md | txt | docx，可逗号组合 (默认 md)
                      例: --format docx   或  --format md,txt,docx
      --headful       显示浏览器窗口（首次过验证/登录用）
      --wait <ms>     页面加载等待，默认 6000
      --profile <dir> 浏览器 profile 目录（可指向你自己的 Chrome 登录态）
      --fresh         不持久化 profile
      --chrome <path> 指定 Chrome/Edge
      --port <n>      CDP 端口，默认 9444
      --json          只输出元数据
      --no-images     不下载图片，Markdown 里只保留远程链接
      --images        下载图片到 {文件名}.assets/（默认行为）
  -h, --help          帮助

支持的链接:
  zhuanlan.zhihu.com/p/xxxx          专栏文章
  www.zhihu.com/question/xxx/answer/xxx  回答

示例:
  node zhihu-md.mjs "https://zhuanlan.zhihu.com/p/647813179"
  node zhihu-md.mjs "https://zhuanlan.zhihu.com/p/xxx" -o D:\\notes
  node zhihu-md.mjs "https://zhuanlan.zhihu.com/p/xxx" --headful
`);
}

async function main() {
  const { opts, urls } = parseArgs(process.argv.slice(2));
  if (opts.help || !urls.length) { printHelp(); process.exit(opts.help ? 0 : 1); }

  // 目录建不出来时给能照做的提示，而不是裸 ENOENT/EPERM。
  // 实测：`-o /tmp/x` 在 Git-Bash 里会被转成 C:\Windows\x，
  // 报 "ENOENT: no such file or directory, mkdir '\\?'" —— 完全看不懂。
  try {
    await fsp.mkdir(opts.out, { recursive: true });
  } catch (e) {
    throw new Error(
      `无法创建输出目录：${opts.out}\n` +
      `     原因：${e.code || e.message}\n` +
      `     处理：换一个你有写权限的目录，例如 -o "D:\\笔记" 或 -o "%USERPROFILE%\\Downloads"`
    );
  }
  log(`输出目录: ${opts.out}`);

  let ctx;
  const results = [];
  let failed = 0;
  try {
    log('启动浏览器...');
    ctx = await launchChrome({
      headful: opts.headful,
      chromePath: opts.chromePath,
      port: opts.port,
      profileDir: opts.keepProfile ? opts.profileDir : undefined,
    });
    log('浏览器就绪 ✓');

    // 先展开所有专栏（一个链接可能是 N 篇），再逐篇处理。
    // 放在浏览器启动之后 —— 展开需要真浏览器渲染列表页。
    const jobs = [];
    for (const u of urls) {
      const info = parseArticleId(u);
      if (info && info.kind === 'column') {
        log(`\n━━━ 专栏: ${u}`);
        try {
          const items = await expandColumn(ctx, u, opts);
          if (!items.length) { failed++; warn(`✗ ${u}\n    专栏里没抓到文章`); continue; }
          log(`  ✓ 共 ${items.length} 篇，开始逐篇导出`);
          for (const it of items) jobs.push(it.url);
        } catch (e) {
          failed++;
          warn(`✗ ${u}\n    ${e.message}`);
        }
      } else {
        jobs.push(u);
      }
    }

    if (opts.listOnly) {
      log(`\n━━━ 待处理 ${jobs.length} 篇 ━━━`);
      jobs.forEach((u, i) => log(`  ${i + 1}. ${u}`));
      return;
    }

    for (let i = 0; i < jobs.length; i++) {
      const u = jobs[i];
      if (jobs.length > 1) log(`\n[${i + 1}/${jobs.length}]`);
      try {
        results.push(await handleOne(u, opts, ctx));
      } catch (e) {
        failed++;
        warn(`✗ ${u}\n    ${e.message}`);
      }
    }

    log('\n━━━ 汇总 ━━━');
    for (const r of results) log(`• ${r.title}  →  ${r.chars} 字 / ${r.images} 图\n  ${r.dest}`);
    if (failed) log(`\n失败 ${failed} 篇`);
    if (opts.jsonOnly) console.log(JSON.stringify(results, null, 2));
    process.exitCode = failed ? 1 : 0;
  } finally {
    if (ctx) {
      try { await ctx.cdp.send('Browser.close'); } catch {}
      try { ctx.cdp.close(); } catch {}
      try { ctx.proc.kill(); } catch {}
      await sleep(500);
      if (!opts.keepProfile) {
        try { await fsp.rm(ctx.profileDir, { recursive: true, force: true }); } catch {}
      }
    }
    // 兜底：CDP 的 unref/clearTimeout 已经把正常的空转堵掉了，这里再补一道保险。
    // 单文件引擎跑完必须立刻退，绝不能因为事件循环里还挂着把手而空转 60 秒
    // ——那会让 UI 的 WaitForExit() 一直不返回，进度条看起来就是"卡死"。
    if (!opts.stayAlive) await flushAndExit(process.exitCode || 0);
  }
}

/**
 * 等 stdout/stderr 排空后再退出。
 * 直接 process.exit() 会截断管道里的异步写入（UI 日志会少最后几行）。
 */
function flushAndExit(code) {
  return new Promise((resolve) => {
    let pending = 2;
    const done = () => { if (--pending <= 0) { process.exit(code); } };
    try { process.stdout.write('', done); } catch { done(); }
    try { process.stderr.write('', done); } catch { done(); }
    // 写回调没回来时的保险（例如流已销毁）
    const t = setTimeout(() => process.exit(code), 800);
    t.unref();
    resolve();
  });
}

// ─────────────────────────── 入口 ───────────────────────────
export async function run() {
  // 功能闸门：**每个引擎自己验**，不信任上游 cli 的那一个 if。
  // 改 cli.mjs 里的 if (!activated) 只能骗过 cli，到这里照样被拦。
  assertFeature('zhihu');
  await main();
}

function isDirectRun() {
  try {
    const entry = process.argv[1] || '';
    return /zhihu-md(\.mjs)?$/i.test(entry) || entry === '';
  } catch { return false; }
}

if (isDirectRun()) {
  main().catch((e) => {
    console.error('\n[致命]', e.message);
    process.exit(1);
  });
}
