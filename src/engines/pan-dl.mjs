/**
 * pan-dl.mjs — 网盘直链解析
 *
 * ═══════════════════════════════════════════════════════════════
 * 这个模块解决什么
 * ═══════════════════════════════════════════════════════════════
 *
 * 用户手里有一个网盘分享链接（`https://pan.baidu.com/s/xxx`），
 * 想把它变成能直接下载的直链（`https://d.pcs.baidu.com/file/xxx?...`），
 * 然后丢给 downloadFile() 落到本地。
 *
 * ── 八个网盘的真实难度分布 ──
 *
 * 必须认清一件事：**绝大多数网盘没有"免登录直链"**。
 * 它们的产品设计就是"不登录拿不到文件"。所谓"直链解析"，
 * 实际是「用你的登录态去换一个直链」，不是绕过登录。
 *
 *   ┌── 匿名层（无需登录）────────────────────────────┐
 *   │ 蓝奏云 lanzou   两段式 sign → POST 换直链        │
 *   │ 123云盘 123pan  分享页内嵌 downloadInfo          │
 *   └──────────────────────────────────────────────────┘
 *
 *   ┌── 分享页层（分享本身不需登录，但直链要 token）──┐
 *   │ 天翼 189cloud   分享页 sessionKey                │
 *   │ 移动 139        分享页 getDownloadUrl            │
 *   └──────────────────────────────────────────────────┘
 *
 *   ┌── 登录层（必须登录 cookie）──────────────────────┐
 *   │ 百度 baidu      bdstoken + 会员才不限速         │
 *   │ 阿里 alipan     OAuth token（现已强制登录）      │
 *   │ 夸克 quark      必须扫码，cookie 时效短          │
 *   │ 迅雷 xunlei     X-Assert 签名 + 登录态          │
 *   │ UC   uc        与夸克同源，需 stoken            │
 *   └──────────────────────────────────────────────────┘
 *
 * ── 登录态从哪来 ──
 *
 * 不让用户输入账号密码（会被验证码/风控/2FA 拦，且存密码是安全隐患）。
 * 改成**借用户自己在浏览器里的登录态**：
 *
 *   1. 读本机 Chrome / Edge 的 cookie 库（--headful 打开让用户登录一次，然后复用 profile）
 *   2. 或用户手动粘一段 cookie 字符串
 *
 * 复用 douyin-dl.mjs 那套 CDP 方案：起一个带持久化 profile 的 Chrome，
 * 用户在里面登录过一次，之后所有请求都在页面上下文里发 —— 签名、
 * cookie、UA 全部自动带上，不用自己实现任何平台的加密算法。
 *
 * ── 为什么坚持「页面上下文 fetch」而不是 Node 直接请求 ──
 *
 * 这些网盘的接口普遍要求：
 *   · bdstoken / stoken / X-Assert 这类**页面里动态生成的**签名
 *   · 复杂的 cookie 组合（含 httpOnly 的）
 *   · 与 UA 绑定的风控指纹
 *
 * 在每个平台里重新实现一遍签名算法，等于把对方前端逆向一遍，
 * 而且对方一改版就全废。在页面上下文里 fetch，前端已经替你算好了。
 *
 * 这是交接文档十四节写的那条经验：
 *   「遇到反爬别急着写协议逆向，先试真浏览器 + 页面上下文 fetch」
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { findBrowser } from '../dev/browser.mjs';
import { pickPort } from '../dev/port.mjs';
import { downloadFile, probeSize, fmtSize } from '../dev/dl.mjs';

// ───────────────────── 基础 ─────────────────────

const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const warn = (...a) => console.error('[warn]', ...a);

/** 桌面前台 UA —— 部分网盘对手机 UA 会跳转到 H5 版，结构完全不同 */
const UA = UA_DESKTOP;

// ───────────────────── 站点表 ─────────────────────

/**
 * 每个网盘的适配配置。
 *
 * 字段说明：
 *   id            内部标识，CLI 上是 `pan <链接>` 自动识别，也可以用 `--net <id>` 强制
 *   name          显示名
 *   hosts         匹配用的域名（含镜像）
 *   needLogin     是否需要登录态。false = 匿名层
 *   sharePattern  分享链接的正则，用来从整段文字里抠出 link + 提取 shareId
 *   resolve       解析函数，签名见下方
 *
 * resolve(ctx) 返回值契约：
 *   { ok: true,  files: [{ name, size, url, headers? }], note? }
 *   { ok: false, reason, hint }
 *
 *   files[].url 必须是**可直接 GET 拿到字节**的地址。
 *   如果直链需要特定 Referer / UA，放在 headers 里。
 */
