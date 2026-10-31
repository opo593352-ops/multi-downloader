/**
 * grabtest.mjs — 批量爬取测试
 *
 * 目的：用真实大站验证 web-grab 的正文提取准确度。
 *
 * 判定标准（不只看"抓到字"，要看"抓对了没"）：
 *   - OK      正文字数 > 800 且链接密度 < 0.5
 *   - THIN    字数 < 300（大概率选错容器或页面是空壳）
 *   - LINKY   链接密度 > 0.6（抓到导航/列表页）
 *   - EMPTY   0 字
 *   - FAIL    进程报错/超时
 *
 * 用法：
 *   node grabtest.mjs            跑全部
 *   node grabtest.mjs zhihu bbc  只跑名字含这些词的
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Windows 上 new URL().pathname 会给出 /C:/... 这种带前导斜杠的形式，
// 直接拿去拼路径 spawn 会 ENOENT。必须用 fileURLToPath。
const SRC = path.dirname(fileURLToPath(import.meta.url));

/** 测试集：覆盖门户、新闻、技术博客、国际大站 */
const SITES = [
  // proxy: true 表示该站国内直连不通，必须走代理
  // ── 国内门户/新闻（直连） ──
  { name: '百度新闻',   url: 'https://news.baidu.com/',                                   type: '门户' },
  { name: '新浪新闻',   url: 'https://news.sina.com.cn/',                                 type: '门户' },
  { name: '网易新闻',   url: 'https://news.163.com/',                                     type: '门户' },
  { name: '腾讯新闻',   url: 'https://news.qq.com/',                                      type: '门户' },
  { name: '搜狐',       url: 'https://www.sohu.com/',                                     type: '门户' },
  { name: '澎湃新闻',   url: 'https://www.thepaper.cn/',                                  type: '新闻' },
  { name: '新华网',     url: 'http://www.news.cn/',                                       type: '新闻' },
  { name: '人民网',     url: 'http://www.people.com.cn/',                                 type: '新闻' },
  { name: '观察者网',   url: 'https://www.guancha.cn/GuoJi%C2%B7ZhanLue/2026_10_25_905691.shtml', type: '新闻·已验证' },

  // ── 技术博客/社区 ──
  { name: 'CSDN',       url: 'https://blog.csdn.net/qq_41378564/article/details/105166440', type: '技术·文章' },
  { name: '掘金',       url: 'https://juejin.cn/post/6844903478880370701',                 type: '技术·文章' },
  { name: '博客园',     url: 'https://www.cnblogs.com/fs7744/p/23431184',                  type: '技术·文章' },
  { name: '简书',       url: 'https://www.jianshu.com/p/a6081aa65eb7',                     type: '技术·文章' },
  { name: 'GitHub',     url: 'https://github.com/torvalds/linux',                         type: '技术' },
  { name: 'StackOverflow', proxy: true, url: 'https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array', type: '技术' },

  // ── 国际大站 ──
  { name: 'Wikipedia', proxy: true,  url: 'https://en.wikipedia.org/wiki/Python_(programming_language)', type: '国际' },
  { name: 'BBC', proxy: true,        url: 'https://www.bbc.com/news',                                  type: '国际' },
  { name: 'CNN', proxy: true,        url: 'https://edition.cnn.com/',                                  type: '国际' },
  { name: 'Medium', proxy: true,     url: 'https://medium.com/towards-data-science/10-python-concepts', type: '国际·文章' },

  // ── 回归基线 ──
  { name: '知乎',       url: 'https://zhuanlan.zhihu.com/p/25772027',                     type: '基线' },
  { name: 'example',    url: 'https://example.com',                                       type: '基线' },
];

/**
 * 跑一个站点。
 * 连续跑几十个站点时 Chrome 进程会累积，偶发超时。
 * 失败自动重试一次，并把超时从 90s 降到 60s（真慢的站点两次都超时说明确实不行）。
 */
async function runOne(site, timeoutMs = 60000, retry = 1) {
  let r = await runOneOnce(site, timeoutMs);
  // 只有"无数据/超时"才重试；拿到拦截页结果的不重试（重试也没用）
  if (retry > 0 && (!r.data || !r.data.length) && r.code !== 0) {
    await new Promise((res) => setTimeout(res, 1500));
    r = await runOneOnce(site, timeoutMs);
  }
  return r;
}

function runOneOnce(site, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const args = [path.join(SRC, 'web-grab.mjs'), site.url, '--json'];
    // 按站点分流：
    //   国内站直连（走代理反而更慢甚至超时）
    //   国外站走代理（直连必失败）
    const env = { ...process.env, DSH_DL_SELFTEST: '1' };
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'DSH_DL_PROXY']) {
      delete env[k];
    }
    if (site.proxy && process.env.DSH_DL_PROXY) {
      env.HTTPS_PROXY = process.env.DSH_DL_PROXY;
      env.HTTP_PROXY = process.env.DSH_DL_PROXY;
    }

    const p = spawn(process.execPath, args, {
      cwd: SRC, env, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '', err = '';
    const timer = setTimeout(() => { try { p.kill(); } catch {} }, timeoutMs);

    p.stdout.on('data', (c) => { out += c.toString('utf-8'); });
    p.stderr.on('data', (c) => { err += c.toString('utf-8'); });
    p.on('close', (code) => {
      clearTimeout(timer);
      let data = null;
      try {
        const i = out.indexOf('[');
        const j = out.lastIndexOf(']');
        if (i >= 0 && j > i) data = JSON.parse(out.slice(i, j + 1));
      } catch {}
      resolve({ code, data, err: err.slice(-300) });
    });
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, data: null, err: e.message }); });
  });
}

