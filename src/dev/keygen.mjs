#!/usr/bin/env node
/**
 * keygen.mjs — 卡密生成器（独立 EXE 入口，**不随发布包分发**）
 *
 * 与 gen-license.mjs 的区别：
 *   gen-license.mjs  开发者脚本，跑在 Node 环境，依赖 license.mjs
 *   keygen.mjs       独立入口，自带 SECRET 副本，可打成单个 EXE
 *                    给"你自己"在任意机器上用，不需要装 Node
 *
 * ⚠ 安全边界
 *   这个 EXE 里包含 SECRET（虽然拆段混淆过）。
 *   一旦流出去，别人就能自己造卡密 —— 等于授权系统作废。
 *   所以：
 *     · 绝不能放进发布包
 *     · 绝不能发给客户
 *     · 建议只放在你自己的机器上，或加密 U 盘
 *
 * 用法（双击也可以，会进交互菜单）：
 *   keygen.exe                     交互模式
 *   keygen.exe 25C2B               生成绑定该机器码的激活码
 *   keygen.exe 25C2B -n 5          批量 5 张
 *   keygen.exe --verify <卡密>      校验卡密
 *   keygen.exe --self              显示本机机器码
 *   keygen.exe --help
 */

import crypto from 'node:crypto';
import os from 'node:os';
import readline from 'node:readline';
import { execSync } from 'node:child_process';

// ───────────────────── 与 license.mjs 保持一致的算法 ─────────────────────
// 注意：SECRET 现在只有一个来源（dev/secret.mjs），本文件不再保留副本。
// 以前这里抄了一份 SEGS/XOR 表，两处必须手工同步 —— 那既容易漏改，
// 又让"密钥表"在二进制里多出现一次，等于多给攻击者一个抄的入口。
import { SECRET } from './secret.mjs';

// 裸标识符会被 strings 抓到；数组 join 不会被 minify 折叠
const CE = ['create', 'Cipheriv'].join('');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function normalize(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function hmac4(payload) {
  return crypto.createHmac('sha256', SECRET())
    .update(payload, 'utf-8').digest('hex').toUpperCase().slice(0, 4);
}

// ───────────────────── 机器码（与客户端同算法） ─────────────────────
function cpuModel() {
  try {
    const cpus = os.cpus();
    if (cpus && cpus.length && cpus[0].model) return String(cpus[0].model).trim();
  } catch {}
  if (process.platform === 'win32') {
    try {
      const out = execSync(
        'powershell -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_Processor).Name"',
        { encoding: 'utf-8', windowsHide: true, timeout: 12000 }
      );
      const v = String(out).trim();
      if (v) return v;
    } catch {}
  }
  return 'unknown-cpu';
}

function machineCode() {
  const parts = [
    os.hostname() || 'no-host',
    cpuModel(),
    process.env.PROCESSOR_IDENTIFIER || os.arch(),
  ].join('|');
  const h = crypto.createHash('md5').update(parts, 'utf-8').digest('hex').toUpperCase();
  const cleaned = h.replace(/[01OI]/g, '');
  return (cleaned + h).slice(0, 5);
}

// ───────────────────── 卡密 / 激活码 ─────────────────────
// 天数基准（与 license.mjs 保持一致）
const EPOCH_MS = Date.UTC(2024, 0, 1);

function daysToBase32(days, len = 3) {
  let v = Math.max(0, Math.floor(days));
  let out = '';
  for (let i = 0; i < len; i++) {
    out = ALPHABET[v % 32] + out;
    v = Math.floor(v / 32);
  }
  return out;
}

function base32ToDays(str) {
  let v = 0;
  for (const ch of String(str).toUpperCase()) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) return -1;
    v = v * 32 + idx;
  }
  return v;
}

function expiryToDays(expiry) {
  let ms;
  if (expiry instanceof Date) ms = expiry.getTime();
  else {
    const m = String(expiry).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!m) return -1;
    ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  return Math.floor((ms - EPOCH_MS) / 86400000);
}

function daysToExpiry(days) {
  const d = new Date(EPOCH_MS + days * 86400000);
  return d.toISOString().slice(0, 10);
}

/** 从今天起加 N 个月，返回 YYYY-MM-DD */
function addMonths(n) {
  const d = new Date();
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + n);
  // 处理 31 号 → 下月没有 31 号的情况（自动溢出到下月初，拉回来）
  if (d.getUTCDate() !== day) d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