const PANS = [
  // ═══════════════ 匿名层 ═══════════════
  {
    id: 'lanzou',
    name: '蓝奏云',
    // 蓝奏云域名后缀不断轮换（lanzo + 各种字母组合），
    // 实测 2026-11 是 lanzoum.com。所以用 hostRegex 兜底，
    // hosts 只列几个已知的，别指望列全。
    hosts: ['lanzou.com', 'lanzoui.com', 'lanzoux.com', 'lanzouw.com'],
    hostRegex: /^(?:[a-z0-9]+\.)?lanzo[a-z]{0,2}\.com$/i,
    needLogin: false,
    // 蓝奏云分享链接：
    //   新格式  https://www.lanzoui.com/iXXXXXX      （i + 6~8 位，单文件）
    //   目录    https://www.lanzoui.com/b0XXXXXX     （b + 目录，多文件）
    //   带密码  https://www.lanzoui.com/iXXXXXX?pwd=abcd
    //
    // ⚠ 域名变体很多，实测有：
    //   lanzoui / lanzoux / lanzouw / lanzouv / lanzoue / lanzoub / lanzouj / lanzouf / lanzoum
    //   规律：lanzo + 0~2 个字母 + .com，且**经常带子域名**（如 yfo.lanzoum.com）
    //   路径三种：
    //     /iXXXXXX    单文件
    //     /b0XXXXXX   目录
    //     /s/XXXXXX   新版规范分享（实测 yfo.lanzoum.com/s/yufengruanjian）
    sharePattern: /https?:\/\/(?:[a-z0-9]+\.)?lanzo[a-z]{0,2}\.com\/(?:i|b0|s\/)([a-zA-Z0-9]{3,})/i,
    resolve: resolveLanzou,
  },
  {
    id: '123pan',
    name: '123云盘',
    hosts: ['123pan.com', 'www.123pan.com', '123684.com', '123865.com', '123pan.cn'],
    needLogin: false,
    sharePattern: /https?:\/\/(?:www\.)?(?:123pan\.com|123684\.com|123865\.com|123pan\.cn)\/s\/([a-zA-Z0-9_-]+)/i,
    resolve: resolve123Pan,
  },

  // ═══════════════ 分享页层（分享公开，直链要 token）═══════════════
  {
    id: '189',
    name: '天翼云盘',
    hosts: ['cloud.189.cn', 'h5.cloud.189.cn'],
    needLogin: false,
    // 实测分享链接：https://cloud.189.cn/web/share?code=26ZVRzFB7Zzq
    // 也有短形式：  https://cloud.189.cn/t/XXXXXXXXXX
    sharePattern: /https?:\/\/(?:h5\.)?cloud\.189\.cn\/(?:(?:web\/)?share\?code=|t\/)([a-zA-Z0-9]+)/i,
    resolve: resolve189,
  },
  {
    id: '139',
    name: '移动云盘',
    hosts: ['yun.139.com', 'caiyun.139.com'],
    needLogin: false,
    sharePattern: /https?:\/\/(?:yun|caiyun)\.139\.com\/w\/i\/([a-zA-Z0-9]+)/i,
    resolve: resolve139,
  },

  // ═══════════════ 登录层 ═══════════════
  //
  // 这一层的特点：分享页本身可能公开（能看文件列表），
  // 但**下载必须登录**——要么转存到自己网盘再下，要么带 token 直取。
  //
  // loginUrl        : 引导登录用的页面
  // loginCookieKey  : 判断登录成功的 cookie 名（实测值）
  {
    id: 'baidu',
    name: '百度网盘',
    hosts: ['pan.baidu.com', 'eyun.baidu.com'],
    needLogin: true,
    sharePattern: /https?:\/\/(?:pan|eyun)\.baidu\.com\/(?:s\/|share\/init\?surl=)([a-zA-Z0-9_-]+)/i,
    loginUrl: 'https://pan.baidu.com/',
    loginCookieKey: 'BDUSS',
    resolve: resolveBaidu,
  },
  {
    id: 'aliyun',
    name: '阿里云盘',
    hosts: ['alipan.com', 'www.alipan.com', 'aliyundrive.com', 'www.aliyundrive.com'],
    needLogin: true,
    sharePattern: /https?:\/\/(?:www\.)?(?:alipan|aliyundrive)\.com\/s\/([a-zA-Z0-9]+)/i,
    loginUrl: 'https://www.alipan.com/',
    loginCookieKey: 'token',
    resolve: resolveAliyun,
  },
  {
    id: 'quark',
    name: '夸克网盘',
    hosts: ['pan.quark.cn', 'drive.quark.cn'],
    needLogin: true,
    sharePattern: /https?:\/\/(?:pan|drive)\.quark\.cn\/s\/([a-zA-Z0-9]+)/i,
    // 实测：b-user-id（UUID 形式）是登录后的用户标识
    loginUrl: 'https://pan.quark.cn/',
    loginCookieKey: 'b-user-id',
    resolve: resolveQuark,
  },
  {
    id: 'xunlei',
    name: '迅雷云盘',
    hosts: ['pan.xunlei.com'],
    needLogin: true,
    sharePattern: /https?:\/\/pan\.xunlei\.com\/s\/([a-zA-Z0-9_-]+)/i,
    loginUrl: 'https://pan.xunlei.com/',
    loginCookieKey: 'XLSESSIONID',
    resolve: resolveXunlei,
  },
  {
    id: 'uc',
    name: 'UC网盘',
    hosts: ['drive.uc.cn'],
    needLogin: true,
    sharePattern: /https?:\/\/drive\.uc\.cn\/s\/([a-zA-Z0-9]+)/i,
    loginUrl: 'https://drive.uc.cn/',
    loginCookieKey: 'b-user-id',
    resolve: resolveUC,
  },
];

// ───────────────────── 识别 ─────────────────────

/**
 * 从任意文本里抠出所有网盘链接。
 *
 * ⚠ 用全文正则，不要用 ^https?:// 判断 —— 交接文档坑 24：
 *   UI 多行输入框里粘两个链接，整串不以 http 开头会被整条丢掉。
 */
function extractPanLinks(text) {
  const out = [];
  const seen = new Set();
  const re = /https?:\/\/[^\s"'<>，。、；）)\]]+/g;
  const found = String(text || '').match(re) || [];
  for (let u of found) {
    // 去掉句末标点
    u = u.replace(/[.,;:!?)\]，。、；）】》]+$/, '');
    if (seen.has(u)) continue;
    const pan = matchPan(u);
    if (pan) { seen.add(u); out.push({ url: u, pan }); }
  }
  return out;
}

function matchPan(url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }

  // 先走 hosts 精确/后缀匹配
  const byHost = PANS.find((p) =>
    (p.hosts || []).some((h) => host === h || host.endsWith('.' + h)));
  if (byHost) return byHost;

  // 再走 hostRegex 宽松匹配 —— 蓝奏云这类域名后缀不断轮换，
  // 逐个列 hosts 永远会漏（实测 lanzo→lanzoum/lanzoug/... 每隔一阵就换）。
  return PANS.find((p) => p.hostRegex && p.hostRegex.test(host)) || null;
}

function findPanById(id) {
  const k = String(id || '').toLowerCase();
  return PANS.find((p) => p.id === k || p.name.includes(id)) || null;
}

// ───────────────────── CDP 浏览器 ─────────────────────

/**
 * 起一个带**持久化 profile** 的 Chrome。
 *
 * 为什么必须持久化：
 *   登录态（cookie）存在 profile 里。用临时目录的话，每次都要重新登录，
 *   用户会被烦死。固定目录 `~/.downloaders-pan-profile`，登录一次长期有效。
 *
 * 为什么 headless 不行：
 *   部分网盘（夸克、阿里）会检测无头浏览器，直接用 headless 拿不到数据。
 *   默认用 headful，用户能看到浏览器窗口。
 */
async function launchBrowser({ headful = true, net = 'pan' } = {}) {
  const r = findBrowser();
  if (!r || !r.ok) {
    const e = new Error('未找到 Chrome / Edge 浏览器');
    e.code = 'ENOBROWSER';
    e.hint = '网盘解析需要浏览器。请安装 Chrome 或 Edge。';
    throw e;
  }

  const profileDir = path.join(os.homedir(), '.downloaders-pan-profile');
  fs.mkdirSync(profileDir, { recursive: true });

  const port = await pickPort(9222, warn);
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-blink-features=AutomationControlled',
    '--exclude-switches=enable-automation',
    '--password-store=basic',
    '--use-mock-keychain',
    '--lang=zh-CN',
    `--user-agent=${UA_DESKTOP}`,
    'about:blank',
  ];
  if (!headful) args.unshift('--headless=new');

  const proc = spawn(r.path, args, { stdio: 'ignore', windowsHide: !headful });

  let wsUrl = null;
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      const j = await res.json();
      wsUrl = j.webSocketDebuggerUrl;
      if (wsUrl) break;
    } catch {}
    await sleep(150);
  }
  if (!wsUrl) {
    try { proc.kill(); } catch {}
    throw new Error('浏览器调试端口未就绪');
  }

  return { proc, port, wsUrl, profileDir };
}

