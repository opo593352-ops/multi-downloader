/**
 * wechat-md.mjs — 公众号文章 → Markdown / TXT / Word
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么这个比知乎简单一个量级（实测 2026-10-26，见探测报告）
 * ═══════════════════════════════════════════════════════════════
 *
 *   知乎：403 + `zh-zse-ck` JS 挑战，必须真浏览器跑 JS 生成 cookie。
 *   公众号：**纯 HTTP 直接拿完整 HTML**，而且：
 *     · 图片没有防盗链（连 Referer 都不用带）
 *     · 不需要登录
 *     · 不需要执行 JS
 *
 *   所以这里一行浏览器代码都没有 —— 不用 CDP、不用 Chrome、
 *   启动快、也不吃内存。**别照着知乎的写法抄一遍**，那是白费力气。
 *
 * ═══════════════════════════════════════════════════════════════
 * 两种链接形态都要认
 * ═══════════════════════════════════════════════════════════════
 *
 *   短链  https://mp.weixin.qq.com/s/<id>
 *   长链  https://mp.weixin.qq.com/s?__biz=xx&mid=xx&idx=1&sn=xx
 *   分享  https://mp.weixin.qq.com/s?__biz=...&chksm=...&scene=...#rd
 *
 *   短链会 302 到长链，跟 redirect 就行。
 *
 * ═══════════════════════════════════════════════════════════════
 * 正文提取：靠 #js_content
 * ═══════════════════════════════════════════════════════════════
 *
 *   公众号正文容器固定是 `<div id="js_content">`，比知乎/通用抓取
 *   都稳（那两个要靠打分猜）。所以这里不做启发式，直接取 id。
 *
 *   几个必须处理的公众号特性：
 *     1. **样式全内联** `style="..."` —— 必须丢掉，否则 MD 里全是垃圾
 *     2. `<section>` 嵌套极深（排版用），要递归取文字而不是当块
 *     3. 图片用 `data-src`（懒加载），不是 `src`
 *     4. 代码块用 `<pre><code>`，但要保留换行
 *
 * ═══════════════════════════════════════════════════════════════
 * 用法
 * ═══════════════════════════════════════════════════════════════
 *
 *   node wechat-md.mjs <链接> [更多链接...]
 *   node wechat-md.mjs <链接> -o D:\notes
 *   node wechat-md.mjs <链接> --format md,txt,docx
 *   node wechat-md.mjs <链接> --no-images      不下载图片
 *   node wechat-md.mjs <链接> --json           只输出元数据
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { exportAs } from './doc-export.mjs';
import { downloadFile, extOf } from './web-grab.mjs';
import { assertFeature } from '../dev/gate.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const OUT_DEFAULT = path.join(os.homedir(), 'Downloads', '公众号');

const log = (...a) => console.log(...a);
const warn = (...a) => console.error('[warn]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────── 工具 ─────────────────────

function safeName(s, max = 90) {
  return String(s || 'wechat')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim()
    .slice(0, max) || 'wechat';
}

function fmtSize(b) {
  if (!b) return '-';
  if (b > 1024 ** 2) return (b / 1024 ** 2).toFixed(2) + ' MB';
  return (b / 1024).toFixed(0) + ' KB';
}

function extractUrls(text) {
  const out = [];
  const re = /https?:\/\/[^\s"'<>，。、；）)]+/g;
  for (const m of String(text).matchAll(re)) {
    const u = m[0].replace(/[.,;)\]]+$/, '');
    if (/mp\.weixin\.qq\.com/.test(u)) out.push(u);
  }
  return out;
}

// ───────────────────── 抓取 ─────────────────────

/**
 * 抓文章 HTML。
 *
 * 公众号对"看起来像脚本"的请求会返回一个"环境异常"提示页，
 * 所以 UA 必须是正常浏览器、并且带上 Accept-Language。
 * 实测不加 Accept-Language 有时会拿到英文提示页。
 */