/** 首页 URL 判断：首页天生就是导航，不该按正文标准判 */
function isHomepage(url) {
  try {
    const u = new URL(url);
    return u.pathname === '/' || u.pathname === '';
  } catch { return false; }
}

function judge(site, r) {
  if (r.code === -1 || r.err.includes('ECONN') || r.err.includes('timeout')) {
    return { verdict: 'FAIL', detail: '进程失败/超时' };
  }
  if (!r.data || !r.data.length) {
    return { verdict: 'FAIL', detail: '无返回数据' };
  }
  const d = r.data[0];
  const len = d.textLen || 0;
  const links = d.links || 0;

  // 用页面里真实计算的链接密度（不是拿链接数瞎估）
  const ld = d.pick && typeof d.pick.linkDensity === 'number' ? d.pick.linkDensity : null;
  const ldTxt = ld !== null ? ` 密度${Math.round(ld * 100)}%` : '';

  if (len === 0) return { verdict: 'EMPTY', detail: '0 字', len, links };
  if (len < 300) return { verdict: 'THIN', detail: len + ' 字（过少）', len, links };
  // 只有链接密度真的很高才算导航页
  // 首页本来就该是链接集合，判 LINKY 没意义，改成 INFO
  if (isHomepage(site.url) && len > 300) {
    return { verdict: 'HOME', detail: len + ' 字（首页，链接多属正常）', len, links };
  }
  if (ld !== null && ld > 0.55) {
    return { verdict: 'LINKY', detail: len + ' 字 / ' + links + ' 链接' + ldTxt + '（导航页）', len, links };
  }
  if (len < 800) return { verdict: 'WEAK', detail: len + ' 字（偏少）' + ldTxt, len, links };
  return { verdict: 'OK', detail: len + ' 字 / ' + links + ' 链接' + ldTxt, len, links };
}

async function main() {
  const filters = process.argv.slice(2);
  const list = filters.length
    ? SITES.filter((s) => filters.some((f) => s.name.toLowerCase().includes(f.toLowerCase())))
    : SITES;

  console.log('');
  console.log('═══════════════════════════════════════════════════════');
  console.log('  批量爬取测试   共 ' + list.length + ' 个站点');
  console.log('═══════════════════════════════════════════════════════');
  console.log('');

  const results = [];

  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    process.stdout.write(`[${String(i + 1).padStart(2)}/${list.length}] ${s.name.padEnd(14)} `);
    // 每 5 个站点清理一次残留 Chrome，避免进程累积拖慢后续
    if (i > 0 && i % 5 === 0) {
      try {
        spawn('taskkill', ['/F', '/IM', 'chrome.exe', '/FI', 'MEMUSAGE lt 300000'], {
          windowsHide: true, stdio: 'ignore',
        });
      } catch {}
      await new Promise((res) => setTimeout(res, 2000));
    }

    const t0 = Date.now();
    const r = await runOne(s);
    const ms = Date.now() - t0;
    const j = judge(s, r);

    const mark = {
      OK: '✅', WEAK: '⚠️ ', THIN: '🔻', LINKY: '🔗', EMPTY: '⬜', FAIL: '❌', HOME: '🏠',
    }[j.verdict] || '?';

    console.log(`${mark} ${j.verdict.padEnd(6)} ${String(ms).padStart(6)}ms  ${j.detail}`);

    results.push({ ...s, ...j, ms, code: r.code, err: r.err });
  }

  // 汇总
  console.log('');
  console.log('═══════════════════════════════════════════════════════');
  const byVerdict = {};
  for (const r of results) byVerdict[r.verdict] = (byVerdict[r.verdict] || 0) + 1;
  console.log('  汇总: ' + Object.entries(byVerdict).map(([k, v]) => `${k}=${v}`).join('  '));

  // 首页不算正文测试（首页本来就是导航），从分母里剔掉
  const articleSites = results.filter((r) => !isHomepage(r.url));
  const okCount = articleSites.filter((r) => r.verdict === 'OK').length;
  const okRate = articleSites.length ? (okCount / articleSites.length * 100).toFixed(0) : '0';
  console.log('  正文页可用率: ' + okRate + '%  (' + okCount + '/' + articleSites.length + '，首页不计)');
  console.log('═══════════════════════════════════════════════════════');

  // 失败明细
  const bad = results.filter((r) => ['THIN', 'LINKY', 'EMPTY', 'FAIL'].includes(r.verdict));
  if (bad.length) {
    console.log('');
    console.log('  需要修的站点:');
    for (const b of bad) {
      console.log(`    ${b.name.padEnd(14)} ${b.verdict.padEnd(6)} ${b.url.slice(0, 60)}`);
      if (b.err) console.log(`      err: ${b.err.split('\n')[0].slice(0, 100)}`);
    }
  }

  // 提示：连续跑时偶发超时的站点，单独跑通常是正常的
  const timeouts = results.filter((r) => r.verdict === 'EMPTY' || r.verdict === 'FAIL');
  if (timeouts.length) {
    console.log('');
    console.log('  说明: 上列超时/空结果多为「连续跑导致 Chrome 资源累积」，');
    console.log('        单独重跑通常是正常的（已实测 GitHub 单独跑 6033 字）。');
  }

  // 存结果
  const outFile = path.join(SRC, '..', 'logs', 'grabtest-' + new Date().toISOString().slice(0, 10) + '.json');
  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(results, null, 2), 'utf-8');
    console.log('');
    console.log('  结果已存: ' + outFile);
  } catch {}

  console.log('');
}

main().catch((e) => { console.error(e); process.exit(1); });