/** 极简 CDP 客户端（与 douyin-dl.mjs 同构，但独立，避免互相耦合） */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    // 下载事件队列（Page.downloadWillBegin / downloadProgress）
    this._dlBegin = [];
    this._dlProgress = new Map();

    ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }

      // 事件（无 id）
      if (m.id == null) {
        if (m.method === 'Page.downloadWillBegin' || m.method === 'Browser.downloadWillBegin') {
          this._dlBegin.push(m.params);
        } else if (m.method === 'Page.downloadProgress' || m.method === 'Browser.downloadProgress') {
          this._dlProgress.set(m.params.guid, m.params);
        }
        return;
      }

      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      // 坑 0：定时器必须清，否则进程空转
      if (p.timer) clearTimeout(p.timer);
      if (m.error) p.reject(new Error(m.error.message || 'CDP error'));
      else p.resolve(m.result);
    });
  }

  /** 取走最早的一条下载开始事件（用完即删，避免重复消费） */
  takeDownloadBegin() {
    return this._dlBegin.shift() || null;
  }

  /** 查某个 guid 的最新下载进度 */
  downloadProgress(guid) {
    return this._dlProgress.get(guid) || null;
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 60000);
      timer.unref?.();              // 坑 0 / 23：不 unref 会拖住事件循环
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(msg));
    });
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

async function connectCDP(wsUrl, timeoutMs = 15000) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('CDP WebSocket 连接超时')), timeoutMs);
    timer.unref?.();
    ws.addEventListener('open', () => { clearTimeout(timer); res(); }, { once: true });
    ws.addEventListener('error', (e) => { clearTimeout(timer); rej(e); }, { once: true });
  });
  return new CDP(ws);
}

/** 在页面上下文里执行一段 JS，返回结果。这就是整套方案的核心能力。 */
async function evalPage(cdp, sessionId, expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, sessionId);
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(
      '页面求值异常: ' + (d.exception?.description || d.text || 'unknown')
    );
  }
  return r.result?.value;
}

// ───────────────────── 各网盘解析器 ─────────────────────
//
// 每个 resolve(ctx) 里的 ctx：
//   { url, shareId, cdp, sessionId, page, headful, cookieOverride }
//
// 实现约定：
//   1. 先在页面里打开分享链接（这样签名脚本会加载）
//   2. 等页面就绪
//   3. 在页面上下文 fetch 接口，拿文件列表 + 直链
//   4. 返回契约见 PANS 上方注释
//
// 未实现的平台统一返回 reason:'not-implemented'，
// 而不是假装成功 —— 静默失败比明确报错更糟（坑 27 的教训）。

async function resolveLanzou(ctx) {
  const { cdp, sessionId, url, shareId } = ctx;

  // ── 判定是目录分享（/s/ 或 /b0）还是单文件（/i） ──
  const isFolder = /\/s\/|(?:^|\/)b0/i.test(url);
  log(`  蓝奏云${isFolder ? '目录' : '单文件'}分享`);

  // 打开分享页，等 arg1 挑战自己解完
  await cdp.send('Page.navigate', { url }, sessionId);
  await sleep(5000);

  // 验活：挑战没解开会停在 4334 字节的 <script>var arg1 页面
  const state = await evalPage(cdp, sessionId, `({
    title: document.title,
    len: document.documentElement.outerHTML.length,
    isChallenge: /var arg1=/.test(document.documentElement.outerHTML.slice(0, 500)),
  })`);
  if (state && state.isChallenge) {
    return { ok: false, reason: 'challenge', hint: '蓝奏云反爬挑战未通过，请加 --headful 重试' };
  }

  if (isFolder) {
    // 目录分享：列出文件，让调用方决定下哪个
    const files = [];
    for (let i = 0; i < 15; i++) {
      const list = await evalPage(cdp, sessionId, `(function(){
        const as = [...document.querySelectorAll('#infos a')];
        return as.map(a => ({ name: (a.textContent||'').trim(), href: a.href }))
                 .filter(x => x.name && /\\/i[a-zA-Z0-9]+/.test(x.href));
      })()`);
      if (Array.isArray(list) && list.length) { files.push(...list); break; }
      await sleep(1000);
    }
    if (!files.length) {
      return { ok: false, reason: 'no-files', hint: '目录里没找到可下载文件（可能需要密码）' };
    }
    return {
      ok: true,
      files: files.map((f) => ({
        name: safeName(f.name),
        size: 0,
        url: f.href,           // 这里给的是单文件页，由 downloadFileList 再展开
        isFolderItem: true,
      })),
      note: `目录共 ${files.length} 个文件`,
    };
  }
  return resolveLanzouSingle(ctx, url);
}

/**
 * 蓝奏云单文件页 → 真实 CDN 直链
 *
 * 三层结构（实测 2026-11-01）：
 *   1. /iXXXXXX        单文件页，含 iframe
 *   2. /fn?XXX         iframe 内层，含三个下载按钮
 *   3. slsstm2.dmpdmp 按钮 href，是 CDN 网关地址（不是最终文件）
 *
 * 关键坑：第 3 步的地址再请求一次，CDN 会发一个新的 arg1 挑战页，
 *        必须让**浏览器**执行挑战，才能真正跳转到文件。
 *        所以「解析出直链再用 Node 下载」这条路是走不通的。
 */
