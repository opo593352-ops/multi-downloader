#!/usr/bin/env node
/**
 * video-dl.mjs — 站点视频下载引擎（B站 / 优酷 / 腾讯 / 芒果 / 更多）
 *
 * 设计定位：
 *   抖音走自己的 douyin-dl.mjs（有专门的风控绕过），
 *   这里专攻「通用视频站」，靠三件外部能力组合：
 *
 *     yt-dlp  → 解析（站点规则天天变，自己写提取器维护不过来）
 *     ffmpeg  → 合并（B站的 1080p+ 都是 DASH 音视频分离流）
 *     Node    → 编排（选流、字幕、目录、命名、断点、进度）
 *
 * 为什么不让 yt-dlp 直接下载：
 *   它自己合并需要 ffmpeg 在 PATH，而且输出格式、字幕、进度都不可控。
 *   这里自己下分段再用 ffmpeg -c copy 合并，能做到：
 *     · 不重新编码（秒级完成，画质零损失）
 *     · 进度能在 UI 里精确显示
 *     · 字幕单独存 .srt，不硬压进画面
 *
 * 用法：
 *   node video-dl.mjs "https://www.bilibili.com/video/BVxxxx"
 *   node video-dl.mjs <url> -q 1080 -o D:\videos
 *   node video-dl.mjs <url> --subs              顺带下字幕
 *   node video-dl.mjs <url> --cookies-from chrome   用浏览器登录态（大会员画质）
 *   node video-dl.mjs <url> --json              只看有哪些清晰度，不下载
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { assertFeature, tempWorkDir } from '../dev/gate.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DEFAULT_OUT = path.join(os.homedir(), 'Downloads', 'Videos');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const warn = (...a) => console.error('[warn]', ...a);

// ───────────────────────── 工具 ─────────────────────────
function fmtSize(b) {
  if (!b) return '-';
  if (b > 1024 ** 3) return (b / 1024 ** 3).toFixed(2) + ' GB';
  if (b > 1024 ** 2) return (b / 1024 ** 2).toFixed(2) + ' MB';
  return (b / 1024).toFixed(0) + ' KB';
}

function safeName(s, max = 100) {
  return String(s || 'video')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim()
    .slice(0, max) || 'video';
}

function msToDur(sec) {
  if (!sec) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${m}:${String(ss).padStart(2, '0')}`;
}

/** 当前可执行文件所在目录（SEA 下是 exe 所在目录，源码下是脚本目录） */
function baseDir() {
  const exe = process.execPath || '';
  const name = path.basename(exe).toLowerCase();
  const isSea = name !== 'node.exe' && name !== 'node';
  if (isSea) return path.dirname(exe);
  return path.dirname(path.resolve(process.argv[1] || '.'));
}

// ───────────────────── ffmpeg 探测（三模式） ─────────────────────
/**
 * 探测顺序（任选其一命中即可）：
 *   1. 环境变量 FFMPEG_PATH
 *   2. 程序目录 / ffmpeg / 程序目录 / tools/ffmpeg
 *   3. PATH 里的 ffmpeg
 *   4. 用户目录 ~/.dsh-dl-tools/ffmpeg
 *
 * 之所以要这么多位置，是因为发布形态有三种：
 *   随包内置 / 用户自装 / 首次自动下载到用户目录。
 */
function findFfmpeg(explicit) {
  const exeName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates = [];

  if (explicit) candidates.push(explicit);
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);

  const bd = baseDir();
  candidates.push(
    path.join(bd, exeName),
    path.join(bd, 'ffmpeg', exeName),
    path.join(bd, 'tools', exeName),
    path.join(bd, 'bin', exeName),
    path.join(bd, 'ffmpeg', 'bin', exeName),
    path.join(os.homedir(), '.dsh-dl-tools', exeName),
  );

  for (const p of candidates) {
    try { if (p && fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch {}
  }

  // PATH 兜底
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], {
    encoding: 'utf-8', windowsHide: true,
  });
  if (r.status === 0 && r.stdout) {
    const first = String(r.stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first && fs.existsSync(first)) return first;
  }
  return null;
}

function ffmpegCaps(ff) {
  try {
    const r = spawnSync(ff, ['-version'], { encoding: 'utf-8', windowsHide: true, timeout: 15000 });
    if (r.status !== 0 || !r.stdout) return null;
    const first = String(r.stdout).split(/\r?\n/)[0] || '';
    const m = first.match(/ffmpeg version (\S+)/);
    const gpl = /--enable-gpl/.test(String(r.stdout));
    return { version: m ? m[1] : '?', gpl, banner: first.trim() };
  } catch {
    return null;
  }
}

// ───────────────────── yt-dlp 桥接 ─────────────────────
/**
 * yt-dlp 是 Python 程序。桥接策略，从快到慢：
 *   1. yt-dlp[.exe] 独立可执行（如果能拿到，最省事）
 *   2. python -m yt_dlp（用户装了 pip 包）
 *   3. 都没有 → 返回 null，由上层给出明确的安装指引
 *
 * 注意：yt-dlp 必须能联网。若系统配了坏代理（http_proxy 指向没开的端口），
 * 所有请求都会 "fetch failed" / "Unable to connect to proxy"。
 * 这里不擅自改用户的代理，只在报错时给出诊断提示。
 */
let ytdlpCache = null;

/**
 * 判断一条 python 命令是不是 Microsoft Store 的「应用执行别名」。
 *
 * 为什么必须判断：这种 python 实际上是 Python Install Manager
 * （`PythonSoftwareFoundation.PythonManager_*`），拿它跑
 * `python -m yt_dlp` 时如果 yt_dlp 没装，它**不会**报 "No module named"，
 * 而是联网下载并安装 Python 3.15，且装到**当前工作目录**。
 * 实测一次污染 180MB，直接落在 下载器.exe 旁边，用户会当成病毒。
 *
 * 判断方法：`where python` 找出所有匹配，只要有一个落在
 * `\Microsoft\WindowsApps\` 下就认定为别名（那目录全是 App Execution Alias）。
 * 拿不到就当作"不是别名"（保守：宁可多探一次，也不误杀真 python）。
 */