// ───────────────────── 档位（与 license.mjs 保持一致） ─────────────────────
const TIERS = {
  day:     { label: '日卡',   days: 1 },
  week:    { label: '周卡',   days: 7 },
  month:   { label: '月卡',   days: 30 },
  quarter: { label: '季卡',   days: 90 },
  year:    { label: '年卡',   days: 365 },
  forever: { label: '永久卡', days: 32767, absolute: true },
};
const TIER_ORDER = ['day', 'week', 'month', 'quarter', 'year', 'forever'];

function tierExpiry(tier) {
  const t = TIERS[String(tier || '').toLowerCase()];
  if (!t) throw new Error('未知档位: ' + tier);
  if (t.absolute) return daysToExpiry(t.days);   // 距 EPOCH 的绝对天数
  return new Date(Date.now() + t.days * 86400000).toISOString().slice(0, 10);
}

function tierLabel(tier) {
  return TIERS[String(tier || '').toLowerCase()]?.label || String(tier || '');
}

/** 由剩余天数反推档位（仅用于显示） */
function inferTier(daysLeft) {
  const d = Math.max(0, Number(daysLeft) || 0);
  if (d <= 2) return 'day';
  if (d <= 8) return 'week';
  if (d <= 32) return 'month';
  if (d <= 93) return 'quarter';
  if (d <= 400) return 'year';
  return 'forever';
}

function generateKey(bindTo, expiry) {
  const bind = normalize(String(bindTo || '').padEnd(5, 'X')).slice(0, 5);
  const days = expiryToDays(expiry);
  if (days < 0 || days > 32767) throw new Error('到期日超出范围');

  const datePart = daysToBase32(days, 3);

  // ── 时长字段（必须和 license.mjs 的 generateKey 完全一致）──
  //
  // 布局：到期日(3) + 时长(2) + 哨兵'QZ'(2) + 随机(3) + 机器码(5)
  //
  // ⚠ 这两处 generateKey 是**重复实现**（历史原因，keygen 是独立打包的），
  //   改一处必须改另一处，否则"发出去的卡"和"能累加的卡"格式不一致 ——
  //   表现是：用户续费了但天数没涨，而且不报错。这是最难发现的一类 bug。
  //
  // 时长按「到期日 - 今天」反推（keygen 只有 expiry 没有 tier）。
  const durDays = (() => {
    const n = Math.round((Date.UTC(
      Number(expiry.slice(0, 4)), Number(expiry.slice(5, 7)) - 1, Number(expiry.slice(8, 10))
    ) - Date.now()) / 86400000);
    if (n >= 1023) return 1023;          // 永久卡
    return Math.max(1, Math.min(1023, n));
  })();

  const durPart = daysToBase32(durDays, 2);
  const MARK = 'QZ';
  const randPart = (() => {
    let s = '';
    for (let i = 0; i < 3; i++) s += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
    return s;
  })();

  const payload = datePart + durPart + MARK + randPart + bind;   // 3+2+2+3+5 = 15
  const c = payload + hmac4(payload);
  return `${c.slice(0, 5)}-${c.slice(5, 10)}-${c.slice(10, 15)}-${c.slice(15, 19)}`;
}

function verifyKey(input) {
  const raw = normalize(input);
  if (raw.length !== 19) return { ok: false, reason: 'length' };
  const payload = raw.slice(0, 15);
  const sig = raw.slice(15, 19);
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(hmac4(payload)))) {
    return { ok: false, reason: 'signature' };
  }
  const days = base32ToDays(payload.slice(0, 3));
  if (days < 0) return { ok: false, reason: 'signature' };
  const expiry = daysToExpiry(days);

  // 时长（与 license.mjs 一致：哨兵 'QZ' 在 payload[5..6]）
  let durDays = 0;
  let additive = false;
  if (payload.slice(5, 7) === 'QZ') {
    const d = base32ToDays(payload.slice(3, 5));
    if (d > 0) { durDays = d; additive = true; }
  }
  const bind = payload.slice(10, 15);
  const my = machineCode();
  if (bind !== 'XXXXX' && bind !== my) {
    return { ok: false, reason: 'machine', bind, machine: my, expiry };
  }
  const now = Date.now();
  const expMs = EPOCH_MS + days * 86400000 + 86399999;
  const daysLeft = Math.ceil((expMs - now) / 86400000);
  if (now > expMs) return { ok: false, reason: 'expired', expiry, daysLeft: 0, expired: true };
  return { ok: true, payload, sig4: sig, bind, machine: my, expiry, daysLeft };
}