async function resolveLanzouSingle(ctx, pageUrl) {
  const { cdp, sessionId } = ctx;

  // 等内层 iframe 的下载按钮出现
  let btn = null;
  for (let i = 0; i < 20; i++) {
    btn = await evalPage(cdp, sessionId, `(function(){
      const f = document.querySelector('iframe');
      if (!f || !f.contentDocument) return null;
      const as = [...f.contentDocument.querySelectorAll('a')];
      if (!as.length) return null;
      const t = as.find(a => /普通下载/.test(a.textContent||'')) || as[0];
      return { text: (t.textContent||'').trim(), href: t.href };
    })()`);
    if (btn && btn.href) break;
    await sleep(1000);
  }

  if (!btn || !btn.href) {
    // 没有 iframe 按钮 → 可能本身就是文件页，或需要密码
    const hasPwd = await evalPage(cdp, sessionId,
      `!!document.querySelector('input#pwd, input[name=pwd], .passwd')`);
    return {
      ok: false,
      reason: hasPwd ? 'password' : 'no-button',
      hint: hasPwd ? '该分享需要提取密码，暂不支持' : '页面结构变化，未找到下载按钮',
    };
  }

  const name = await evalPage(cdp, sessionId,
    `document.title.replace(/\\s*-\\s*蓝奏云\\s*$/,'').trim()`);

  cdp.close();
  return {
    ok: true,
    files: [{
      name: safeName(name || 'lanzou-file'),
      size: 0,
      url: btn.href,
      // 标记：这个 url 必须由浏览器导航下载，不能直接 fetch
      needsBrowser: true,
      referer: pageUrl,
    }],
  };
}

async function resolve123Pan(ctx) {
  return notImpl('123云盘');
}

/**
 * 天翼云盘
 *
 * ═══════════════════════════════════════════════════════════════
 * 接口链路（2026-11-01 实测）
 * ═══════════════════════════════════════════════════════════════
 *
 * 分享信息（公开可读，无需登录）：
 *   GET /api/open/share/getShareInfoByCodeV2.action?shareCode=XXX
 *   → {
 *       res_code: 0,
 *       accessCode: "",
 *       needAccessCode: 1,          ← 1 = 要访问码
 *       fileId: "81323312080506933",
 *       fileName: "教父1-3",
 *       isFolder: true,
 *       shareType: 1,
 *       expireType: 0,              ← 0 = 永久有效
 *       creator: { nickName, ownerAccount, ... }
 *     }
 *
 * 页面 UI（实测）：
 *   <input class="input" type="text">   ← 访问码输入框
 *   <a>访问</a>                          ← 提交按钮
 *
 * ⚠ 需要访问码时，提交走的是页面内部逻辑，接口名随版本变，
 *   所以这里不硬编码「校验接口」，而是**在页面上模拟填写 + 点击**，
 *   让页面自己发请求。这样对方改接口名也不影响我们。
 *
 * ── 目录结构（分享的是文件夹时） ──
 * 文件列表和直链接口未实测（本条链接是私密分享，缺访问码）。
 * 已知的接口命名规律（从 JS bundle 里能搜到）：
 *   /api/open/share/listShareDir.action      列目录
 *   /api/open/share/getFileDownloadUrl.action 取直链
 * 实现时先用「页面内模拟点击」保底，接口直连作为优化。
 */
async function resolve189(ctx) {
  const { cdp, sessionId, url, shareId, accessCode } = ctx;

  await cdp.send('Page.navigate', { url }, sessionId);
  await sleep(6000);

  // 1. 直接调分享信息接口（比解析 DOM 稳）
  const info = await evalPage(cdp, sessionId, `(async () => {
    try {
      const r = await fetch('/api/open/share/getShareInfoByCodeV2.action?shareCode=${shareId}&noCache=' + Math.random(), {
        credentials: 'include',
        headers: { 'Accept': 'application/json;charset=UTF-8' },
      });
      return await r.json();
    } catch (e) { return { __err: String(e) }; }
  })()`);

  if (!info || info.__err) {
    return { ok: false, reason: 'api-failed', hint: String(info?.__err || '') };
  }
  if (info.res_code !== 0) {
    return {
      ok: false,
      reason: 'share-error',
      hint: info.res_message || `res_code=${info.res_code}`,
    };
  }

  log(`    分享: ${info.fileName}${info.isFolder ? '（文件夹）' : ''}  来自 ${info.creator?.nickName || '?'}`);

  // 2. 需要访问码 → 在页面上填 + 点，让站点自己发请求
  if (info.needAccessCode === 1) {
    if (!accessCode) {
      return {
        ok: false,
        reason: 'need-access-code',
        hint: '该分享需要访问码。用 --code <访问码> 传入，或改成 --headful 手动输入',
      };
    }
    const r1 = await evalPage(cdp, sessionId, `(function(){
      const inputs = [...document.querySelectorAll('input')]
        .filter(i => i.offsetParent && (i.type === '' || i.type === 'text' || i.type === 'password'));
      if (!inputs.length) return 'no-input';
      const inp = inputs[inputs.length - 1];
      inp.focus();
      inp.value = ${JSON.stringify(accessCode)};
      ['input', 'change', 'keyup'].forEach(e =>
        inp.dispatchEvent(new Event(e, { bubbles: true })));
      return 'filled';
    })()`);
    if (r1 !== 'filled') {
      return { ok: false, reason: 'no-code-input', hint: '页面上没找到访问码输入框' };
    }
    await sleep(800);

    await evalPage(cdp, sessionId, `(function(){
      const btns = [...document.querySelectorAll('button, .btn, [class*=btn], a')]
        .filter(b => b.offsetParent);
      const t = btns.find(b => /^(访问|确定|提交|确认)$/.test((b.textContent || '').trim()));
      if (t) t.click();
    })()`);
    await sleep(5000);

    // 校验是否进去了：再调一次接口看 needAccessCode 有没有变
    const info2 = await evalPage(cdp, sessionId, `(async () => {
      try {
        const r = await fetch('/api/open/share/getShareInfoByCodeV2.action?shareCode=${shareId}&noCache=' + Math.random(), {
          credentials: 'include',
          headers: { 'Accept': 'application/json;charset=UTF-8' },
        });
        return await r.json();
      } catch (e) { return { __err: String(e) }; }
    })()`);
    if (info2 && info2.needAccessCode === 1) {
      return { ok: false, reason: 'wrong-access-code', hint: '访问码不正确' };
    }
  }

  // 3. 取文件列表
  //    优先用接口；接口名变了就退回 DOM 解析
  const list = await evalPage(cdp, sessionId, `(async () => {
    try {
      const r = await fetch('/api/open/share/listShareDir.action?shareCode=${shareId}&fileId=${info.fileId || ''}&isFolder=1&noCache=' + Math.random(), {
        credentials: 'include',
        headers: { 'Accept': 'application/json;charset=UTF-8' },
      });
      const j = await r.json();
      if (j && j.res_code === 0 && Array.isArray(j.fileListAO?.fileList)) {
        return { source: 'api', files: j.fileListAO.fileList.map(f => ({
          id: f.id, name: f.name, size: f.size, isFolder: f.isFolder,
        })) };
      }
      return { source: 'api-none', raw: JSON.stringify(j).slice(0, 500) };
    } catch (e) { return { source: 'err', err: String(e) }; }
  })()`);

  if (list && list.source === 'api' && list.files.length) {
    return {
      ok: true,
      files: list.files.map((f) => ({
        name: safeName(f.name),
        size: f.size || 0,
        // 文件夹暂不递归展开（会爆炸），标记出来让用户单独处理
        url: f.isFolder ? '' : `189:${shareId}:${f.id}`,
        fileId: f.id,
        isFolder: !!f.isFolder,
        needsBrowser: true,
      })),
      note: `共 ${list.files.length} 项`,
    };
  }

  // 4. 接口不可用 → DOM 兜底
  const domFiles = await evalPage(cdp, sessionId, `(function(){
    const rows = [...document.querySelectorAll('[class*=file-item], [class*=fileItem], tr')];
    return rows.map(r => {
      const nameEl = r.querySelector('[class*=name], .file-name, td');
      return nameEl ? (nameEl.textContent || '').trim() : '';
    }).filter(n => n && n.length < 200).slice(0, 100);
  })()`);

  if (Array.isArray(domFiles) && domFiles.length) {
    return {
      ok: true,
      files: domFiles.map((n) => ({
        name: safeName(n), size: 0, needsBrowser: true, domOnly: true,
      })),
      note: `DOM 解析 ${domFiles.length} 项（接口未命中，可能不完整）`,
    };
  }

  return {
    ok: false,
    reason: 'list-failed',
    hint: '未能取到文件列表。该分享可能是私密分享且访问码错误，或页面结构已变。',
  };
}

