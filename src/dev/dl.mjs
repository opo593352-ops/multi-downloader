/**
 * dl.mjs — 带空闲检测的文件下载（全项目共用）
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么需要这个文件
 * ═══════════════════════════════════════════════════════════════
 *
 * 测试者反馈：「等了 210 秒左右就卡在最后一点完全下载不了」
 *
 * 原因是所有引擎的下载循环都长这样：
 *
 *     const res = await fetch(url);              // ← 没有超时
 *     for await (const chunk of res.body) { ... } // ← 没有空闲检测
 *
 * `AbortSignal.timeout(N)` 只限制**总时长**，解决不了「卡在 99%」：
 * 卡住之前都是正常速度，时间预算还够，所以总时长限制根本不会触发。
 * 而 fetch 自己的 TCP 超时要等好几分钟。
 *
 * 唯一有效的判据是「**多久没收到新数据**」。
 *
 * ═══════════════════════════════════════════════════════════════
 * 三层保护
 * ═══════════════════════════════════════════════════════════════
 *
 *   1. 连接超时   建连阶段最多等 CONNECT_MS（默认 20 秒）
 *   2. 空闲超时   连续 STALL_MS（默认 30 秒）没新字节 → 中断
 *   3. 总时长上限 单文件最多 TOTAL_MS（默认 30 分钟）
 *
 * 中断时**保留已下载部分**（.part 文件），下次调用自动续传。
 *
 * ═══════════════════════════════════════════════════════════════
 * 用法
 * ═══════════════════════════════════════════════════════════════
 *
 *   import { downloadFile } from '../dev/dl.mjs';
 *
 *   const r = await downloadFile(url, dest, {
 *     referer: 'https://www.bilibili.com/',
 *     onProgress: (got, total) => { ... },
 *   });
 *   // r = { bytes, resumed, stalled? }
 *
 * 失败抛出的错误带 `.code`：
 *   ESTALL    卡住（可续传）
 *   ETIMEOUT  总时长超限
 *   EHTTP     HTTP 状态码不对
 *   ESHORT    下载不完整
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export function fmtSize(b) {
  const n = Number(b) || 0;
  if (n > 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + ' GB';
  if (n > 1024 ** 2) return (n / 1024 ** 2).toFixed(2) + ' MB';
  if (n > 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
}

function mkErr(msg, code) {
  const e = new Error(msg);
  e.code = code;
  return e;
}

/**
 * 下载一个 URL 到本地文件，带空闲检测与断点续传。
 *
 * @param {string} url
 * @param {string} dest            目标路径（中断时留下 dest + '.part'）
 * @param {object} [opts]
 * @param {string} [opts.referer]  Referer 头
 * @param {object} [opts.headers]  额外请求头
 * @param {number} [opts.stallMs]  空闲超时（默认 30000）
 * @param {number} [opts.connectMs] 建连超时（默认 20000）
 * @param {number} [opts.totalMs]  总时长上限（默认 30 分钟）
 * @param {boolean} [opts.force]   忽略已存在的 dest，重下
 * @param {boolean} [opts.quiet]   不打印进度
 * @param {(got:number,total:number)=>void} [opts.onProgress]
 * @param {(msg:string)=>void} [opts.log]
 * @returns {Promise<{bytes:number,resumed:boolean}>}
 */