function deriveResourceKey(code) {
  const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (c.length < 19) throw new Error('bad code');
  return crypto.createHmac('sha256', SECRET()).update('res|v1|' + c, 'utf-8').digest();
}

/**
 * 打包进激活码的「运行必需资源」。
 *
 * 以前这段在两个函数里各抄了一份（issue / issueWithExpiry），
 * 改镜像表时非常容易只改一处 —— 那会造成"按档位签发的卡能用、
 * 自定义到期日的卡下载不了"，而且极难查。
 * 现在只有一个来源。
 *
 * 域名用数组 join 拼：esbuild 的常量折叠会合并 'a'+'b'，
 * 但**不会**折叠数组的 .join('')，所以二进制里查不到完整域名。
 */
function buildResource({ tier, tierLabel, expiry }) {
  const H = ['upos-sz-mirror', 'cos.bili', 'video.com'];
  const H2 = ['upos-sz-mirror', 'ali.bili', 'video.com'];
  const H3 = ['upos-sz-mirror', 'hw.bili', 'video.com'];
  const H4 = ['upos-sz-mirror', '08c.bili', 'video.com'];
  return {
    v: 1,
    tier,
    tierLabel,
    mirrors: { bilibili: [H.join(''), H2.join(''), H3.join(''), H4.join('')] },
    api: { retry: 3, uaProfile: 'chrome131' },
    issuedAt: new Date().toISOString().slice(0, 10),
    expiry,
  };
}

/** 生成激活码
 * @param {string} bindTo 机器码
 * @param {string} tier   档位：day/week/month/quarter/year/forever
 */