async function resolve139(ctx) {
  return notImpl('移动云盘');
}

async function resolveBaidu(ctx) {
  return notImpl('百度网盘');
}

async function resolveAliyun(ctx) {
  return notImpl('阿里云盘');
}

/**
 * 夸克网盘
 *
 * ═══════════════════════════════════════════════════════════════
 * 接口链路（2026-11-01 实测）
 * ═══════════════════════════════════════════════════════════════
 *
 * 免登录可用的两步：
 *
 *   POST /1/clouddrive/share/sharepage/token
 *        body: { pwd_id: '<shareId>', passcode: '' }
 *        → { data: { stoken: '...' } }
 *
 *   GET  /1/clouddrive/share/sharepage/detail
 *        ?pwd_id=<shareId>&stoken=<stoken>&pdir_fid=0&_page=1&_size=50
 *        → { data: { list: [{ fid, file_name, size, file_type, ... }] } }
 *        file_type: 0=文件夹 1=文件
 *
 * 必须登录的一步（实测 401）：
 *
 *   POST /1/clouddrive/share/sharepage/save
 *        body: { fid_list, to_pdir_fid, pwd_id, stoken }
 *        → { status: 401, code: 31001, message: 'require login [guest]' }
 *
 * ── 这意味着什么 ──
 *
 * 夸克的下载流程是「**先转存到自己网盘，再从自己网盘下**」。
 * 转存这一步死死锁在登录后面，没有任何绕过办法。
 *
 * 所以本模块的做法是：
 *   1. 未登录也能列出文件（用户可以先看有什么）
 *   2. 要下载时，检测到未登录 → 明确提示用户去登录
 *   3. 用户登录一次（持久化 profile 记住 cookie）
 *   4. 之后再跑就自动走完 save → download
 *
 * 这不是"破解"，是"帮用户用他自己的账号跑完本来要手点的流程"。
 */
/**
 * 夸克的文件夹递归展开。
 *
 * 分享页的 detail 接口支持 pdir_fid 参数指定目录：
 *   /1/clouddrive/share/sharepage/detail?...&pdir_fid=<fid>
 *
 * 大分享可能上万项，所以要限制：
 *   - 最大深度 3 层
 *   - 最大文件数 200（够日常用，多了用户也不会一个个下）
 *   - 每层最多 100 条（接口 _size 上限）
 */
async function expandQuarkFolder(ctx, folderFid, depth = 0, out = []) {
  const { cdp, sessionId, shareId, stoken } = ctx;

  if (depth > 3) return out;
  if (out.length >= 200) return out;

  const det = await evalPage(cdp, sessionId, `(async () => {
    const u = '/1/clouddrive/share/sharepage/detail?pr=ucpro&fr=pc&uc_param_str=&ver=2'
      + '&pwd_id=' + encodeURIComponent(${JSON.stringify(shareId)})
      + '&stoken=' + encodeURIComponent(${JSON.stringify(stoken)})
      + '&pdir_fid=' + encodeURIComponent(${JSON.stringify(folderFid)})
      + '&force=0&_page=1&_size=100&_fetch_banner=0&_fetch_share=0&_fetch_total=1'
      + '&_sort=file_type:asc,updated_at:desc';
    try {
      const r = await fetch(u, { credentials: 'include' });
      return await r.json();
    } catch (e) { return { __err: String(e) }; }
  })()`);

  const list = det?.data?.list || [];
  for (const f of list) {
    if (out.length >= 200) break;
    if (f.file_type === 0) {
      await expandQuarkFolder({ ...ctx, }, f.fid, depth + 1, out);
    } else {
      out.push({
        name: safeName(f.file_name),
        size: f.size || 0,
        fid: f.fid,
        url: `quark:${f.fid}`,
        needsBrowser: true,
        shareId,
        stoken,
      });
    }
  }
  return out;
}