function isStorePythonAlias(cmd) {
  if (process.platform !== 'win32') return false;
  try {
    const r = spawnSync('where', [cmd], {
      encoding: 'utf-8', windowsHide: true, timeout: 5000, env: ytdlpEnv(),
    });
    const out = String(r.stdout || '');
    if (!out.trim()) return false;
    // where 会列出所有同名命中；Store 别名目录里的第一个就是别名
    const first = out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0] || '';
    if (!first) return false;
    if (/\\Microsoft\\WindowsApps\\/i.test(first)) return true;
    // 有些系统 where 被裁掉，退回直接看已知别名路径
    const alias = path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'Microsoft', 'WindowsApps', cmd + '.exe'
    );
    if (fs.existsSync(alias)) {
      // 别名存在且 where 的第一条就是它 → 认定为别名
      try {
        return path.resolve(first).toLowerCase() === path.resolve(alias).toLowerCase();
      } catch { return false; }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 保险丝：探测过程中如果 Python Manager 还是偷偷装了一份，
 * 把它产生的垃圾清掉（Python\ 目录 + python_install_*.log）。
 *
 * 只在「探测前后当前目录新出现了这些文件」时才删，绝不碰用户原有文件。
 */
function cleanupAccidentalPythonInstall(before) {
  try {
    const cwd = process.cwd();
    const entries = fs.readdirSync(cwd);
    for (const e of entries) {
      if (before.has(e)) continue;
      const full = path.join(cwd, e);
      if (e === 'Python' || /^python_install_\d+_\d+\.log$/.test(e)) {
        try { fs.rmSync(full, { recursive: true, force: true }); } catch {}
      }
    }
  } catch {}
}

function findYtdlp(explicit) {
  if (ytdlpCache !== undefined && ytdlpCache !== null && !explicit) return ytdlpCache;

  /**
   * 探测某条命令是不是可用的 yt-dlp。
   * 注意 prefix 与 verify 要分开：verify 里带 --version 只用于探测，
   * 绝不能留进 prefix，否则真正调用时会变成 "yt_dlp -J ... --version"，
   * yt-dlp 会忽略 -J 只打印版本号，然后就报"没返回 JSON"。
   */
  const probe = (cmd, prefix) => {
    let before = new Set();
    try { before = new Set(fs.readdirSync(process.cwd())); } catch {}
    try {
      const r = spawnSync(cmd, [...prefix, '--version'], {
        encoding: 'utf-8', windowsHide: true, timeout: 20000, env: ytdlpEnv(),
      });
      const out = String(r.stdout || '').trim();
      if (r.status === 0 && /\d{4}\.\d{2}\.\d{2}/.test(out)) {
        return { cmd, args: prefix, version: out.split(/\r?\n/).pop() };
      }
    } catch {}
    finally {
      // 无论成败都检查一次：Python Manager 的自动安装是副作用，
      // 不能让它在用户目录里留下 180MB 垃圾
      cleanupAccidentalPythonInstall(before);
    }
    return null;
  };

  if (explicit) return probe(explicit, []);

  // 1) 独立 exe
  const bd = baseDir();
  for (const p of [
    path.join(bd, 'yt-dlp.exe'),
    path.join(bd, 'tools', 'yt-dlp.exe'),
    path.join(os.homedir(), '.dsh-dl-tools', 'yt-dlp.exe'),
  ]) {
    if (fs.existsSync(p)) {
      const r = probe(p, []);
      if (r) { ytdlpCache = r; return r; }
    }
  }
  // PATH 里的 yt-dlp
  {
    const r = probe('yt-dlp', []);
    if (r) { ytdlpCache = r; return r; }
  }

  // 2) python -m yt_dlp
  //
  //    ── 这里有个比「不能试 py」更狠的坑（实测踩到，2026-10-25）──
  //
  //    交接文档原来只写了「别试 py.exe，它是 Python Manager，会自动装 3.15」。
  //    实测发现 **python / python3 同样会**，只要它们指向 Microsoft Store
  //    的 App Execution Alias：
  //
  //      %LOCALAPPDATA%\Microsoft\WindowsApps\python.exe
  //        -> C:\Program Files\WindowsApps\PythonSoftwareFoundation.PythonManager_*\python.exe
  //
  //    这时执行 `python -m yt_dlp --version`（yt_dlp 没装）不会报
  //    "No module named yt_dlp"，而是：
  //        1. 联网读 https://www.python.org/ftp/python/index-windows.json
  //        2. 下载 python-3.15.1-amd64.zip（~30MB）
  //        3. **装到当前工作目录**（!!）—— 用户会看到
  //           下载器.exe 旁边突然多出 Python\ 目录和 python_install_*.log
  //
  //    实测一次污染就是 180MB，而且装在发布目录里，看起来像病毒行为。
  //
  //    所以：**探测前先判断这条 python 是不是 Store 别名**，
  //    是就跳过（一律不碰），只认真正的解释器。
  for (const py of ['python', 'python3']) {
    if (isStorePythonAlias(py)) continue;
    const r = probe(py, ['-m', 'yt_dlp']);
    if (r) { ytdlpCache = r; return r; }
  }

  // 3) 常见安装位置兜底（Windows 上 python 常被 Microsoft Store 的
  //    应用执行别名劫持，PATH 里那个 python 未必是真的解释器）
  const pyRoots = [
    path.join(os.homedir(), 'AppData', 'Local', 'Python'),
    'C:\\Python',
    'C:\\Program Files\\Python',
  ];
  for (const root of pyRoots) {
    try {
      if (!fs.existsSync(root)) continue;
      const entries = fs.readdirSync(root);
      for (const e of entries) {
        if (!/^pythoncore-\d/.test(e)) continue;
        const exe = path.join(root, e, 'python.exe');
        if (!fs.existsSync(exe)) continue;
        const r = probe(exe, ['-m', 'yt_dlp']);
        if (r) { ytdlpCache = r; return r; }
      }
    } catch {}
  }

  ytdlpCache = null;
  return null;
}

/** 把 yt-dlp 的原始 stderr 翻译成能照着做的中文提示 */
function explainYtdlpError(stderr, url) {
  const s = String(stderr || '');
  if (/Unable to connect to proxy|ProxyError/i.test(s)) {
    return '代理连接失败。系统环境变量里的 http_proxy/https_proxy 指向的代理没有运行。\n' +
           '     处理：关掉代理软件，或清空 HTTP_PROXY/HTTPS_PROXY 后重试。';
  }
  if (/is not a valid URL|Unsupported URL/i.test(s)) {
    return 'yt-dlp 不认识这个链接。确认是视频页地址（不是首页/搜索结果）。';
  }

  // 站点改版导致提取器失效，是最常见的一类"莫名其妙"报错
  if (/Can't find any video|Unable to extract|No video formats found/i.test(s)) {
    return '解析不到视频。常见原因：\n' +
           '     1) 站点改版导致提取器失效（此时换任何链接都报同样的错）；\n' +
           '     2) 视频已下架、地区限制，或链接是活动页/搜索结果页；\n' +
           '     3) 内容受付费墙保护，未登录只下发预告片。\n' +
           '     判断方法：浏览器里打开同一链接——\n' +
           '       · 能正常播 → 提取器失效，升级 yt-dlp 或等社区修复；\n' +
           '       · 提示开通会员 → 付费内容，本软件不提供绕过；\n' +
           '       · 提示下架/地区限制 → 换内容或换网络。';
  }

  if (/DRM|drm protected/i.test(s)) {
    return '该内容受 DRM（数字版权管理）保护。\n' +
           '     本软件不支持也无法处理 DRM 内容——请通过官方渠道观看。';
  }
  if (/HTTP Error 403/i.test(s)) {
    return '站点返回 403。多半是防盗链或风控，试 --cookies-from chrome。';
  }
  if (/Geo|not available in your country/i.test(s)) {
    return '地区限制，当前网络出口不在允许范围。';
  }
  const last = s.split('\n').map((x) => x.trim()).filter(Boolean).slice(-3).join(' | ');
  return last || '未知错误';
}

/**
 * yt-dlp 的运行环境：默认剔除代理变量。
 *
 * 很多机器上 http_proxy 指向一个没开的端口（clash/v2ray 关掉后环境变量还在），
 * yt-dlp 会直接报 "Unable to connect to proxy"，看起来像站点挂了。
 * 真要代理时设 DSH_DL_USE_PROXY=1 即可继承。
 */
function ytdlpEnv() {
  if (process.env.DSH_DL_USE_PROXY === '1') return process.env;
  const env = { ...process.env };
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    delete env[k];
  }
  return env;
}