export async function downloadFile(url, dest, opts = {}) {
  const STALL_MS = opts.stallMs ?? 30_000;
  const CONNECT_MS = opts.connectMs ?? 20_000;
  const TOTAL_MS = opts.totalMs ?? 30 * 60_000;
  const log = opts.log || (() => {});
  const part = dest + '.part';

  await fsp.mkdir(path.dirname(dest), { recursive: true });

  // 已完整下载过就跳过
  if (!opts.force && fs.existsSync(dest)) {
    const st = fs.statSync(dest);
    if (st.size > 0) return { bytes: st.size, resumed: true, skipped: true };
  }

  // 续传起点
  let startAt = 0;
  try {
    const st = fs.statSync(part);
    if (st.size > 0) startAt = st.size;
  } catch {}

  const headers = { 'User-Agent': UA, Accept: '*/*', ...(opts.headers || {}) };
  if (opts.referer) headers.Referer = opts.referer;
  if (startAt > 0) headers.Range = `bytes=${startAt}-`;

  // ── 三层超时 ──
  const ctrl = new AbortController();
  let stalled = false;
  let timedOut = false;
  let lastByteAt = Date.now();

  const connectTimer = setTimeout(() => {
    timedOut = true;
    try { ctrl.abort(); } catch {}
  }, CONNECT_MS);
  connectTimer.unref?.();

  let res;
  try {
    res = await fetch(url, { headers, redirect: 'follow', signal: ctrl.signal });
  } catch (e) {
    clearTimeout(connectTimer);
    if (timedOut) throw mkErr(`建连超时（${CONNECT_MS / 1000} 秒）`, 'ETIMEOUT');
    throw mkErr(`连接失败: ${e.message}`, 'ENET');
  }
  clearTimeout(connectTimer);

  if (!res.ok && res.status !== 206) {
    throw mkErr(`HTTP ${res.status}`, 'EHTTP');
  }

  // 服务器不认 Range（返回 200）→ 必须从头写
  const resuming = res.status === 206 && startAt > 0;
  if (!resuming && startAt > 0) {
    startAt = 0;
    try { await fsp.rm(part, { force: true }); } catch {}
  }

  let total = Number(res.headers.get('content-length') || 0);
  if (total) total += startAt;

  // 总时长看门狗
  const totalTimer = setTimeout(() => {
    timedOut = true;
    try { ctrl.abort(); } catch {}
  }, TOTAL_MS);
  totalTimer.unref?.();

  // 空闲看门狗：这才是解决"卡在最后一点"的关键
  const watchdog = setInterval(() => {
    if (Date.now() - lastByteAt > STALL_MS) {
      stalled = true;
      try { ctrl.abort(); } catch {}
    }
  }, Math.min(5_000, Math.max(1_000, Math.floor(STALL_MS / 4))));
  watchdog.unref?.();

  const file = fs.createWriteStream(part, { flags: resuming ? 'a' : 'w' });
  let got = startAt;
  let lastTick = 0;
  if (startAt > 0) {
    log(`续传，从 ${fmtSize(startAt)} 继续`);
    opts.onProgress?.(startAt, total);
  }

  try {
    for await (const chunk of res.body) {
      got += chunk.length;
      lastByteAt = Date.now();          // ← 看门狗靠它判断"还在动"
      if (!file.write(chunk)) await new Promise((r) => file.once('drain', r));
      const now = Date.now();
      if (opts.onProgress && now - lastTick > 300) {
        lastTick = now;
        opts.onProgress(got, total);
      }
    }
  } catch (e) {
    if (stalled) {
      throw mkErr(
        `下载卡住（${STALL_MS / 1000} 秒没有新数据）\n` +
        `     已下载 ${fmtSize(got)}${total ? '/' + fmtSize(total) : ''}，重新运行会续传`,
        'ESTALL'
      );
    }
    if (timedOut) {
      throw mkErr(
        `下载超时（超过 ${Math.round(TOTAL_MS / 60000)} 分钟）\n` +
        `     已下载 ${fmtSize(got)}，重新运行会续传`,
        'ETIMEOUT'
      );
    }
    throw e;
  } finally {
    clearInterval(watchdog);
    clearTimeout(totalTimer);
    await new Promise((r) => file.end(r));
  }

  opts.onProgress?.(got, total);

  if (total && got !== total) {
    throw mkErr(
      `下载不完整 ${fmtSize(got)}/${fmtSize(total)}（重新运行会续传）`,
      'ESHORT'
    );
  }

  // 完整了才改名，避免残片被当成"已下载"
  await fsp.rename(part, dest);
  return { bytes: got, resumed: startAt > 0 };
}

/**
 * 探测远程文件大小（HEAD，失败回退 Range GET）。
 * 用于下载前显示大小，拿不到返回 0（不阻断）。
 */
export async function probeSize(url, referer) {
  const h = { 'User-Agent': UA, Accept: '*/*' };
  if (referer) h.Referer = referer;
  try {
    const r = await fetch(url, {
      method: 'HEAD', headers: h, redirect: 'follow',
      signal: AbortSignal.timeout(12_000),
    });
    const n = Number(r.headers.get('content-length') || 0);
    if (n) return { size: n, type: r.headers.get('content-type') || '' };
  } catch {}
  try {
    const r = await fetch(url, {
      headers: { ...h, Range: 'bytes=0-0' }, redirect: 'follow',
      signal: AbortSignal.timeout(12_000),
    });
    const cr = r.headers.get('content-range');
    if (cr) {
      const m = cr.match(/\/(\d+)/);
      if (m) return { size: Number(m[1]), type: r.headers.get('content-type') || '' };
    }
  } catch {}
  return { size: 0, type: '' };
}