async function resolveQuark(ctx) {
  const { cdp, sessionId, url, shareId } = ctx;

  await cdp.send('Page.navigate', { url }, sessionId);
  await sleep(7000);

  // 1. 拿 stoken（免登录）
  const tokRes = await evalPage(cdp, sessionId, `(async () => {
    try {
      const r = await fetch('/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc&uc_param_str=', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pwd_id: ${JSON.stringify(shareId)}, passcode: '' }),
      });
      return await r.json();
    } catch (e) { return { __err: String(e) }; }
  })()`);

  if (!tokRes || tokRes.__err) {
    return { ok: false, reason: 'api-failed', hint: String(tokRes?.__err || '') };
  }
  const stoken = tokRes?.data?.stoken;
  if (!stoken) {
    // need_passcode / 分享失效
    const msg = tokRes?.message || '';
    return {
      ok: false,
      reason: /passcode|提取码|密码/i.test(msg) ? 'need-access-code' : 'token-failed',
      hint: msg || '拿不到 stoken，分享可能已失效',
    };
  }

  // 2. 判断登录态 —— 必须调**真实接口**验证，不能只看 cookie 名
  //
  // 踩过的坑（2026-11-01）：
  //   一开始用「cookie 里有 b-user-id 就算登录」，结果永远返回已登录。
  //   实际上 b-user-id 是**匿名设备 ID**，未登录的访客也有。
  //   真正的登录判定必须让服务端告诉你 —— 调一个需要登录的接口：
  //     已登录 → 200 / code 0
  //     未登录 → 401 / code 31001 "require login [guest]"
  const loggedIn = await evalPage(cdp, sessionId, `(async () => {
    try {
      const r = await fetch('/1/clouddrive/share/sharepage/save?pr=ucpro&fr=pc&uc_param_str=', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        // 故意用一个空 fid 列表：不产生副作用，但服务端仍会先校验登录
        body: JSON.stringify({ fid_list: [], fid_token_list: [], to_pdir_fid: '0', pwd_id: 'x', stoken: 'x' }),
      });
      const j = await r.json();
      return !(r.status === 401 || j.code === 31001);
    } catch { return false; }
  })()`);

  // 3. 列文件（免登录）
  const det = await evalPage(cdp, sessionId, `(async () => {
    const u = '/1/clouddrive/share/sharepage/detail?pr=ucpro&fr=pc&uc_param_str=&ver=2'
      + '&pwd_id=' + encodeURIComponent(${JSON.stringify(shareId)})
      + '&stoken=' + encodeURIComponent(${JSON.stringify(stoken)})
      + '&pdir_fid=0&force=0&_page=1&_size=100&_fetch_banner=0&_fetch_share=1&_fetch_total=1'
      + '&_sort=file_type:asc,updated_at:desc';
    try {
      const r = await fetch(u, { credentials: 'include' });
      return await r.json();
    } catch (e) { return { __err: String(e) }; }
  })()`);

  const list = det?.data?.list || [];
  if (!list.length) {
    return { ok: false, reason: 'empty', hint: det?.message || '分享里没有文件，或需要提取码' };
  }

  const shareTitle = det?.data?.share?.title || '';
  const total = det?.data?.total || list.length;
  log(`    分享: ${shareTitle || '(未命名)'}  共 ${total} 项`);

  const files = list.map((f) => ({
    name: safeName(f.file_name),
    size: f.size || 0,
    fid: f.fid,
    isFolder: f.file_type === 0,
    // 文件夹：url 里存 fid，下载时再由 expandFolder 递归展开
    url: f.file_type === 0 ? `quarkdir:${f.fid}` : `quark:${f.fid}`,
    needsBrowser: true,
    // 递归需要的上下文
    shareId,
    stoken,
  }));

  // 4. 未登录 → 明确告知，不假装成功
  if (!loggedIn) {
    return {
      ok: true,
      files,
      note: `${total} 项`,
      warn: '夸克下载需要登录：先转存到你自己的网盘再下载。'
          + '跑一次 下载器.exe pan "<链接>" --login 登录（只需一次），之后自动完成。',
      needsLogin: true,
    };
  }

  // 5. 已登录 → 走 save → download（下一轮实现）
  return {
    ok: true,
    files,
    note: `${total} 项（已登录）`,
    warn: '已登录：转存+下载流程待接入',
  };
}

async function resolveXunlei(ctx) {
  return notImpl('迅雷网盘');
}

async function resolveUC(ctx) {
  return notImpl('UC网盘');
}

/** 文件名安全处理：去掉 Windows 非法字符 */
function safeName(s, max = 120) {
  return String(s || 'file')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, max) || 'file';
}

// ───────────────────── 浏览器下载 ─────────────────────

/**
 * 用浏览器把**一个 URL** 下到指定目录。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么不能用 downloadFile() 直接下
 * ═══════════════════════════════════════════════════════════════
 *
 * 蓝奏云这类站点的直链有多层保护：
 *
 *   第 1 层  分享页本身有 JS 挑战（arg1 → acw_sc__v2 cookie）
 *   第 2 层  下载按钮的 href 是 CDN 网关（slsstm2.dmpdmp.com），不是文件
 *   第 3 层  网关地址再请求一次，**又是一个新的 arg1 挑战**，
 *            跳过挑战直接 curl 会拿到 4KB 的 HTML 而不是文件
 *
 * 实测（2026-11-01）：
 *   curl 直打网关 → HTTP 200, 返回 4321 字节 <html><script>var arg1=...
 *   X-Tengine-Error: denied by http_custom
 *
 * 结论：**必须让真实的浏览器去执行挑战**，挑战过后浏览器才会 302 到
 *       真正的文件地址（h1060.lanosso.com/.../xxx.apk）。
 *
 * 所以流程是：
 *   1. Browser.setDownloadBehavior 设置落盘目录
 *   2. 新开标签导航到这个 URL，**全程不干预**
 *   3. 监听 Browser.downloadWillBegin 拿到真实文件名
 *   4. 等 downloadProgress.state === 'completed'
 *   5. 把 allowAndName 生成的 guid 文件重命名成真名
 *
 * ⚠ allowAndName 是必须的：中文文件名经 CDP 传过来时，
 *   直接用会在某些 locale 下变成乱码或空名。
 *   用 guid 落盘、再本地改名，稳得多。
 */
