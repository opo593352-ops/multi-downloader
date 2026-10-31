/**
 * probe-bq.mjs — 笔趣阁目录页探测
 *
 * 目标：搞清书籍页为什么只有 21 条章节链接
 *   - 是懒加载？（滚动后加载更多）
 *   - 是分页？（有 page 参数）
 *   - 还是页面里藏着 JSON？
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findBrowser } from './browser.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9788;
const BOOK_URL = process.argv[2] || 'https://www.biquge365.net/book/004552/';

function launch() {
  const b = findBrowser();
  const profile = path.join(os.tmpdir(), 'bq-probe-' + Date.now());
  const args = [
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'about:blank',
  ];
  return { proc: spawn(b.path, args, { stdio: 'ignore', windowsHide: true }), profile };
}

async function waitWs(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) {
        const j = await r.json();
        if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
      }
    } catch {}
    await sleep(250);
  }
  throw new Error('CDP 未就绪');
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      }
    });
  }
  send(method, params = {}, sid) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error('timeout ' + method)); }, 45000);
      t.unref?.();
      this.pending.set(id, {
        resolve: v => { clearTimeout(t); res(v); },
        reject: e => { clearTimeout(t); rej(e); },
      });
      const msg = { id, method, params };
      if (sid) msg.sessionId = sid;
      this.ws.send(JSON.stringify(msg));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

const evalJs = async (cdp, sid, expr) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};

async function main() {
  console.log('探测目标:', BOOK_URL);
  const { proc } = launch();
  let cdp = null;
  try {
    const ws = new WebSocket(await waitWs());
    await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
    cdp = new CDP(ws);

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sid);
    await cdp.send('Runtime.enable', {}, sid);

    // 记录网络请求
    const reqs = [];
    cdp.ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.method === 'Network.requestWillBeSent' && m.params?.request?.url) {
        const u = m.params.request.url;
        if (!/\.(css|png|jpg|jpeg|gif|svg|woff2?|ico)(\?|$)/i.test(u)) reqs.push(u);
      }
    });
    await cdp.send('Network.enable', {}, sid);

    await cdp.send('Page.navigate', { url: BOOK_URL }, sid);
    await sleep(10000);

    const diag = await evalJs(cdp, sid, `
      ({
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        htmlLen: (document.documentElement?.outerHTML||'').length,
        bodyNull: document.body === null,
        linkCount: document.querySelectorAll('a').length,
      })
    `);
    console.log('\n=== 0. 诊断 ===');
    console.log(JSON.stringify(diag, null, 2));

    console.log('\n=== 1. 初始状态 ===');
    const before = await evalJs(cdp, sid, `
      (() => {
        const links = [...document.querySelectorAll('a[href*="/chapter/"]')];
        return {
          chapterLinks: links.length,
          unique: new Set(links.map(a => a.getAttribute('href'))).size,
          bodyLen: (document.body?.innerText||'').length,
        };
      })()
    `);
    console.log(JSON.stringify(before));

    // 滚到底
    console.log('\n=== 2. 滚到底部 ===');
    for (let i = 0; i < 6; i++) {
      await evalJs(cdp, sid, 'window.scrollTo(0, (document.body||document.documentElement).scrollHeight||0)');
      await sleep(700);
    }
    const after = await evalJs(cdp, sid, `
      (() => {
        const links = [...document.querySelectorAll('a[href*="/chapter/"]')];
        return {
          chapterLinks: links.length,
          unique: new Set(links.map(a => a.getAttribute('href'))).size,
          bodyLen: (document.body?.innerText||'').length,
        };
      })()
    `);
    console.log(JSON.stringify(after));

    console.log('\n=== 3. 页面里是否有 JSON 数据 ===');
    const jsonProbe = await evalJs(cdp, sid, `
      (() => {
        const out = { scripts: [], inlineJson: null };
        // 内联 script 里找章节数组
        for (const s of document.querySelectorAll('script:not([src])')) {
          const t = s.textContent || '';
          if (t.includes('/chapter/') || t.includes('chapterList') || t.includes('catalog')) {
            out.scripts.push(t.slice(0, 300));
          }
        }
        // 查找全局变量
        for (const k of Object.keys(window)) {
          try {
            const v = window[k];
            if (v && typeof v === 'object' && Array.isArray(v) && v.length > 50) {
              out.inlineJson = out.inlineJson || [];
              out.inlineJson.push({ key: k, len: v.length });
            }
          } catch {}
        }
        return out;
      })()
    `);
    console.log('内联脚本:', JSON.stringify(jsonProbe.scripts).slice(0, 400));
    console.log('全局数组:', JSON.stringify(jsonProbe.inlineJson));

    console.log('\n=== 4. 网络请求（非静态资源）===');
    reqs.forEach(u => console.log('  ' + u.slice(0, 120)));

  } finally {
    if (cdp) cdp.close();
    try { proc.kill(); } catch {}
  }
}

main().catch(e => { console.error('[失败]', e.message); process.exit(1); });