function issue(bindTo, tier = 'month') {
  const t = TIERS[String(tier).toLowerCase()] ? String(tier).toLowerCase() : 'month';
  const expiry = tierExpiry(t);
  const code = generateKey(bindTo, expiry);
  const res = buildResource({ tier: t, tierLabel: TIERS[t].label, expiry });
  const key = deriveResourceKey(code);
  const iv = crypto.randomBytes(12);
  const c = crypto[CE]('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(res), 'utf-8'), c.final()]);
  const blob = {
    d: enc.toString('base64'),
    i: iv.toString('base64'),
    t: c.getAuthTag().toString('base64'),
  };
  const activation = Buffer.from(JSON.stringify({ k: code, ...blob }), 'utf-8').toString('base64');
  return { code, activation, bind: normalize(bindTo), expiry, tier: t, tierLabel: TIERS[t].label };
}

/** 自定义到期日签发（不按档位算） */
function issueWithExpiry(bindTo, expiry, code) {
  const res = buildResource({ tier: 'custom', tierLabel: '自定义到期', expiry });
  const key = deriveResourceKey(code);
  const iv = crypto.randomBytes(12);
  const c = crypto[CE]('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(res), 'utf-8'), c.final()]);
  const blob = {
    d: enc.toString('base64'),
    i: iv.toString('base64'),
    t: c.getAuthTag().toString('base64'),
  };
  const activation = Buffer.from(JSON.stringify({ k: code, ...blob }), 'utf-8').toString('base64');
  return { code, activation, bind: normalize(bindTo), expiry, tier: 'custom', tierLabel: '自定义到期' };
}

// ───────────────────── 输出 ─────────────────────
const P = (...a) => console.log(...a);

function banner() {
  P('');
  P('╔═══════════════════════════════════════════════════════╗');
  P('║            统一下载器 · 卡密生成器                    ║');
  P('║            (内部工具，请勿外发)                       ║');
  P('╚═══════════════════════════════════════════════════════╝');
}

function printIssue(list, bindTo) {
  P('');
  P('┌───────────────────────────────────────────────────────┐');
  P('│  激活码（整串发给用户，粘贴一次即可）                  │');
  P('└───────────────────────────────────────────────────────┘');
  P('');
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    P(`  【第 ${i + 1} 张】机器码 ${bindTo}   ${it.tierLabel}`);
    P(`  到期日 : ${it.expiry}`);
    P(`  卡密   : ${it.code}`);
    P(`  激活码 : ${it.activation}`);
    P(`  长度   : ${it.activation.length} 字符`);
    P('');
  }
  P('  提示: 激活码含该机器专属的加密资源，换机器需重新签发。');
  P('');
}

function printTierTable() {
  P('');
  P('  可选档位:');
  for (const k of TIER_ORDER) {
    P(`    ${k.padEnd(8)} ${TIERS[k].label.padEnd(6)} ${TIERS[k].days} 天`);
  }
  P('');
}

function printHelp() {
  P('');
  P('用法:');
  P('  keygen.exe                        交互模式（双击时自动进入）');
  P('  keygen.exe <机器码>                生成月卡');
  P('  keygen.exe <机器码> -t day         日卡');
  P('  keygen.exe <机器码> -t week        周卡');
  P('  keygen.exe <机器码> -t month       月卡（默认）');
  P('  keygen.exe <机器码> -t quarter     季卡');
  P('  keygen.exe <机器码> -t year        年卡');
  P('  keygen.exe <机器码> -t forever     永久卡');
  P('  keygen.exe <机器码> -t year -n 5   年卡 × 5 张');
  P('  keygen.exe <机器码> --expiry 2027-06-01   自定义到期日');
  P('  keygen.exe <机器码> -m 3           兼容旧用法：3 个月');
  P('  keygen.exe --verify <卡密>         校验卡密属于哪台机器');
  P('  keygen.exe --self                 显示本机机器码');
  P('  keygen.exe --tiers                列出全部档位');
  P('  keygen.exe --help                 本帮助');
  P('');
  printTierTable();
  P('说明:');
  P('  机器码由用户在软件「授权 → 查看本机机器码」里看到，5 位大写字母数字。');
  P('  生成的激活码绑定该机器，拷给别人无效。');
  P('  档位只决定签发多少天；卡密结构不变，旧卡密继续有效。');
  P('');
}

// ───────────────────── 交互模式 ─────────────────────
async function interactive() {
  banner();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // 行缓冲：管道输入时 readline 会吞掉未 resolve 的 question，自己管队列
  const q = [];
  const w = [];
  let closed = false;
  rl.on('line', (l) => {
    const f = w.shift();
    if (f) f(l); else q.push(l);
  });
  rl.on('close', () => {
    closed = true;
    while (w.length) w.shift()('');
  });
  const ask = (prompt) => {
    process.stdout.write(prompt);
    if (q.length) { const v = q.shift(); process.stdout.write(v + '\n'); return Promise.resolve(v); }
    if (closed) return Promise.resolve('');
    return new Promise((r) => w.push(r));
  };

  P('');
  P('  本机机器码: ' + machineCode() + '   （仅用于自测，给客户发的码要用客户的机器码）');
  P('');

  while (true) {
    P('  1) 生成激活码（需要客户机器码）');
    P('  2) 批量生成（同一机器码多张）');
    P('  3) 校验一个卡密');
    P('  4) 显示本机机器码');
    P('  5) 查看档位说明');
    P('  6) 退出');
    P('');
    const c = (await ask('  请选择: ')).trim();

    if (c === '1' || c === '2') {
      const bind = (await ask('  输入客户机器码（5 位，如 25C2B）: ')).trim().toUpperCase();
      if (!/^[A-Z0-9]{5}$/.test(bind)) {
        P('  ✗ 机器码格式不对，应为 5 位字母数字');
        P('');
        continue;
      }
      P('');
      printTierTable();
      const ts = (await ask('  选择档位（1=日 2=周 3=月 4=季 5=年 6=永久，回车=月卡）: ')).trim();
      const map = { '1': 'day', '2': 'week', '3': 'month', '4': 'quarter', '5': 'year', '6': 'forever' };
      const tier = map[ts] || 'month';
      let n = 1;
      if (c === '2') {
        const ns = (await ask('  生成几张: ')).trim();
        n = Math.max(1, Math.min(100, parseInt(ns, 10) || 1));
      }
      const list = [];
      for (let i = 0; i < n; i++) list.push(issue(bind, tier));
      printIssue(list, bind);
    } else if (c === '3') {
      const code = (await ask('  粘贴卡密: ')).trim();
      const v = verifyKey(code);
      P('');
      if (v.ok) {
        P('  ✓ 卡密有效');
        P('  绑定机器: ' + (v.bind === 'XXXXX' ? '不绑定' : v.bind));
        P('  档位    : ' + tierLabel(inferTier(v.daysLeft)));
        P('  到期日  : ' + v.expiry + '  （剩 ' + v.daysLeft + ' 天）');
        P('  本机机器码: ' + v.machine);
      } else if (v.reason === 'expired') {
        P('  ⏰ 已过期: ' + v.expiry);
      } else {
        const map = {
          length: '长度不对（应为 XXXXX-XXXXX-XXXXX-XXXX 共 19 位）',
          signature: '签名校验失败（被改动，或不是本工具生成）',
          machine: '机器码不匹配（这是给别的机器生成的）',
        };
        P('  ✗ 无效: ' + (map[v.reason] || v.reason));
        if (v.bind) P('  该码绑定: ' + v.bind);
        if (v.machine) P('  本机机器码: ' + v.machine);
      }
      P('');
    } else if (c === '4') {
      P('');
      P('  本机机器码: ' + machineCode());
      P('');
    } else if (c === '5') {
      P('');
      P('  批量出卡（同一档位 × N 张，机器码各不相同或共用）');
      P('  注意：卡密绑定机器码，批量出卡前请先收集好客户机器码。');
      printTierTable();
      P('');
    } else if (c === '6' || c === '' || c.toLowerCase() === 'q') {
      break;
    } else {
      P('  ? 无效选择');
      P('');
    }
  }

  rl.close();
}

// ───────────────────── 入口 ─────────────────────
async function main() {
  const argv = process.argv.slice(2);

  if (!argv.length) {
    await interactive();
    return;
  }

  const a0 = argv[0];

  if (a0 === '--help' || a0 === '-h' || a0 === '/?') { banner(); printHelp(); return; }
  if (a0 === '--tiers') { banner(); printTierTable(); return; }
  if (a0 === '--self') {
    banner();
    P('');
    P('  本机机器码: ' + machineCode());
    P('');
    return;
  }
  if (a0 === '--verify') {
    banner();
    const code = argv[1] || '';
    const v = verifyKey(code);
    P('');
    if (v.ok) {
      P('  ✓ 有效  绑定: ' + (v.bind === 'XXXXX' ? '不绑定' : v.bind));
      P('  档位: ' + tierLabel(inferTier(v.daysLeft)) + '   到期: ' + v.expiry + '（剩 ' + v.daysLeft + ' 天）');
    } else if (v.reason === 'expired') {
      P('  ⏰ 已过期: ' + v.expiry);
    } else {
      P('  ✗ 无效: ' + v.reason);
      if (v.bind) P('    绑定: ' + v.bind);
      if (v.machine) P('    本机: ' + v.machine);
    }
    P('');
    return;
  }

  // 默认：把第一个参数当机器码
  const bind = normalize(a0).slice(0, 5);
  if (bind.length !== 5) {
    banner();
    P('');
    P('  ✗ 机器码应为 5 位字母数字，收到: ' + a0);
    printHelp();
    process.exitCode = 1;
    return;
  }
  const ni = argv.indexOf('-n');
  const n = ni >= 0 ? Math.max(1, Math.min(100, parseInt(argv[ni + 1], 10) || 1)) : 1;

  // 档位优先级：-t <tier>  >  -m <months>  >  默认 month
  let tier = 'month';
  let customExpiry = null;

  const ti = argv.indexOf('-t');
  if (ti >= 0) {
    const v = String(argv[ti + 1] || '').toLowerCase();
    if (!TIERS[v]) {
      banner();
      P('');
      P('  ✗ 未知档位: ' + argv[ti + 1]);
      printTierTable();
      process.exitCode = 1;
      return;
    }
    tier = v;
  } else {
    const mi = argv.indexOf('-m');
    if (mi >= 0) {
      // 兼容旧用法：-m 3 表示 3 个月
      const m = Math.max(1, Math.min(120, parseInt(argv[mi + 1], 10) || 1));
      customExpiry = addMonths(m);
    }
  }

  const ei = argv.indexOf('--expiry');
  if (ei >= 0) {
    const v = String(argv[ei + 1] || '');
    if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(v)) {
      banner();
      P('');
      P('  ✗ 到期日格式应为 YYYY-MM-DD，收到: ' + v);
      process.exitCode = 1;
      return;
    }
    customExpiry = v;
  }

  banner();
  const list = [];
  for (let i = 0; i < n; i++) {
    if (customExpiry) {
      // 自定义到期日：绕过档位，直接用日期
      const code = generateKey(bind, customExpiry);
      const res = issueWithExpiry(bind, customExpiry, code);
      list.push(res);
    } else {
      list.push(issue(bind, tier));
    }
  }
  printIssue(list, bind);
}

main().catch((e) => {
  console.error('[致命]', e.message);
  process.exit(1);
});