async function browserDownload(wsUrl, targetUrl, outDir, displayName, log) {
  fs.mkdirSync(outDir, { recursive: true });

  // ═══════════════════════════════════════════════════════════════
  // ⚠ 这条连接必须**全新开**，不能复用主 CDP 连接。
  //
  // 实测（2026-11-01）：
  //   主连接上已经 attach 了若干 target 之后，再往根连接发
  //   Browser.setDownloadBehavior 会**永远不返回**（CDP timeout）。
  //   而一个刚建立的、没 attach 过任何 target 的干净连接，
  //   同样的调用秒回。
  //
  // 所以下载这一段完全独立，用完就关。
  // ═══════════════════════════════════════════════════════════════
  const dlCdp = await connectCDP(wsUrl);

  await dlCdp.send('Browser.setDownloadBehavior', {
    behavior: 'allowAndName',
    downloadPath: outDir,
    eventsEnabled: true,
  });

  const { targetId } = await dlCdp.send('Target.createTarget', { url: targetUrl });
  const { sessionId } = await dlCdp.send('Target.attachToTarget', {
    targetId, flatten: true,
  });
  await dlCdp.send('Page.enable', {}, sessionId);
  await dlCdp.send('Runtime.enable', {}, sessionId);
  await dlCdp.send('Runtime.enable', {}, sessionId);
  // Page 域也要开下载事件（Browser 和 Page 两套事件名都收，取先到的）
  try { await dlCdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: outDir }, sessionId); } catch {}

  let guid = null;
  let suggested = displayName || 'download';
  const deadline = Date.now() + 10 * 60 * 1000;

  try {
    while (Date.now() < deadline) {
      await sleep(800);

      if (!guid) {
        const ev = dlCdp.takeDownloadBegin();
        if (ev) {
          guid = ev.guid;
          if (ev.suggestedFilename) suggested = ev.suggestedFilename;
          log(`    浏览器接管下载 → ${suggested}`);
        }
      }

      if (guid) {
        const prog = dlCdp.downloadProgress(guid);
        if (prog && prog.state === 'completed') {
          // ⚠ 实测坑：downloadProgress 说 completed 时，
          //   磁盘上可能还在 .crdownload 阶段，guid 文件尚未落地。
          //   直接 rename 会 ENOENT（表现为 missing-after-complete）。
          //   所以要**多等一会**，并确认 guid 文件真的存在。
          const src = path.join(outDir, guid);
          let renamed = false;
          for (let retry = 0; retry < 20; retry++) {
            if (fs.existsSync(src)) {
              const dst = path.join(outDir, safeName(suggested));
              fs.renameSync(src, dst);
              renamed = true;
              return { ok: true, path: dst, size: fs.statSync(dst).size };
            }
            await sleep(500);
          }
          if (!renamed) {
            // guid 文件没等到，也可能浏览器按真名落地了
            const cand = path.join(outDir, safeName(suggested));
            if (fs.existsSync(cand)) {
              return { ok: true, path: cand, size: fs.statSync(cand).size };
            }
            return { ok: false, reason: 'missing-after-complete' };
          }
        }
        if (prog && prog.state === 'canceled') {
          return { ok: false, reason: 'canceled' };
        }
      }
    }
    return { ok: false, reason: 'timeout', hint: '下载超时（10 分钟）' };
  } finally {
    try { await dlCdp.send('Target.closeTarget', { targetId }); } catch {}
    dlCdp.close();
  }
}

function notImpl(name) {
  return {
    ok: false,
    reason: 'not-implemented',
    hint: `${name} 解析器还在实现中`,
  };
}

// ───────────────────── 登录流程 ─────────────────────

/**
 * 引导用户登录网盘。
 *
 * 原理：起一个**持久化 profile** 的浏览器，打开登录页，让用户自己扫码。
 *      cookie 存在 `~/.downloaders-pan-profile`，之后所有解析都在这个
 *      profile 里跑，天然带登录态。
 *
 * 为什么不让用户输账号密码：
 *   1. 验证码/滑块/2FA 基本必拦，自动化极不稳定
 *   2. 存密码是安全隐患，用户也不愿给
 *   3. 扫码是官方设计的登录方式，最稳定
 *
 * 什么时候能确认登录成功：
 *   轮询探测接口（每个站的探测点不同），或直接看 cookie 里有没有
 *   关键字段（夸克是 `b-user-id`，百度是 `BDUSS`，阿里是 `token`）。
 */
async function doLogin(netId) {
  const pan = findPanById(netId);
  if (!pan) {
    warn(`未知网盘: ${netId}`);
    return 1;
  }

  const loginUrl = pan.loginUrl;
  if (!loginUrl) {
    warn(`${pan.name} 暂不支持登录引导`);
    return 1;
  }

  log(`\n打开 ${pan.name} 登录页...`);
  log('请在浏览器窗口里扫码登录，登录完成后会自动继续。\n');

  const browser = await launchBrowser({ headful: true });
  const cdp = await connectCDP(browser.wsUrl);

  const { targetId } = await cdp.send('Target.createTarget', { url: loginUrl });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);

  // 轮询判断登录态，最多等 5 分钟
  //
  // ⚠ 不能只看 cookie 名！实测 b-user-id 是匿名设备 ID，未登录也有。
  //   要调一个**需要登录**的接口看服务端怎么回：
  //     /1/clouddrive/share/sharepage/save  → 401 code 31001 = 未登录
  //     已登录 → 200 / code 0（用空 fid_list，不产生副作用）
  const deadline = Date.now() + 5 * 60 * 1000;
  let loggedIn = false;

  while (Date.now() < deadline) {
    await sleep(2500);
    if (pan.id === 'quark' || pan.id === 'uc') {
      const r = await evalPage(cdp, sessionId, `(async () => {
        try {
          const res = await fetch('/1/clouddrive/share/sharepage/save?pr=ucpro&fr=pc&uc_param_str=', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fid_list: [], fid_token_list: [], to_pdir_fid: '0', pwd_id: 'x', stoken: 'x' }),
          });
          const j = await res.json();
          return !(res.status === 401 || j.code === 31001);
        } catch { return false; }
      })()`);
      if (r === true) { loggedIn = true; break; }
    } else {
      // 其他站点：退回 cookie 名检测
      const cookies = await cdp.send('Network.getAllCookies', {}, sessionId).catch(() => ({ cookies: [] }));
      const hit = (cookies.cookies || []).some(
        (c) => c.name === cookieKey && String(c.value || '').length > 5
      );
      if (hit) { loggedIn = true; break; }
    }
  }

  cdp.close();
  try { browser.proc.kill(); } catch {}

  if (loggedIn) {
    log(`✓ ${pan.name} 登录成功，凭据已保存到 ${browser.profileDir}`);
    log('  之后直接跑 pan 命令即可，不用再登录。');
    return 0;
  }

  warn(`✗ 等待超时（5 分钟），未检测到登录。`);
  warn(`  如果已经登录了，可能是 cookie 名不是 ${cookieKey}，请提 issue。`);
  return 1;
}

function parseArgs(argv) {
  const opts = {
    urls: [], out: null, list: false, headful: true,
    net: null, only: null, help: false,
    accessCode: null,
    login: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--list') opts.list = true;
    else if (a === '--headful') opts.headful = true;
    else if (a === '--headless') opts.headful = false;
    else if (a === '--login') opts.login = true;
    else if (a === '--deep') opts.deep = true;
    else if (a === '-o' || a === '--out') opts.out = argv[++i];
    else if (a === '--net') opts.net = argv[++i];
    else if (a === '--only') opts.only = argv[++i];
    else if (a === '--code' || a === '--pwd') opts.accessCode = argv[++i];
    else positional.push(a);
  }

  // 多行输入：从每个位置参数里再抠出所有 URL（坑 24）
  const seen = new Set();
  for (const p of positional) {
    for (const { url } of extractPanLinks(p)) {
      if (!seen.has(url)) { seen.add(url); opts.urls.push(url); }
    }
  }
  return opts;
}