/** 调 yt-dlp 取元数据（-J），返回解析后的 JSON */
function ytdlpInfo(tool, url, opts = {}) {
  // --no-playlist：默认只解析单个视频，避免一个链接哗啦拉出上百个分P。
  // 需要整季/多分P 时用 --all-parts（见 parseArgs）。
  const args = [...tool.args, '-J', '--no-warnings'];
  args.push(opts.allParts ? '--yes-playlist' : '--no-playlist');
  if (opts.cookiesFrom) args.push('--cookies-from-browser', opts.cookiesFrom);
  if (opts.cookiesFile) args.push('--cookies', opts.cookiesFile);
  if (opts.extraArgs) args.push(...opts.extraArgs);
  args.push(url);

  // encoding:'buffer' 而不是 'utf-8'：Windows 控制台代码页不是 UTF-8 时，
  // 直接按 utf-8 解码会把中文标题弄成乱码，还会让 JSON 解析错位。
  const r = spawnSync(tool.cmd, args, {
    encoding: 'buffer',
    windowsHide: true,
    timeout: 180000,
    maxBuffer: 128 * 1024 * 1024,
    env: ytdlpEnv(),
  });

  if (r.error) throw new Error(`调用 yt-dlp 失败: ${r.error.message}`);
  const stdout = r.stdout ? r.stdout.toString('utf-8') : '';
  const stderr = r.stderr ? r.stderr.toString('utf-8') : '';
  if (r.status !== 0) throw new Error(explainYtdlpError(stderr, url));

  // yt-dlp 偶尔在 JSON 前后夹带别的输出（警告行、更新提示）。
  // 精确截取第一个 { 到最后一个 }，避免
  // "Unexpected non-whitespace character after JSON"。
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('yt-dlp 没有返回 JSON（链接无效，或需要登录）');
  }
  const body = stdout.slice(start, end + 1);
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Error(`yt-dlp 返回的 JSON 解析失败: ${e.message}｜前 200 字: ${body.slice(0, 200)}`);
  }
}

// ───────────────────── 流选择 ─────────────────────
/**
 * 从 formats 里挑视频流和音频流。
 *
 * 关键规则：
 *   · video_only 流（B站的 1080p+）必须配一条 audio_only，否则没声音
 *   · muxed 流（低清常见）自带音轨，不需要 ffmpeg 合并
 *   · 同等高度下优先 avc1/h264（兼容性最好），其次 vp9/av01（体积小但老设备可能不认）
 */
const CODEC_PREF = { avc1: 3, h264: 3, vp09: 2, vp9: 2, av01: 1, hev1: 1, hvc1: 1 };

function pickStreams(info, want = 'best') {
  const formats = (info.formats || []).filter((f) => f.url || f.fragments);
  const score = (f, key) => {
    const v = String(f[key] || '');
    for (const k of Object.keys(CODEC_PREF)) if (v.startsWith(k)) return CODEC_PREF[k];
    return 0;
  };

  const isVideo = (f) => f.vcodec && f.vcodec !== 'none';
  const isAudioOnly = (f) => (!f.vcodec || f.vcodec === 'none') && f.acodec && f.acodec !== 'none';
  const isMuxed = (f) => isVideo(f) && f.acodec && f.acodec !== 'none';

  const target = (() => {
    const m = { '4k': 2160, '2160': 2160, '1440': 1440, '1080': 1080, '720': 720, '480': 480, '360': 360 };
    return m[String(want).toLowerCase()] || null;
  })();

  // 候选视频：分离流 + 封装流一起考虑
  let vids = formats.filter((f) => isVideo(f) && f.height);
  if (target) {
    const fit = vids.filter((f) => f.height <= target + 20);
    if (fit.length) vids = fit;
  }
  if (!vids.length) vids = formats.filter(isVideo);

  vids.sort((a, b) => {
    if (b.height !== a.height) return (b.height || 0) - (a.height || 0);
    const cs = score(b, 'vcodec') - score(a, 'vcodec');
    if (cs) return cs;
    return (b.tbr || 0) - (a.tbr || 0);
  });

  const best = vids[0];
  if (!best) return { video: null, audio: null, muxed: false };

  // 封装流：自带音轨，一步到位
  if (isMuxed(best)) return { video: best, audio: null, muxed: true };

  // 分离流：挑最合适的音频
  let auds = formats.filter(isAudioOnly);
  auds.sort((a, b) => {
    const cs = score(b, 'acodec') - score(a, 'acodec');
    if (cs) return cs;
    return (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0);
  });
  return { video: best, audio: auds[0] || null, muxed: false };
}

/** 列出所有可选清晰度（给 --json / UI 下拉框用） */
function listQualities(info) {
  const formats = (info.formats || []).filter((f) => f.vcodec && f.vcodec !== 'none');
  const seen = new Map();
  for (const f of formats) {
    const h = f.height || 0;
    const key = h + '|' + (f.ext || '');
    const cur = seen.get(key);
    const tbr = f.tbr || 0;
    if (!cur || tbr > cur.tbr) {
      seen.set(key, {
        height: h,
        ext: f.ext || '',
        tbr: Math.round(tbr),
        vcodec: String(f.vcodec || '').split('.')[0],
        acodec: f.acodec && f.acodec !== 'none' ? String(f.acodec).split('.')[0] : null,
        muxed: !!(f.acodec && f.acodec !== 'none'),
        size: f.filesize || f.filesize_approx || 0,
        fid: f.format_id,
      });
    }
  }
  return [...seen.values()].sort((a, b) => b.height - a.height);
}

// ───────────────────── 下载 ─────────────────────
/**
 * 下载单个 URL 到文件。带进度回调。
 * 支持 HTTP 分段（fragments）—— B站的 fMP4 就是分片的，
 * yt-dlp 给的 url 通常是完整流，但保险起见都走同一路径。
 */
/**
 * 下载单个 URL 到文件，支持断点续传。
 *
 * 为什么要续传：B站的视频流动辄几十上百 MB，家庭宽带跑十几分钟很正常。
 * 中途断一次就从头再来，用户体验会崩。这里用 Range 从已有字节处接着下。
 *
 * dest 已存在且小于远端总长 → 发 Range: bytes=<已有>-  续传。
 * 服务器不支持 Range（返回 200 而不是 206）→ 退回从头写。
 */