async function fetchArticle(url, timeoutMs = 30000) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Cache-Control': 'no-cache',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const buf = Buffer.from(await res.arrayBuffer());
  // 公众号是 UTF-8；但有的老文章带 gbk 声明，检测一下
  let html = buf.toString('utf-8');
  if (/charset=["']?gb(k|2312|18030)/i.test(html.slice(0, 2000)) &&
      (html.match(/\uFFFD/g) || []).length > 20) {
    try { html = new TextDecoder('gbk').decode(buf); } catch {}
  }

  // 风控/异常页识别 —— 必须区分开，否则用户以为软件坏了
  if (/环境异常|请在微信客户端打开|该内容已被发布者删除|此内容因违规无法查看/.test(html) && html.length < 20000) {
    const m = html.match(/(环境异常|请在微信客户端打开|该内容已被发布者删除|此内容因违规无法查看)[^<]{0,60}/);
    throw new Error(`文章打不开：${m ? m[0] : '需要微信客户端'}`);
  }

  return { html, finalUrl: res.url };
}

// ───────────────────── HTML → Markdown ─────────────────────

/** 去标签取纯文字（保留换行语义） */
function stripTags(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 从 HTML 里抽正文并转 MD */
function htmlToMarkdown(html, opts = {}) {
  // 标题：og:title 最准（<title> 常带「- 微信公众平台」后缀）
  let title = '';
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i);
  if (og) title = og[1];
  if (!title) {
    const t = html.match(/<h1[^>]*class=["'][^"']*rich_media_title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i)
           || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (t) title = stripTags(t[1]).replace(/\s*-\s*微信公众平台\s*$/, '');
  }
  title = (title || '').trim();

  // 作者 / 公众号名
  let author = '';
  const au = html.match(/<meta[^>]+property=["']og:article:author["'][^>]+content=["']([^"']*)["']/i)
          || html.match(/id=["']js_name["'][^>]*>([\s\S]*?)<\//i)
          || html.match(/var\s+nickname\s*=\s*["']([^"']+)["']/i);
  if (au) author = stripTags(au[1]).trim();

  // 发布时间
  let publishAt = '';
  const pt = html.match(/var\s+ct\s*=\s*["']?(\d{10})/i)
          || html.match(/id=["']publish_time["'][^>]*>([^<]*)</i);
  if (pt) {
    const v = pt[1].trim();
    publishAt = /^\d{10}$/.test(v)
      ? new Date(Number(v) * 1000).toISOString().slice(0, 16).replace('T', ' ')
      : v;
  }

  // 正文容器：固定 id，最稳
  let content = '';
  const cm = html.match(/<div[^>]+id=["']js_content["'][^>]*>([\s\S]*?)<\/div>\s*<div[^>]+id=["']js_pc_qr_code["']/i)
          || html.match(/<div[^>]+id=["']js_content["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/i)
          || html.match(/<div[^>]+id=["']js_content["'][^>]*>([\s\S]*)$/i);
  if (cm) content = cm[1];

  if (!content) {
    // 兜底：取 rich_media_content
    const rm = html.match(/<div[^>]+class=["'][^"']*rich_media_content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    if (rm) content = rm[1];
  }

  if (!content) return null;   // 交给上层报错

  // 图片：公众号用 data-src（懒加载），src 常常是占位图
  const images = [];
  content = content.replace(/<img([^>]*)>/gi, (full, attrs) => {
    const ds = attrs.match(/data-src=["']([^"']+)["']/i);
    const s = attrs.match(/\ssrc=["']([^"']+)["']/i);
    let src = (ds && ds[1]) || (s && s[1]) || '';
    if (src.startsWith('//')) src = 'https:' + src;
    if (!src || src.startsWith('data:')) return '';
    const alt = (attrs.match(/alt=["']([^"']*)["']/i) || [])[1] || '';
    if (!images.includes(src)) images.push(src);
    return `\n\n![${alt}](${src})\n\n`;
  });

  // 代码块：先抽出来占位，避免被后面的标签清理破坏
  const codeBlocks = [];
  content = content.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (full, inner) => {
    const code = stripTags(inner);
    const idx = codeBlocks.length;
    codeBlocks.push(code);
    return `\n\n@@CODEBLOCK_${idx}@@\n\n`;
  });

  // 块级结构 → MD
  content = content
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (f, t) => `\n\n# ${stripTags(t)}\n\n`)
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (f, t) => `\n\n## ${stripTags(t)}\n\n`)
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (f, t) => `\n\n### ${stripTags(t)}\n\n`)
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, (f, t) => `\n\n#### ${stripTags(t)}\n\n`)
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (f, t) => {
      const lines = stripTags(t).split('\n').filter(Boolean);
      return '\n\n' + lines.map((l) => `> ${l}`).join('\n') + '\n\n';
    })
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (f, t) => `\n- ${stripTags(t)}`)
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, (f, t) => `**${stripTags(t)}**`)
    .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, (f, t) => `**${stripTags(t)}**`)
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, (f, t) => `*${stripTags(t)}*`)
    .replace(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (f, href, t) => {
      const txt = stripTags(t);
      if (!txt) return '';
      return `[${txt}](${href})`;
    })
    .replace(/<hr\s*\/?>/gi, '\n\n---\n\n');

  // 剩下的标签（section/span/div 等）全部拆掉，只留文字
  content = content.replace(/<\/?(section|div|span|p|article|figure|figcaption|table|thead|tbody|tr|td|th|ul|ol|font)[^>]*>/gi, '\n');
  content = stripTags(content);

  // 还原代码块
  content = content.replace(/@@CODEBLOCK_(\d+)@@/g, (f, i) => {
    const code = codeBlocks[Number(i)] || '';
    return '```\n' + code + '\n```';
  });

  // 清理多余空行
  content = content.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();

  return {
    title,
    author,
    publishAt,
    content,
    images,
    stats: { chars: content.length, images: images.length },
  };
}

// ───────────────────── 图片本地化 ─────────────────────

async function localizeImages(md, outDir, baseName, referer, opts = {}) {
  const urls = [...new Set(
    [...md.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1])
  )];
  if (!urls.length) return { md, ok: 0, fail: 0, bytes: 0 };

  const assetsName = `${baseName}.assets`;
  const assetsDir = path.join(outDir, assetsName);
  await fsp.mkdir(assetsDir, { recursive: true });

  const map = new Map();
  let ok = 0, fail = 0, bytes = 0;

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const guessExt = extOf(url, 'jpg');
    const seq = String(i + 1).padStart(3, '0');
    let name = `img_${seq}.${guessExt}`;
    let dest = path.join(assetsDir, name);

    try {
      // 公众号图床实测不需要 Referer，但带上也无害（有些转载站需要）
      const r = await downloadFile(url, dest, referer);
      if (r.ext && r.ext !== guessExt) {
        const realName = `img_${seq}.${r.ext}`;
        const realDest = path.join(assetsDir, realName);
        try {
          await fsp.rename(dest, realDest);
          name = realName;
          dest = realDest;
        } catch {}
      }
      map.set(url, `./${assetsName}/${name}`);
      ok++; bytes += r.bytes;
      if (!opts.quiet) process.stderr.write(`\r    图片 ${i + 1}/${urls.length}  ✓ ${fmtSize(bytes)}   `);
    } catch (e) {
      fail++;
      if (!opts.quiet) process.stderr.write(`\r    图片 ${i + 1}/${urls.length}  ✗ ${String(e.message).slice(0, 26)}   `);
    }
    await sleep(100);
  }
  if (!opts.quiet && urls.length) process.stderr.write('\n');

  const outMd = md.replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (full, alt, url) => {
    const local = map.get(url);
    return local ? `![${alt}](${local})` : full;
  });

  return { md: outMd, ok, fail, bytes };
}

// ───────────────────── 单篇处理 ─────────────────────

async function handleOne(rawUrl, opts) {
  log(`\n━━━ ${rawUrl}`);

  const { html, finalUrl } = await fetchArticle(rawUrl);
  const data = htmlToMarkdown(html, opts);
  if (!data) {
    throw new Error('没找到正文容器（js_content）—— 可能不是文章页，或需要微信客户端打开');
  }
  if (!data.content || data.content.length < 30) {
    throw new Error('正文太短，可能是图片型文章或被限制');
  }

  const title = data.title || 'wechat_article';
  const baseName = safeName(title, 90);

  // 组装 Markdown
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const header = [
    `# ${title}`,
    '',
    `> 来源: ${finalUrl}`,
    data.author ? `> 公众号: ${data.author}` : null,
    data.publishAt ? `> 发布: ${data.publishAt}` : null,
    `> 抓取: ${now}`,
    `> 字数: ${data.stats.chars}　图片: ${data.stats.images}`,
    '',
    '---',
    '',
  ].filter((x) => x !== null).join('\n');

  let body = header + data.content + '\n';

  // 图片本地化
  let imgStat = { ok: 0, fail: 0, bytes: 0 };
  if (!opts.noImages && data.images.length) {
    log(`  下载图片 ${data.images.length} 张 → ${baseName}.assets/`);
    try {
      const r = await localizeImages(body, opts.out, baseName, finalUrl, opts);
      body = r.md;
      imgStat = r;
      log(`  ✓ 图片 ${r.ok} 张 (${fmtSize(r.bytes)})${r.fail ? `，失败 ${r.fail}` : ''}`);
    } catch (e) {
      warn(`  图片本地化失败（保留远程链接）: ${e.message}`);
    }
  }

  // 导出格式
  const formats = (opts.formats && opts.formats.length) ? opts.formats : ['md'];
  const meta = {
    title,
    author: data.author,
    source: finalUrl,
    publishAt: data.publishAt,
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
    files: written.map((w) => w.dest),
    formats: written.map((w) => w.format),
    chars: data.stats.chars,
    images: data.stats.images,
    imagesLocalized: imgStat.ok,
    author: data.author,
    publishAt: data.publishAt,
  };
}

// ───────────────────── CLI ─────────────────────

function parseArgs(argv) {
  const opts = {
    out: OUT_DEFAULT,
    jsonOnly: false,
    formats: null,
    noImages: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-o': case '--out': opts.out = argv[++i]; break;
      case '--json': opts.jsonOnly = true; break;
      case '--no-images': opts.noImages = true; break;
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

  // 多行输入：UI 会把多条链接当**一个**参数传进来（和站点视频同一个坑）
  const urls = [];
  for (const p of positional) {
    const found = extractUrls(p);
    if (found.length) {
      for (const u of found) if (!urls.includes(u)) urls.push(u);
    } else if (/mp\.weixin\.qq\.com/.test(p)) {
      if (!urls.includes(p)) urls.push(p);
    }
  }
  return { opts, urls };
}

function printHelp() {
  console.log(`
公众号文章 → Markdown / TXT / Word

用法:
  node wechat-md.mjs <公众号链接> [更多链接...] [选项]

选项:
  -o, --out <dir>     输出目录 (默认 ~/Downloads/公众号)
  -f, --format <list> 输出格式: md | txt | docx，可逗号组合 (默认 md)
      --no-images     不下载图片，只保留远程链接
      --json          只输出元数据
  -h, --help          帮助

支持的链接:
  https://mp.weixin.qq.com/s/xxxxxxxx       短链
  https://mp.weixin.qq.com/s?__biz=...      长链
  （分享文案里夹着链接也能识别）

说明:
  公众号是纯 HTTP 抓取，不需要浏览器、不需要登录、图片无防盗链。
  正文取 <div id="js_content">，比通用抓取准得多。

示例:
  node wechat-md.mjs "https://mp.weixin.qq.com/s/xxxxxxxx"
  node wechat-md.mjs "<链接>" -o D:\\notes -f md,docx
`);
}

async function main() {
  const { opts, urls } = parseArgs(process.argv.slice(2));
  if (opts.help || !urls.length) { printHelp(); process.exit(opts.help ? 0 : 1); }

  try {
    await fsp.mkdir(opts.out, { recursive: true });
  } catch (e) {
    throw new Error(`无法创建输出目录：${opts.out}\n     原因：${e.code || e.message}`);
  }
  log(`输出目录: ${opts.out}`);

  const results = [];
  let failed = 0;

  for (const u of urls) {
    try {
      results.push(await handleOne(u, opts));
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
}

// ───────────────────── 入口 ─────────────────────
export async function run() {
  // 功能闸门：每个引擎自己验，不信任上游 cli 的那一个 if。
  assertFeature('wechat');
  await main();
}

function isDirectRun() {
  try {
    const entry = process.argv[1] || '';
    return /wechat-md(\.mjs)?$/i.test(entry) || entry === '';
  } catch { return false; }
}

if (isDirectRun()) {
  main().catch((e) => {
    console.error('\n[致命]', e.message);
    process.exit(1);
  });
}