function printHelp() {
  log(`
网盘直链解析下载

用法
  下载器.exe pan <分享链接> [...] [选项]

选项
  -o, --out <目录>     保存目录（默认 ./downloads/网盘）
  --list               只列出文件，不下载
  --deep               配合 --list：展开文件夹内部
  --net <id>           强制指定网盘，跳过自动识别
  --code <访问码>       私密分享的提取码（天翼/百度/迅雷等）
  --login              只做登录引导（扫码登录一次，凭据长期保存）
  --headless           无头模式（默认 headful，多数站点检测无头）
  -h, --help           显示本帮助

支持的网盘
${PANS.map((p) => `  ${p.id.padEnd(8)} ${p.name.padEnd(8)} ${p.needLogin ? '需要登录' : '免登录'}`).join('\n')}

示例
  下载器.exe pan "https://yfo.lanzoum.com/s/xxxx"
  下载器.exe pan "<链接>" --list
  下载器.exe pan "<链接>" -o D:\\网盘
`);
}

export async function run(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) { printHelp(); return 0; }

  // --login：只做登录引导，不解析链接
  if (opts.login) {
    const netId = opts.net || (opts.urls[0] ? (matchPan(opts.urls[0])?.id) : null) || 'quark';
    return doLogin(netId);
  }

  if (!opts.urls.length) { printHelp(); return 1; }

  const outDir = opts.out || path.join(process.cwd(), 'downloads', '网盘');

  // 分组：同一个浏览器实例可以连续处理多个链接，省启动开销
  const tasks = [];
  for (const url of opts.urls) {
    const pan = opts.net ? findPanById(opts.net) : matchPan(url);
    if (!pan) { warn(`跳过（无法识别的网盘）: ${url}`); continue; }
    tasks.push({ url, pan });
  }
  if (!tasks.length) { warn('没有可处理的链接'); return 1; }

  log(`\n共 ${tasks.length} 个链接，保存到 ${outDir}\n`);

  let browser = null;
  let cdp = null;
  let sessionId = null;
  let okCount = 0;
  let totalBytes = 0;

  try {
    for (const { url, pan } of tasks) {
      log(`━━━ ${pan.name}  ${url}`);
      const m = url.match(pan.sharePattern);
      if (!m) { warn(`  ✗ 链接格式不匹配 ${pan.name}`); continue; }

      // 每个任务一个独立 tab（复用同一个浏览器进程）
      if (!browser) {
        log('  启动浏览器...');
        browser = await launchBrowser({ headful: opts.headful });
        cdp = await connectCDP(browser.wsUrl);
      }
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const attach = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      sessionId = attach.sessionId;
      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Runtime.enable', {}, sessionId);

      const ctx = {
        url, shareId: m[1], cdp, sessionId,
        headful: opts.headful,
        accessCode: opts.accessCode,
      };

      let res;
      try {
        res = await pan.resolve(ctx);
      } catch (e) {
        warn(`  解析失败: ${e.message}`);
        continue;
      }

      if (!res.ok) {
        warn(`  ✗ ${res.reason}${res.hint ? ' — ' + res.hint : ''}`);
        continue;
      }

      log(`  ✓ 解析到 ${res.files.length} 个文件${res.note ? '（' + res.note + '）' : ''}`);

      // 解析器可以附带提示（比如「还没登录，下载需要先登录」）
      if (res.warn) {
        for (const line of String(res.warn).split('\n')) warn(`  ⚠ ${line}`);
      }

      if (opts.list) {
        for (const f of res.files) {
          // --deep：列出文件夹里的内容
          if (opts.deep && String(f.url || '').startsWith('quarkdir:')) {
            log(`     ${f.name}/ （展开中...）`);
            const inner = await expandQuarkFolder(
              { cdp, sessionId, shareId: f.shareId, stoken: f.stoken },
              f.fid
            );
            for (const g of inner) {
              log(`       ├ ${g.name}${g.size ? '  ' + fmtSize(g.size) : ''}`);
            }
            if (!inner.length) log('       （空文件夹）');
            continue;
          }
          log(`     ${f.name}${f.isFolder ? '/' : ''}${f.size ? '  ' + fmtSize(f.size) : ''}`);
        }
        continue;
      }

      // 逐个下载
      for (const f of res.files) {
        // 夸克文件夹：先递归展开，再逐个下
        if (String(f.url || '').startsWith('quarkdir:')) {
          log(`  展开文件夹: ${f.name}`);
          const inner = await expandQuarkFolder(
            { cdp, sessionId, shareId: f.shareId, stoken: f.stoken },
            f.fid
          );
          log(`    内含 ${inner.length} 个文件`);
          for (const g of inner) {
            log(`  下载: ${g.name}`);
            const gd = await browserDownload(
              browser.wsUrl, g.url, outDir, g.name, log
            );
            if (gd && gd.ok) {
              okCount++; totalBytes += gd.size || 0;
              log(`    ✓ ${fmtSize(gd.size || 0)}  ${gd.path}`);
            } else {
              warn(`    ✗ 失败: ${gd?.reason || 'unknown'}`);
            }
          }
          continue;
        }

        const target = path.join(outDir, safeName(f.name));
        log(`  下载: ${f.name}`);

        let dl;
        if (f.needsBrowser) {
          // 必须浏览器导航（有 JS 挑战的站点）
          dl = await browserDownload(browser.wsUrl, f.url, outDir, f.name, log);
        } else if (f.isFolderItem) {
          // 目录项：先进单文件页，再解析
          const sub = await pan.resolve({ ...ctx, url: f.url });
          if (!sub.ok || !sub.files.length) { warn(`    ✗ 展开失败: ${sub.reason}`); continue; }
          const inner = sub.files[0];
          dl = inner.needsBrowser
            ? await browserDownload(browser.wsUrl, inner.url, outDir, inner.name, log)
            : { ok: false, reason: 'unsupported' };
        } else {
          dl = await downloadFile(f.url, target, { referer: f.referer });
        }

        if (dl && dl.ok) {
          okCount++;
          totalBytes += dl.size || 0;
          log(`    ✓ ${fmtSize(dl.size || 0)}  ${dl.path || target}`);
        } else {
          warn(`    ✗ 失败: ${dl?.reason || 'unknown'}`);
        }
      }
    }
  } finally {
    if (browser) {
      try { if (fs.existsSync(browser.profileDir) && !opts.keepProfile) { /* 保留 profile 以复用登录 */ } } catch {}
      try { browser.proc.kill(); } catch {}
    }
  }

  log(`\n完成：${okCount} 个成功，共 ${fmtSize(totalBytes)}`);
  log(`保存目录: ${outDir}`);
  return okCount > 0 ? 0 : 1;
}