async function downloadUrl(url, dest, referer, onProgress, extraHeaders) {
  const headers = {
    'User-Agent': UA,
    Accept: '*/*',
    ...(referer ? { Referer: referer } : {}),
    ...(extraHeaders || {}),
  };

  await fsp.mkdir(path.dirname(dest), { recursive: true });

  let startAt = 0;
  try {
    const st = await fsp.stat(dest);
    if (st.size > 0) startAt = st.size;
  } catch {}

  const reqHeaders = { ...headers };
  if (startAt > 0) reqHeaders.Range = `bytes=${startAt}-`;

  // ── 超时策略 ──
  //
  // 两层保护，缺一不可：
  //
  //   1. 总时长上限（IDLE_TOTAL_MS）：防止慢速滴流拖几个小时
  //   2. **空闲超时**（IDLE_STALL_MS）：连续这么久没收到新字节就中断
  //
  // 为什么必须有第 2 层（实测踩过）：
  //   测试者反馈「等 210 秒卡在最后一点完全下不动」。
  //   原来只靠 fetch 自己的 TCP 超时，卡住后要等好几分钟。
  //   总时长限制也救不了 —— 卡住前都是正常速度，时间预算还够。
  //   只有"多久没收到数据"这个判据能立刻发现卡死。
  const IDLE_STALL_MS = 30_000;        // 30 秒没新数据 → 判定卡死
  const IDLE_TOTAL_MS = 30 * 60_000;   // 单个文件最长 30 分钟

  const ctrl = new AbortController();
  let stalled = false;
  let lastByteAt = Date.now();
  let totalTimer = null;

  const armTotal = () => {
    if (totalTimer) clearTimeout(totalTimer);
    totalTimer = setTimeout(() => { try { ctrl.abort(); } catch {} }, IDLE_TOTAL_MS);
    totalTimer.unref?.();
  };
  armTotal();

  // 看门狗：每 5 秒查一次"上次收到数据是什么时候"
  const watchdog = setInterval(() => {
    if (Date.now() - lastByteAt > IDLE_STALL_MS) {
      stalled = true;
      try { ctrl.abort(); } catch {}
    }
  }, 5_000);
  watchdog.unref?.();

  let res;
  try {
    res = await fetch(url, {
      headers: reqHeaders,
      redirect: 'follow',
      signal: ctrl.signal,
    });
  } catch (e) {
    clearInterval(watchdog);
    if (totalTimer) clearTimeout(totalTimer);
    if (stalled) throw new Error(`连接卡住（${IDLE_STALL_MS / 1000} 秒无响应），已保留已下载部分`);
    throw new Error(`连接失败: ${e.message}`);
  }
  if (!res.ok && res.status !== 206) {
    clearInterval(watchdog);
    if (totalTimer) clearTimeout(totalTimer);
    throw new Error(`下载失败 HTTP ${res.status}`);
  }

  // 服务器不认 Range，返回 200 全量 → 必须从头写，否则文件会错位
  const resuming = res.status === 206 && startAt > 0;
  if (!resuming && startAt > 0) {
    startAt = 0;
    try { await fsp.rm(dest, { force: true }); } catch {}
  }

  // content-length 在续传时是「剩余长度」，总长要加上已下部分
  let total = Number(res.headers.get('content-length') || 0);
  if (total) total += startAt;

  const file = fs.createWriteStream(dest, { flags: resuming ? 'a' : 'w' });
  let got = startAt;
  let lastTick = 0;
  if (startAt > 0 && onProgress) onProgress(startAt, total);
  try {
    for await (const chunk of res.body) {
      got += chunk.length;
      lastByteAt = Date.now();          // ← 看门狗靠它判断"还在动"
      if (!file.write(chunk)) await new Promise((r) => file.once('drain', r));
      const now = Date.now();
      if (onProgress && now - lastTick > 300) {
        lastTick = now;
        onProgress(got, total);
      }
    }
  } catch (e) {
    // 看门狗掐断时会抛 AbortError，转成人话
    if (stalled) {
      throw new Error(
        `下载卡住（${IDLE_STALL_MS / 1000} 秒没有新数据）\n` +
        `     已下载 ${fmtSize(got)}${total ? '/' + fmtSize(total) : ''}，` +
        `重新运行会从这里续传`
      );
    }
    throw e;
  } finally {
    clearInterval(watchdog);
    if (totalTimer) clearTimeout(totalTimer);
    await new Promise((r) => file.end(r));
  }
  if (onProgress) onProgress(got, total);
  if (total && got !== total) {
    throw new Error(`下载不完整 ${fmtSize(got)}/${fmtSize(total)}（重新运行会续传）`);
  }
  return got;
}

/**
 * CDN 多路回退。
 *
 * 真实痛点：B站视频流常给随机第三方 CDN 域名（非标准端口，部分网络不通），
 * 某些网络出口到这些非标准端口的连接会超时，但把同一个 path 换到官方
 * upos-*.bilivideo.com 就正常。yt-dlp 自己不会换，只能重试到放弃。
 *
 * 这里把 URL 拆成 path，逐个镜像试，第一个能连上（2xx/206）的就用。
 * 只对已知站点生效，避免给任意站点乱换域名（那会变成 SSRF 风险）。
 */
/**
 * CDN 镜像表 —— 不硬编码，从激活资源里取。
 *
 * 这是"卡密参与真实运算"的落点：
 *   镜像表是 B站下载**必需**的（第三方 CDN 在多数网络下连不上，
 *   没有回退就下不动）。它被卡密派生 key 加密后存进激活码，
 *   所以伪造卡密 → 解不出表 → 下载在 CDN 不通时直接失败。
 *
 * 命中条件：resolveReachableUrl 拿不到活着的原地址，且镜像表为空
 *          → 抛错并提示"未激活/激活失效"。
 */
let _activeMirrors = null;

/** 由 cli 在启动时注入已解密的资源 */
export function setActiveResource(res) {
  if (res && res.mirrors) _activeMirrors = res.mirrors;
}

function looksLikeBilibili(rawUrl) {
  try {
    const h = new URL(rawUrl).hostname;
    // 站点特征用拼接，避免二进制里出现完整明文（防 strings 抄方案）
    // 全部分段拼接：minify 会折叠 'a'+'b'，所以用数组 join
    const parts = ['bili', 'bili|bili', 'video|mount', 'aintoys|hdslb'];
    const mark = parts.join('');
    return new RegExp(mark, 'i').test(h);
  } catch { return false; }
}

function mirrorsFor(host) {
  const table = _activeMirrors;
  if (!table) return [];
  const biliMark = 'mount' + 'aintoys';
  if (host.includes('bilibili') || host.includes('bilivideo') || host.includes(biliMark)) {
    return table.bilibili || [];
  }
  return [];
}

