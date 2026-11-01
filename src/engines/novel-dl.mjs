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
 *
 * ═══════════════════════════════════════════════════════════════
 * 支持的站点（2026-11-01 实测）
 * ═══════════════════════════════════════════════════════════════
 *
 * biquge365.net   全免费，章节多，无反爬。主力站点。
 *                 书籍 /book/{id}/  目录 /newbook/{id}/  章节 /chapter/{id}/{cid}.html
 *
 * 17k.com         大站，无反爬，但**只有前几章免费**。
 *                 书籍 /book/{id}.html  目录 /list/{id}.html  章节 /chapter/{id}/{cid}.html
 *                 VIP 章节页面里写「VIP章节, 余下还有 N 个段落」，正文容器不存在。
 *                 程序会把这类章标记成 ⊘ 付费章节 并跳过，
 *                 最后统一提示「这 N 章是付费章节，不是程序问题」。
 *
 * ── 探测过但放弃的 ──
 *
 * b520.cc         href 全写死成 "/"，真实链接靠 JS 后填；
 *                 且响应经常超 30 秒，服务器本身就慢。投入产出比太低。
 * xbiquge.la      HTTPS 证书过期
 * biquku.la       HTTPS 证书过期
 * biqu5200.net    证书根不受信
 * biqugse.com     连接超时
 * beqege.cc       403
 * fanqienovel     301 跳转 + 字体混淆(686 PUA) + a_bogus + msToken，约 7 天工作量
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
 *
 * ═══════════════════════════════════════════════════════════════
 * 字段约定（v1.3.0 扩展后）
 * ═══════════════════════════════════════════════════════════════
 *
 * name          显示名
 * hosts         域名匹配（endsWith 也算）
 *
 * ── 路径规则（两种写法，任选）──
 *
 *   写法 A：固定模板（原有，够用时优先）
 *     bookIdFrom    /\/(?:book|newbook)\/(\d+)\/?/
 *     catalog       (id) => url
 *     chapterHref   /^\/chapter\/(\d+)\/(\d+)\.html$/
 *
 *   写法 B：目录页里直接带完整链接（17k 这种）
 *     catalog       (id) => url
 *     chapterHref   /^\/chapter\/(\d+)\/(\d+)\.html$/
 *     bookIdFrom    同上
 *     → 只要 chapterHref 能匹配上目录页里的绝对路径，写法 A/B 是一样的。
 *
 * ── 解析规则 ──
 *
 *   contentSelector  正文容器的正则（必须带一个捕获组）
 *   titleSelector    标题正则（带一个捕获组）
 *   pSplit           true = 正文按 <p> 分段（17k 是 <div class="p">）
 *
 * ── 已验证的站点（2026-11-01 实测，均无反爬）──
 *
 *   biquge365.net  纯 HTML，无字体混淆
 *   17k.com        纯 HTML，1143 章目录一次拿全，正文在 #readArea .p
 *   bqg70.com      纯 HTML，目录 112 章，正文 id="content"
 *   xbiquge.bz     纯 HTML，结构与 bqg70 同源
 *
 * ── 探测过但放弃的 ──
 *
 *   b520.cc        href 全写死成 "/"，真实链接靠 JS 后填；且响应常超 30 秒
 *   xbiquge.la     HTTPS 证书过期
 *   biquku.la      HTTPS 证书过期
 *   biqu5200.net   证书根不受信
 *   biqugse.com    连接超时
 *   beqege.cc      403
 *   fanqienovel    301 跳转，且字体混淆 + a_bogus + msToken（约 7 天工作量）
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
  {
    // 17k：目录页 /list/{bookId}.html，章节 /chapter/{bookId}/{cid}.html
    // 正文在 <div id="readArea">，段落是 <div class="p">，不是 <p>
    name: '17k',
    hosts: ['17k.com', 'www.17k.com'],
    bookIdFrom: /\/(?:book|list)\/(\d+)\.html/,
    catalog: (id) => `https://www.17k.com/list/${id}.html`,
    chapterHref: /^\/chapter\/(\d+)\/(\d+)\.html$/,
    contentSelector: /<div[^>]*class="readArea"[\s\S]*?<div[^>]*class="p"[^>]*>([\s\S]*?)<\/div>/i,
    titleSelector: /<h1[^>]*>([\s\S]*?)<\/h1>/i,
    // 17k 的段落是 div.p，parseChapter 要按这个切
    paraSplit: /<div[^>]*class="p"[^>]*>([\s\S]*?)<\/div>/gi,
    // 章节页需要 Referer，否则可能 403
    needReferer: true,
    // 目录页里的链接是绝对路径 /chapter/xxx/yyy.html
    catalogAbsolute: true,
  },
  {
    // bqg70 / xbiquge.bz 同一套模板（笔趣阁系镜像）：
    //   书籍 /book/{id}/        章节 /book/{id}/{cid}.html
    //   正文 <div id="content">
    // ⚠ 目录结构与 biquge365 相反：<dd> 在 <a> **里面**
    //     <a href="/book/200698/95494720.html"><dd>第858章 xxx</dd></a>
    //   所以 parseCatalog 不能只看 <a> 的 textContent，
    //   要去掉内层标签再 clean（现有实现有 stripTags，能兼容）。
    name: 'bqg70',
    hosts: ['bqg70.com', 'www.bqg70.com', 'xbiquge.bz', 'www.xbiquge.bz'],
    bookIdFrom: /\/book\/(\d+)\/?/,
    // 书籍页本身就是完整目录。用 origin 拼，两个镜像域名都能用。
    // 实际访问域名由 downloadBook 传入（见 catalogWithOrigin）。
    catalog: (id, u) => `https://${u.hostname}/book/${id}/`,
    chapterHref: /^\/book\/(\d+)\/(\d+)\.html$/,
    contentSelector: /<div[^>]*id="content"[^>]*>([\s\S]*?)<\/div>/i,
    // ⚠ 两个镜像站的标题位置不一样：
    //   bqg70  : <h1 class="bookname">第858章 只是当时已惘然</h1>   ← h1 正确
    //   xbiquge: <h1><a href="/">新笔趣阁</a></h1>                  ← h1 是 Logo
    //            真标题在 <h3>（正文区上方）或 <h2> 面包屑末尾
    // 用 bookname class 优先，退回 h3 含「第N章」的
    titleSelector: /<h1[^>]*class="bookname"[^>]*>([\s\S]*?)<\/h1>|<h3[^>]*>([\s\S]*?第[\d一二三四五六七八九十百千万]+章[\s\S]*?)<\/h3>/i,
    // 标题里常带「（第1页）」分页标记，要去掉
    titleClean: /（第\s*\d+\s*页）|\(第\s*\d+\s*页\)/g,
    needReferer: true,
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

async function fetchText(url, { referer, retries = 4, timeout = 45000 } = {}) {
  // 默认拿站点根作 Referer。17k 这类站点对无 Referer 的章节页会 403，
  // 但给根域就够（不用给具体目录页 URL）。
  const origin = referer
    || (() => { try { return new URL(url).origin + '/'; } catch { return undefined; } })();
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
  // selector 可能有两个捕获组（h1.bookname | h3），取第一个非空的
  const rawTitle = titleM ? (titleM[1] || titleM[2] || '') : '';
  let title = clean(String(rawTitle).replace(/<[^>]+>/g, ''));

  // 先解码 HTML 实体（&gt; / &amp; 等），再做面包屑切割。
  // 顺序错了会切不动 —— 实测：&gt; 不进 split('>')。
  title = title
    .replace(/&gt;/gi, '>')
    .replace(/&lt;/gi, '<')
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ');

  // 去掉「（第1页）」这类分页标记
  if (site.titleClean) title = clean(title.replace(site.titleClean, ''));

  // h2 面包屑形式：「新笔趣阁 > 书名 > 第1章 xxx」，取最后一个 > 之后
  if (title.includes('>')) {
    const seg = title.split('>').map((x) => x.trim()).filter(Boolean);
    if (seg.length > 1) title = seg[seg.length - 1];
  }
  title = clean(title);

  // ── base64 正文（bqg70 / xbiquge 这类）──
  //
  // 实测页面结构（2026-11-01）：
  //   <div id="booktxt">
  //     <script>document.writeln(srtb.du('PHA+56ysODU456ug...'))</script>
  //     <script>document.writeln(apb.kvyee('PHA+5byC6YeR...'))</script>
  //   </div>
  //
  // ⚠ 函数名是**随机生成的**，同一个 URL 两次请求可能拿到
  //     srtb.du / apb.kvyee / 别的名字。只认固定函数名会漏。
  //   所以正则只匹配「document.writeln(任意前缀.任意函数名('base64'))」。
  //
  // 正文被切成 N 段，每段 base64 编码后塞进 document.writeln。
  // 直接 stripTags 只能拿到「本章未完，点击下一页继续阅读」。
  //
  // 解法：抓出所有 base64 段，解码，拼起来当成 HTML 再走通用清洗。
  //
  // 解出 base64 正文后置 true，后面跳过 contentSelector 匹配
  let bomMarker = false;

  if (site.base64Body !== false) {
    // 匹配 document.writeln( xxx.yyy('base64') )
    // 兼容：srtb.du / apb.kvyee / 任意 2~12 字符的 标识符.函数名
    const re = /document\.writeln\(\s*[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(\s*['"]([A-Za-z0-9+/=]{20,})['"]\s*\)\s*\)/g;
    const parts = [];
    let bm;
    while ((bm = re.exec(html)) !== null) {
      try {
        const html2 = Buffer.from(bm[1], 'base64').toString('utf8');
        if (html2) parts.push(html2);
      } catch { /* 单段解不开不影响其他段 */ }
    }
    if (parts.length) {
      html = parts.join('');     // 后面的通用清洗直接处理这个
      bomMarker = true;
    }
  }

  let raw;

  // ── 17k 这类：段落是 <div class="p">，不是 <p> ──
  //    先把每个 div.p 抽出来，单独拼成行，再走通用清洗。
  if (site.paraSplit) {
    const paras = [];
    const re = new RegExp(site.paraSplit.source, site.paraSplit.flags);
    let m;
    while ((m = re.exec(html)) !== null) {
      const t = m[1]
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .trim();
      if (t) paras.push(t);
    }

    if (!paras.length) {
      // ⚠ 17k 的 VIP 章节不返回正文容器（实测第 7 章起）。
      //   页面里会写「VIP章节, 余下还有 N 个段落」。
      //   必须和「站点改版」区分开，否则用户以为程序坏了。
      if (/VIP章节|VIP.{0,10}章节|余下还有\s*\d+\s*个段落/.test(html)) {
        return { title, text: '', ok: false, reason: 'vip' };
      }
      return { title, text: '', ok: false, reason: 'empty' };
    }
    raw = paras.join('\n');
  } else if (bomMarker) {
    // base64 已解出，直接当正文 HTML 用。
    // 解出来的是 <p>xxx</p> 片段，没有外层容器，不用匹配 contentSelector。
    raw = html;
  } else {
    const contentM = html.match(site.contentSelector);
    if (!contentM) {
      if (/VIP章节|付费|购买后阅读|订阅本章/.test(html)) {
        return { title, text: '', ok: false, reason: 'vip' };
      }
      return { title, text: '', ok: false, reason: 'empty' };
    }
    raw = contentM[1];
  }

  // 去掉 <script>/<style>
  raw = raw.replace(/<script[\s\S]*?<\/script>/gi, '');
  raw = raw.replace(/<style[\s\S]*?<\/style>/gi, '');

  // <br> → 换行
  raw = raw.replace(/<br\s*\/?>/gi, '\n');
  raw = raw.replace(/<\/p>/gi, '\n');
  raw = raw.replace(/<\/div>/gi, '\n');

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
    // 17k 类站点的尾部署名（实测出现在正文末尾）
    if (/本书首发来自|17K小说网|请记住本站|首发地址|最快更新/.test(line) && line.length < 60) continue;
    if (/^作者寄语[:：]?\s*$/.test(line)) continue;

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
  //    部分站点的 catalog 需要用「用户实际访问的域名」拼（镜像站），
  //    所以把 URL 对象也传进去。
  let bookUrlObj = null;
  try { bookUrlObj = new URL(bookUrl); } catch {}
  const catalogUrl = site.catalog(bookId, bookUrlObj);
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
  // VIP 章节单独计数：站点不给正文，不是我们的 bug，
  // 但必须让用户知道少了哪些，否则他以为下完了。
  let vip = 0;
  const vipChapters = [];
  const files = [];
  const mergedParts = [];

  for (let i = 0; i < picked.length; i++) {
    const c = picked[i];
    const tag = `[${i + 1}/${picked.length}] ${c.title}`;
    try {
      const html = await fetchText(c.url, {
        // bqg70 / 17k 这类对无 Referer 的章节请求会拒；
        // 给站点根域就够，不用给具体目录页 URL。
        referer: site.needReferer
          ? (() => { try { return new URL(c.url).origin + '/'; } catch { return undefined; } })()
          : undefined,
      });
      const parsed = parseChapter(site, html);

      if (!parsed.ok) {
        // VIP 章节不是失败，是站点不给。单独计数，不要触发「限流暂停」，
        // 也不要说「正文为空」——那句话会让用户以为程序坏了。
        if (parsed.reason === 'vip') {
          vip++;
          vipChapters.push(c.index);
          warn(`${tag}  ⊘ 付费章节，跳过`);
          consecutiveFail = 0;      // VIP 不算连续失败
          continue;
        }

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

  // VIP 章提示（有就单独说一段，别混在失败里）
  if (vip > 0) {
    const preview = vipChapters.slice(0, 10).join(', ');
    const more = vipChapters.length > 10 ? ` …共 ${vipChapters.length} 章` : '';
    warn(`\n⚠ 有 ${vip} 章是付费章节，站点不提供正文（第 ${preview}${more} 章）`);
    warn('  这不是程序问题：17K 的 VIP 章节需要订阅才能看。');
    warn('  免费章节已全部下载。');
  }

  return { chapters: picked.length, ok, fail, vip, files, bookDir, bookTitle };
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