/** 判断这个 URL 属于哪个站点的 CDN 家族，返回可替换的镜像列表 */
function mirrorCandidates(rawUrl) {
  let host;
  try { host = new URL(rawUrl).hostname; } catch { return []; }
  return mirrorsFor(host);
}

/**
 * 用 Range 请求快速探活（不下载整个文件）
 *
 * ⚠ 定时器必须 unref + 在 finally 里清掉。
 *   旧写法 `clearTimeout(to)` 只写在成功路径上，fetch 抛错（DNS 失败、
 *   TLS 握手被断、CDN 直接 RST）时定时器会**留在事件循环里 12 秒**。
 *   站点视频一个任务要探活 4~6 次（原地址 + 每个镜像），
 *   全部失败时进程就要空转十几秒才退 —— UI 的 WaitForExit() 看起来又是"卡死"。
 *   这和交接文档坑 0（CDP 60 秒定时器）是同一类错误，只是短一些、
 *   更容易被误判成"网络慢"。
 */
async function urlAlive(rawUrl, headers, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  to.unref?.();
  try {
    const res = await fetch(rawUrl, {
      headers: { ...headers, Range: 'bytes=0-1023' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    // 206 = 支持 Range，200 = 不支持但可用
    const ok = res.status === 200 || res.status === 206;
    try { await res.arrayBuffer(); } catch {}
    return ok;
  } catch {
    return false;
  } finally {
    clearTimeout(to);
  }
}

/**
 * 找一个能连上的 URL。原地址优先，不通再换镜像。
 * 返回 { url, switched } 。
 */
async function resolveReachableUrl(rawUrl, headers) {
  if (await urlAlive(rawUrl, headers)) return { url: rawUrl, switched: false };

  const mirrors = mirrorCandidates(rawUrl);
  if (!mirrors.length) {
    // 没有镜像表：要么未激活，要么该站点本来就不需要镜像
    if (looksLikeBilibili(rawUrl) && !_activeMirrors) {
      throw new Error(
        '原 CDN 不可达，且本地没有可用的镜像表（未激活或激活已失效）。\n' +
        '     请用有效激活码激活后再试；或换其他网络环境。'
      );
    }
    return { url: rawUrl, switched: false };
  }

  let parsed;
  try { parsed = new URL(rawUrl); } catch { return { url: rawUrl, switched: false }; }
  const pathAndQuery = parsed.pathname + parsed.search;

  process.stderr.write(`\n  原 CDN 不可达，尝试镜像...\n`);
  for (const host of mirrors) {
    const candidate = `https://${host}${pathAndQuery}`;
    if (await urlAlive(candidate, headers)) {
      log(`  ✓ 改用镜像: ${host}`);
      return { url: candidate, switched: true };
    }
    process.stderr.write(`    ${host} 不通\n`);
  }
  return { url: rawUrl, switched: false };
}

async function downloadWithRetry(url, dest, referer, onProgress, retries = 3) {
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    try {
      return await downloadUrl(url, dest, referer, onProgress);
    } catch (e) {
      lastErr = e;
      // 故意不删临时文件：下次重试会从断点续传（Range）。
      // 只有确认是"内容不完整"这种不可续的错误才清空重来。
      if (/HTTP 4\d\d/.test(e.message)) {
        try { await fsp.rm(dest, { force: true }); } catch {}
      }
      if (i < retries - 1) {
        process.stderr.write(`\n  重试 ${i + 1}/${retries - 1}（${e.message}）\n`);
        await sleep(1000 * (i + 1));
      }
    }
  }
  throw lastErr;
}

/**
 * ffmpeg 合并。用 -c copy：不重编码，秒级完成。
 * 容器选 mp4（兼容性最好）；如果音轨是 opus 且用户要 mp4，
 * 会提示可能需要重新编码——这里优先保证「能播」。
 */
function mergeWithFfmpeg(ff, videoFile, audioFile, outFile) {
  return new Promise((resolve, reject) => {
    const args = ['-y', '-hide_banner', '-loglevel', 'error'];
    args.push('-i', videoFile);
    if (audioFile) args.push('-i', audioFile);
    args.push('-c', 'copy');
    if (audioFile) args.push('-map', '0:v:0', '-map', '1:a:0');
    args.push('-movflags', '+faststart', outFile);

    const proc = spawn(ff, args, { windowsHide: true });
    let err = '';
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', (e) => reject(new Error(`ffmpeg 启动失败: ${e.message}`)));
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 合并失败 (exit ${code}): ${err.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
}

/** 探测媒体时长（用于校验合并结果） */
function probeDuration(ff, file) {
  try {
    const r = spawnSync(ff, ['-hide_banner', '-i', file], {
      encoding: 'utf-8', windowsHide: true, timeout: 20000,
    });
    const txt = String(r.stderr || '');
    const m = txt.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
    if (!m) return 0;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  } catch {
    return 0;
  }
}

// ───────────────────── 字幕 ─────────────────────
/**
 * 下字幕。优先人工字幕，其次自动字幕；优先中文，其次英文。
 * yt-dlp 的 subtitles 里是各种格式的 URL 列表，挑第一个可用的。
 */
const SUB_PREF = ['zh-Hans', 'zh-CN', 'zh', 'zh-Hant', 'zh-TW', 'en', 'en-US'];

function pickSubtitle(info) {
  const manual = info.subtitles || {};
  const auto = info.automatic_captions || {};
  const pickFrom = (dict) => {
    const keys = Object.keys(dict);
    if (!keys.length) return null;
    for (const want of SUB_PREF) {
      const hit = keys.find((k) => k === want || k.startsWith(want));
      if (hit) return { lang: hit, list: dict[hit] };
    }
    return { lang: keys[0], list: dict[keys[0]] };
  };
  const m = pickFrom(manual);
  if (m) return { ...m, auto: false };
  const a = pickFrom(auto);
  if (a) return { ...a, auto: true };
  return null;
}

function pickSubUrl(list) {
  if (!Array.isArray(list) || !list.length) return null;
  // 优先 srt / vtt，ext 里带 json3 的是结构化数据不好直接用
  const pref = ['srt', 'vtt'];
  for (const e of pref) {
    const hit = list.find((x) => String(x.ext || '').toLowerCase() === e);
    if (hit && hit.url) return { url: hit.url, ext: e };
  }
  const any = list.find((x) => x.url);
  return any ? { url: any.url, ext: String(any.ext || 'txt') } : null;
}

// ───────────────────── 主流程 ─────────────────────
/**
 * 入口分发：普通单视频，或播放列表/多分P/番剧整季。
 * 番剧 URL 常给出 entries[]，这时候逐个处理，别只下第一集。
 */
async function handleEntry(url, opts, ctx) {
  let first;
  try {
    first = ytdlpInfo(ctx.ytdlp, url, opts);
  } catch (e) {
    // Chrome 正在运行时，它的 cookie 库被独占锁定，yt-dlp 拷不出来会直接报错。
    // 这不是致命问题：降级成"不用 cookie"再试一次，能下就下。
    const msg = String(e.message || '');
    const cookieIssue = /cookie database|could not copy|failed to decrypt|DPAPI/i.test(msg);
    if (cookieIssue && (opts.cookiesFrom || opts.cookiesFile)) {
      warn('读取浏览器 cookie 失败（多半是浏览器正在运行，数据库被锁）');
      warn('本次改为不带 cookie 重试。要拿会员画质，请先完全退出浏览器。');
      const noCookie = { ...opts, cookiesFrom: null, cookiesFile: null };
      first = ytdlpInfo(ctx.ytdlp, url, noCookie);
      opts = noCookie;
    } else {
      throw e;
    }
  }

  const entries = Array.isArray(first.entries) ? first.entries.filter(Boolean) : null;
  if (!entries || !entries.length) {
    return [await handleOne(url, opts, ctx, first)];
  }

  log(`\n━━━ 播放列表: ${first.title || url}  （共 ${entries.length} 项）`);

  if (!opts.allParts) {
    log(`  只下载第 1 项。要全部下载请加 --all-parts`);
  }

  const picked = opts.allParts ? entries : entries.slice(0, 1);
  const groupName = safeName(first.title || 'playlist', 80);
  const results = [];

  for (let i = 0; i < picked.length; i++) {
    const e = picked[i];
    const eu = e.webpage_url || e.url || (e.id ? `https://www.bilibili.com/video/${e.id}` : null);
    if (!eu) continue;
    log(`\n  ── [${i + 1}/${picked.length}] ${e.title || eu}`);
    try {
      // 子项放进以列表名命名的子目录，避免几十个文件糊在一个目录里
      const subOpts = { ...opts, out: path.join(opts.out, groupName) };
      results.push(await handleOne(eu, subOpts, ctx));
    } catch (err) {
      warn(`  ✗ ${e.title || eu}: ${err.message}`);
    }
  }
  return results;
}

async function handleOne(url, opts, ctx, preInfo) {
  log(`\n━━━ 处理: ${url}`);

  // 1) 解析（复用它已经拿到的元数据，别重复请求）
  const info = preInfo || ytdlpInfo(ctx.ytdlp, url, opts);
  const title = info.title || info.id || 'video';
  const dur = info.duration || 0;
  const uploader = info.uploader || info.channel || '';

  log(`  站点: ${info.extractor || '?'}`);
  log(`  标题: ${title}`);
  if (uploader) log(`  作者: ${uploader}`);
  if (dur) log(`  时长: ${msToDur(dur)}`);

  const quals = listQualities(info);
  if (!quals.length) throw new Error('没有任何可用视频流（可能是直播/付费/DRM）');
  log(`  清晰度: ${quals.slice(0, 8).map((q) => q.height + 'p' + (q.muxed ? '' : '(分离)')).join(' | ')}`);

  const streams = pickStreams(info, opts.quality);
  if (!streams.video) throw new Error('没挑出可下载的视频流');

  const chosen = `${streams.video.height || '?'}p` +
    (streams.muxed ? ' 封装' : (streams.audio ? ' + 音频' : ' ⚠无音轨'));
  log(`  选定: ${chosen}  [${streams.video.vcodec || '?'} ${streams.video.ext || ''}]`);

  if (opts.jsonOnly) {
    return {
      url, title, uploader, duration: dur, extractor: info.extractor,
      qualities: quals,
      picked: {
        height: streams.video.height, vcodec: streams.video.vcodec,
        ext: streams.video.ext, tbr: Math.round(streams.video.tbr || 0),
        muxed: streams.muxed,
        acodec: streams.audio ? streams.audio.acodec : null,
      },
    };
  }

  // 2) 准备目录
  const base = safeName(title, 90);
  const outDir = opts.out;
  // 目录建不出来时给能照做的提示，而不是裸 EPERM。
  // 实测：`-o /tmp/x` 在 Git-Bash 里会被转成 C:\Windows\x，
  // 报 "EPERM: operation not permitted, mkdir 'C:\Windows\x'" ——
  // 用户完全看不懂发生了什么。
  try {
    await fsp.mkdir(outDir, { recursive: true });
  } catch (e) {
    throw new Error(
      `无法创建输出目录：${outDir}\n` +
      `     原因：${e.code || e.message}\n` +
      `     处理：换一个你有写权限的目录，例如 -o "D:\\下载" 或 -o "%USERPROFILE%\\Downloads"`
    );
  }
  const finalExt = streams.muxed ? (streams.video.ext || 'mp4') : 'mp4';
  const dest = path.join(outDir, `${base}_${streams.video.height || 0}p.${finalExt}`);

  // 临时目录名带授权票（见 dev/gate.mjs 的 tempWorkDir）。
  // 破解者只把 checkFeature 改成 return {ok:true} 是没用的 ——
  // 这里拿不到票就直接抛 ELOCKED，任务根本开不了工。
  const tmpDir = await tempWorkDir('sites', 'vdl');
  const files = [];

  try {
    // 3) 下视频流
    const referer = info.webpage_url || url;
    const headers = {};
    // 部分站点需要 Origin，yt-dlp 的 http_headers 里有就带上
    if (info.http_headers && info.http_headers.Referer) delete headers.Referer;

    // 探活 + CDN 回退：B站的第三方 CDN 常连不上，换成官方镜像就通
    const vh = { 'User-Agent': UA, Referer: referer, Accept: '*/*' };
    const vResolved = await resolveReachableUrl(streams.video.url, vh);

    log('  下载视频流...');
    const vTmp = path.join(tmpDir, 'video.' + (streams.video.ext || 'mp4'));
    await downloadWithRetry(
      vResolved.url, vTmp, referer,
      (got, total) => {
        if (total) {
          const pct = Math.floor((got / total) * 100);
          process.stderr.write(`\r    ${streams.muxed ? '视频' : '视频'}(无音轨) ${pct}%  ${fmtSize(got)}/${fmtSize(total)}   `);
        } else {
          process.stderr.write(`\r    视频 ${fmtSize(got)}   `);
        }
      }
    );
    process.stderr.write('\n');
    log(`  ✓ 视频流 ${fmtSize((await fsp.stat(vTmp)).size)}`);

    // 4) 下音频流（如果不是封装流）
    //
    // ⚠ 音频失败不能直接把整个任务判死。
    //   实测（2026-10-27，B站 BV1GJ411x7h7）：视频流走镜像成功 8.86 MB，
    //   紧接着音频流的四个镜像**同时**不通，重试两次后整个任务失败 ——
    //   已经下好的 8.86 MB 视频被一起丢掉，用户什么都拿不到。
    //   而同样的命令重跑一次就全通了（B站 CDN 本身就是波动的）。
    //
    //   正确做法：音频失败 → 先把视频流单独交付，明确告诉用户"没有音轨"，
    //   让用户至少能看画面、也能自己重跑。别把已经到手的字节扔掉。
    let aTmp = null;
    let audioErr = null;
    if (!streams.muxed && streams.audio) {
      log('  下载音频流...');
      try {
        const aResolved = await resolveReachableUrl(streams.audio.url, vh);
        aTmp = path.join(tmpDir, 'audio.' + (streams.audio.ext || 'm4a'));
        await downloadWithRetry(
          aResolved.url, aTmp, referer,
          (got, total) => {
            if (total) {
              const pct = Math.floor((got / total) * 100);
              process.stderr.write(`\r    音频 ${pct}%  ${fmtSize(got)}/${fmtSize(total)}   `);
            } else {
              process.stderr.write(`\r    音频 ${fmtSize(got)}   `);
            }
          }
        );
        process.stderr.write('\n');
        log(`  ✓ 音频流 ${fmtSize((await fsp.stat(aTmp)).size)}`);
      } catch (e) {
        // 清掉半截文件，别让它进合并
        if (aTmp) { try { await fsp.rm(aTmp, { force: true }); } catch {} }
        aTmp = null;
        audioErr = e;
        process.stderr.write('\n');
        warn(`  ✗ 音频流下载失败：${e.message}`);
        warn('    视频流已下好，先单独交付（无音轨）。CDN 波动很常见，重跑一次通常就好。');
      }
    }

    // 5) 合并
    if (aTmp) {
      if (!ctx.ffmpeg) {
        // 没有 ffmpeg：分别保留，明确告诉用户怎么办
        const vOut = path.join(outDir, `${base}_${streams.video.height || 0}p.video.${streams.video.ext || 'mp4'}`);
        const aOut = path.join(outDir, `${base}.audio.${streams.audio.ext || 'm4a'}`);
        await fsp.copyFile(vTmp, vOut);
        await fsp.copyFile(aTmp, aOut);
        warn('没有 ffmpeg，无法合并音视频。已分别保存两个文件。');
        warn('  装好 ffmpeg 后重跑，或手动执行：');
        warn(`  ffmpeg -i "${vOut}" -i "${aOut}" -c copy "${dest}"`);
        files.push(vOut, aOut);
        return { url, title, duration: dur, extractor: info.extractor, files, merged: false };
      }
      log('  合并音视频（-c copy，不重编码）...');
      await mergeWithFfmpeg(ctx.ffmpeg, vTmp, aTmp, dest);
      const sz = (await fsp.stat(dest)).size;
      const d1 = probeDuration(ctx.ffmpeg, dest);
      log(`  ✓ 合并完成 ${fmtSize(sz)}${d1 ? '  时长 ' + msToDur(d1) : ''}`);
      if (dur && d1 && Math.abs(d1 - dur) > 3) {
        warn(`合并后时长 ${msToDur(d1)} 与原始 ${msToDur(dur)} 有差异，可能有截断`);
      }
      files.push(dest);
    } else if (audioErr) {
      // 音频没下来，但视频流是好的 —— 单独交付，文件名标明「无音轨」，
      // 避免用户以为拿到了完整视频（拿播放器一放没声音，只会来投诉）。
      const vOnly = path.join(outDir, `${base}_${streams.video.height || 0}p_无音轨.${streams.video.ext || 'mp4'}`);
      await fsp.copyFile(vTmp, vOnly);
      const sz = (await fsp.stat(vOnly)).size;
      log(`  ✓ 视频（无音轨）${fmtSize(sz)}`);
      warn(`  音频流没下下来（${audioErr.message}）—— 已单独保存视频，重跑可拿到完整版`);
      files.push(vOnly);
    } else {
      // 封装流（自带音轨），直接搬过去
      await fsp.copyFile(vTmp, dest);
      const sz = (await fsp.stat(dest)).size;
      log(`  ✓ 视频 ${fmtSize(sz)}`);
      files.push(dest);
    }

    // 6) 字幕
    if (opts.subs) {
      const sub = pickSubtitle(info);
      if (sub) {
        const su = pickSubUrl(sub.list);
        if (su) {
          try {
            log(`  下载字幕 [${sub.lang}${sub.auto ? ' 自动' : ''}]...`);
            const subDest = path.join(outDir, `${base}.${sub.lang}.${su.ext}`);
            await downloadWithRetry(su.url, subDest, referer);
            const st = (await fsp.stat(subDest)).size;
            log(`  ✓ 字幕 ${path.basename(subDest)} (${fmtSize(st)})`);
            files.push(subDest);
          } catch (e) {
            warn(`字幕下载失败: ${e.message}`);
          }
        }
      } else {
        log('  该视频没有字幕');
      }
    }

    // 在每个下载目录写一份来源与版权提示。
    // 这不是摆设：它把「本软件用于个人备份」的设计意图落到实际产物上，
    // 也提醒使用者别把文件往外传。出问题时这类痕迹比协议里的字更有说服力。
    try {
      const noticePath = path.join(outDir, '来源与版权提示.txt');
      let notice = '';
      if (fs.existsSync(noticePath)) {
        notice = await fsp.readFile(noticePath, 'utf-8');
      } else {
        notice = [
          '本目录下的文件由「统一下载器」下载，仅供个人学习与合法备份使用。',
          '',
          '· 文件著作权归原作者/原平台所有，下载不等于获得任何授权。',
          '· 请勿将本目录内容二次分发、上传至其他平台、或用于商业用途。',
          '· 请勿移除文件中的水印、权利人标识或版权声明。',
          '· 如需商用或公开传播，请自行联系权利人取得授权。',
          '',
          '本软件不提供、不托管、不分发任何内容，也不具备绕过付费机制或 DRM 的能力。',
          '如你不认同上述限制，请删除本目录全部文件。',
          '',
          '══════════════════════════════════════',
          '',
        ].join('\n');
      }
      notice += `[${new Date().toISOString().slice(0, 19).replace('T', ' ')}] ${title}\n`;
      notice += `  来源: ${url}\n`;
      if (uploader) notice += `  作者: ${uploader}\n`;
      await fsp.writeFile(noticePath, notice, 'utf-8');
    } catch {}

    const thumbInfo = info.thumbnail ? ' (有封面)' : '';
    return {
      url, title, duration: dur, extractor: info.extractor, uploader,
      files, merged: !!aTmp, thumb: thumbInfo,
    };
  } finally {
    try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ───────────────────── CLI ─────────────────────
function parseArgs(argv) {
  const opts = {
    out: DEFAULT_OUT,
    quality: 'best',
    subs: false,
    jsonOnly: false,
    cookiesFrom: null,
    cookiesFile: null,
    ffmpegPath: null,
    ytdlpPath: null,
    extraArgs: [],
    allParts: false,
  };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-o': case '--out': opts.out = argv[++i]; break;
      case '-q': case '--quality': opts.quality = argv[++i]; break;
      case '--subs': case '--subtitle': opts.subs = true; break;
      case '--json': opts.jsonOnly = true; break;
      case '--cookies-from': opts.cookiesFrom = argv[++i]; break;
      case '--cookies': opts.cookiesFile = argv[++i]; break;
      case '--ffmpeg': opts.ffmpegPath = argv[++i]; break;
      case '--ytdlp': opts.ytdlpPath = argv[++i]; break;
      case '--ytdlp-arg': opts.extraArgs.push(argv[++i]); break;
      case '--all-parts': opts.allParts = true; break;
      case '-h': case '--help': opts.help = true; break;
      default:
        if (a.startsWith('-')) warn(`未知参数: ${a}`);
        else positional.push(a);
    }
  }

  // ── 从每个位置参数里再切出所有 URL ──
  //
  // 为什么不能直接 `positional.filter(x => /^https?:\/\//i.test(x))`：
  //   UI 的输入框是**多行**的（txtSiteUrl.Multiline），用户粘两条链接时，
  //   C# 侧 `Quote(raw)` 会把「两行文本」当成**一个**参数传给引擎。
  //   旧逻辑拿整串去匹配 ^https?:// —— 带换行的串整条被丢掉，
  //   表现为"点了开始下载，然后什么都没发生"或整单失败（实测已复现）。
  //
  //   命令行手敲两个参数时是好的，所以这个 bug 只在 UI 里出现，
  //   最容易漏测。现在统一按 URL 正则切分，两种传法都对。
  const urls = [];
  const seen = new Set();
  for (const p of positional) {
    // 先把整段文本里所有 http(s) URL 抠出来（顺序保留）
    const found = String(p).match(/https?:\/\/[^\s"'<>，。、；）)]+/g) || [];
    for (let u of found) {
      u = u.replace(/[.,;)\]]+$/, '');       // 去掉句尾标点
      if (!seen.has(u)) { seen.add(u); urls.push(u); }
    }
  }

  return { opts, urls };
}

function printHelp() {
  console.log(`
站点视频下载（B站 / 优酷 / 腾讯 / 芒果 等）

用法:
  video-dl.mjs <链接> [更多链接...] [选项]

选项:
  -o, --out <dir>          保存目录 (默认: ~/Downloads/Videos)
  -q, --quality <q>        清晰度: best|4k|2160|1440|1080|720|480|360
      --subs               顺带下载字幕 (.srt / .vtt)
      --cookies-from <b>   借用浏览器登录态: chrome|edge|firefox|brave
      --cookies <file>     用 Netscape 格式 cookie 文件
      --ffmpeg <path>      指定 ffmpeg 可执行文件
      --ytdlp <path>       指定 yt-dlp 可执行文件
      --json               只输出元数据（看有哪些清晰度）
  -h, --help               帮助

依赖:
  · yt-dlp  — 解析（必需，缺失会给出安装指引）
  · ffmpeg  — 合并音视频（B站的 1080p+ 都是分离流，必需）

ffmpeg 查找顺序:
  1. --ffmpeg 参数
  2. 环境变量 FFMPEG_PATH
  3. 程序目录: ./ffmpeg.exe  ./ffmpeg/ffmpeg.exe  ./tools/ffmpeg.exe  ./bin/ffmpeg.exe
  4. ~/.dsh-dl-tools/ffmpeg.exe
  5. PATH

示例:
  video-dl.mjs "https://www.bilibili.com/video/BV1xx411c7mD"
  video-dl.mjs "<url>" -q 1080 --subs -o D:\\videos
  video-dl.mjs "<url>" --cookies-from chrome
  video-dl.mjs "<url>" --json
`);
}

function printDependencyHelp(missing) {
  console.error('\n[缺少依赖] ' + missing.join(' 与 '));
  console.error('');
  if (missing.includes('yt-dlp')) {
    console.error('  yt-dlp 是解析引擎，必需。任选一种安装：');
    console.error('    pip install -U yt-dlp');
    console.error('    或下载 yt-dlp.exe 放到程序目录');
    console.error('');
  }
  if (missing.includes('ffmpeg')) {
    console.error('  ffmpeg 用于合并音视频（1080p 以上必需）。任选一种：');
    console.error('    1) 把 ffmpeg.exe 放到本程序同目录');
    console.error('    2) 放到 ~/.dsh-dl-tools/ffmpeg.exe');
    console.error('    3) 装到 PATH');
    console.error('    4) 用 --ffmpeg <路径> 指定');
    console.error('');
  }
  console.error('  当前探测结果：');
  console.error('    ffmpeg: ' + (findFfmpeg() || '未找到'));
  const y = findYtdlp();
  console.error('    yt-dlp: ' + (y ? `${y.cmd} ${y.args.join(' ')} (${y.version})` : '未找到'));
  console.error('');
}

async function main() {
  const { opts, urls } = parseArgs(process.argv.slice(2));
  if (opts.help) { printHelp(); return; }
  if (!urls.length) { printHelp(); process.exitCode = 1; return; }

  // 依赖探测
  const ff = findFfmpeg(opts.ffmpegPath);
  const yt = findYtdlp(opts.ytdlpPath);
  const missing = [];
  if (!yt) missing.push('yt-dlp');
  if (!ff) missing.push('ffmpeg');
  if (missing.length) { printDependencyHelp(missing); process.exitCode = 2; return; }

  const caps = ffmpegCaps(ff);
  log(`输出目录: ${opts.out}`);
  log(`清晰度策略: ${opts.quality}`);
  log(`ffmpeg: ${ff}${caps ? '  (' + caps.version + ')' : ''}`);
  log(`yt-dlp: ${yt.cmd} ${yt.args.join(' ')}  (${yt.version})`);
  if (caps && caps.gpl) log('注意: 该 ffmpeg 是 GPL 构建，对外分发请注意许可证义务');

  const ctx = { ffmpeg: ff, ytdlp: yt };
  const all = [];
  let failed = 0;

  for (const u of urls) {
    try {
      const rs = await handleEntry(u, opts, ctx);
      for (const r of rs) if (r) all.push(r);
    } catch (e) {
      failed++;
      warn(`✗ ${u}\n    ${e.message}`);
    }
  }

  log('\n━━━ 汇总 ━━━');
  for (const r of all) {
    log(`• ${r.title}  →  ${(r.files || []).length} 个文件`);
    for (const f of r.files || []) log(`    ${f}`);
  }
  if (failed) log(`\n失败 ${failed} 个`);

  if (opts.jsonOnly) console.log(JSON.stringify(all, null, 2));
  process.exitCode = failed ? 1 : 0;
}

// ─────────────────────────── 入口 ───────────────────────────
export async function run() {
  // 功能闸门：**每个引擎自己验**，不信任上游 cli 的那一个 if。
  // 改 cli.mjs 里的 if (!activated) 只能骗过 cli，到这里照样被拦。
  assertFeature('sites');
  await main();
}

function isDirectRun() {
  try {
    const entry = process.argv[1] || '';
    return /video-dl(\.mjs)?$/i.test(entry) || entry === '';
  } catch { return false; }
}

if (isDirectRun()) {
  main().catch((e) => {
    console.error('\n[致命]', e.message);
    process.exit(1);
  });
}
