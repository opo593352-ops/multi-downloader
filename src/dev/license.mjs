/**
 * license.mjs — 本地离线卡密校验（零服务器）
 *
 * 设计目标：
 *   1. 纯本地校验，不联网，用户无感
 *   2. 卡密与机器绑定，转发给别人不能用
 *   3. 校验通过后**派生出一个 crypto key**，参与真正的解密运算
 *      —— 只把 check() 改成 return true 是跑不起来的
 *
 * 卡密格式：
 *   XXXXX-XXXXX-XXXXX-YYYY
 *   └─随机─┘└─随机─┘└绑定位┘└签名┘
 *
 *   前 15 位（去掉分隔符）是 payload，后 4 位是 HMAC-SHA256 校验码。
 *   绑定位是机器码的 MD5 前 5 位（大写 Base32 风格）。
 *
 * 已知缺陷（必须承认）：
 *   SECRET 最终要参与运算，所以一定存在于内存里。有足够耐心的逆向
 *   一定能提取出来。这套机制抬高了门槛，但不等于不可破。
 *   缓解手段：SECRET 拆成多段、运行时拼接、XOR 混淆、
 *   校验逻辑与业务代码耦合（见 deriveResourceKey）。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';

// ───────────────────── 授权主密钥（对抗 strings / 直接抄表） ─────────────────────
//
// 旧实现是一组字节 + 一个 XOR 常量（SEG_MASK = 0x5a）：
//
//   SEGS.flat().map(b => String.fromCharCode(b ^ 0x5a)).join('')
//
// 任何看到这段代码的人 10 秒内就能把 SECRET 完整打印出来，拿到 SECRET
// 就能自造卡密、自派生资源 key —— 比"改 return true"严重一个量级，
// 而且是不可挽回的（已发出的卡密无法统一作废）。
//
// 现在统一走 dev/secret.mjs：材料被打散 + AES-256-GCM 封装 + scrypt 派生，
// 解开后还要过摘要自检。算法细节见那个文件的头部注释。
//
// 注意：**只换存取方式，不换密钥值**。已售出的卡密与激活码继续有效。
import { SECRET, hmac as secretHmac } from './secret.mjs';

// ───────────────────── 机器码 ─────────────────────
/**
 * 机器码 = MD5(hostname + CPU型号 + PROCESSOR_IDENTIFIER) 前 5 位大写。
 *
 * 刻意**不**包含内存总量、磁盘序列号这些易变项：
 * 用户加内存、换硬盘不该导致卡密失效。
 */
let _machineCache = null;

/**
 * 拿 CPU 型号。
 *
 * 优先用 os.cpus()[0].model —— Node 在 Windows 上直接读注册表，
 * 结果稳定、无需外部命令、也不受 PATH 影响。
 * wmic 在 Win11 24H2+ 已被移除，PowerShell 启动要几百毫秒，都不划算。
 *
 * 注意：本函数**不参与机器码**（见 computeMachineCode 的说明）。
 * 只给「显示给用户看」的场景用，所以回退分支不影响授权。
 */
function cpuModel() {
  try {
    const cpus = os.cpus();
    if (cpus && cpus.length && cpus[0].model) return String(cpus[0].model).trim();
  } catch {}
  return 'unknown-cpu';
}

/**
 * 读 CPU 标识（机器码用）。
 *
 * ── 为什么不能直接用 process.env.PROCESSOR_IDENTIFIER ──
 *
 * 这个变量是**由父进程环境块继承**的，不是 Windows 内核随时可查的。
 * 实测（本机 AMD Ryzen 7 7435H）：
 *
 *   PROCESSOR_IDENTIFIER 存在  → 机器码 25C2B   ✅
 *   PROCESSOR_IDENTIFIER 缺失  → 机器码 6F6B4   ❌ 同一个 EXE、同一台机器
 *
 * 什么时候会缺：
 *   · 用户从「任务计划程序」「服务」「精简过的启动器」拉起本程序
 *   · 某些杀软/沙箱用空环境块 CreateProcess
 *   · 第三方壳或安装器把环境变量裁掉
 *   · CI/自动化里用 env={} 起进程
 *
 * 后果和交接文档 11.5.5 描述的灾难一模一样：客户激活后换个启动方式就
 * 「机器码不匹配」，软件直接不可用。落盘缓存只能挡住"同一台机器跑多次"，
 * 挡不住"第一次运行就缺变量"——那会**永久**写下一个错的码。
 *
 * 所以改成三级取值，**优先读注册表**（内核维护，与父进程无关）：
 *   1. HKLM\HARDWARE\DESCRIPTION\System\CentralProcessor\0
 *        Identifier + ', ' + VendorIdentifier   ← 与系统环境变量同源同值
 *   2. process.env.PROCESSOR_IDENTIFIER          ← 注册表读不到时
 *   3. 'arch:' + os.arch()                       ← 最后的确定性兜底
 *
 * ── 为什么必须用 reg.exe 的绝对路径 ──
 * 空环境块起进程时 PATH 也是空的，`reg` 会变成 ENOENT（实测：
 * 空环境下机器码仍是 6F6B4，因为 execSync('reg ...') 找不到命令）。
 * 所以先按 %SystemRoot% 拼绝对路径，再退到写死的 C:\Windows\System32，
 * 最后才试裸 `reg`（PATH 正常时）。
 */
function regExeCandidates() {
  const list = [];
  const root = process.env.SystemRoot || process.env.windir || '';
  if (root) list.push(path.join(root, 'System32', 'reg.exe'));
  list.push('C:\\Windows\\System32\\reg.exe');
  list.push('reg');
  return list;
}

function regQueryValue(key, name) {
  for (const exe of regExeCandidates()) {
    try {
      // execFileSync + 参数数组：路径里有空格也不会被拆开，
      // 也不需要担心 shell 引号在不同 cmd/pwsh 下解析不一致。
      const out = execFileSync(exe, ['query', key, '/v', name], {
        encoding: 'utf-8', windowsHide: true, timeout: 8000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const m = String(out).match(/REG_SZ\s+(.+)/);
      if (m) return m[1].trim();
    } catch { /* 换下一个候选 */ }
  }
  return '';
}

function stableProcessorId() {
  if (process.platform === 'win32') {
    const key = 'HKLM\\HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0';
    const id = regQueryValue(key, 'Identifier');
    if (id) {
      const vendor = regQueryValue(key, 'VendorIdentifier');
      // 与 PROCESSOR_IDENTIFIER 的拼接格式保持一致，避免老用户机器码漂移
      return vendor ? id + ', ' + vendor : id;
    }
  }
  if (process.env.PROCESSOR_IDENTIFIER) return String(process.env.PROCESSOR_IDENTIFIER);
  return 'arch:' + os.arch();
}

/**
 * 机器码。
 *
 * ── 为什么必须落盘缓存（踩过的坑）──
 *
 * 原来的算法是 MD5(hostname + CPU型号 + PROCESSOR_IDENTIFIER)。
 * 实测发现同一个 EXE 在不同时刻会算出**不同的机器码**：
 *   · `license status` → 25C2B
 *   · `grab`（Chrome 占满 CPU 时）→ C7998
 *
 * 原因是 cpuModel() 在 os.cpus() 返回空时会回退到 PowerShell，
 * 而 PowerShell 给的字符串和 os.cpus()[0].model 不完全一样。
 * 更糟的是 PROCESSOR_IDENTIFIER 在子进程环境里可能缺失。
 *
 * 后果：客户激活后换个功能就提示"机器码不匹配"，这是灾难级 bug。
 *
 * 修法：
 *   1. 算法只用**稳定项**：hostname + PROCESSOR_IDENTIFIER + arch
 *   2. CPU 型号只作为「有就用、没有就跳过」的可选项，不参与必需路径
 *   3. **首次算出来就落盘**，之后永远读缓存 —— 保证同一台机器只有一个码
 */
function machineFile() {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, APP_DIR, 'machine.txt');
}

/** 算一次原始机器码（不读缓存） */
function computeMachineCode() {
  // 只取稳定项。stableProcessorId() 优先读注册表，
  // 不依赖父进程环境块 —— 这是「同一台机器两个机器码」的真正修法。
  const host = os.hostname() || 'no-host';
  const procId = stableProcessorId();

  // CPU 型号：能拿到就加，拿不到就跳过。
  // 注意：这里**不做 PowerShell 回退** —— 回退会让结果不稳定。
  let cpu = '';
  try {
    const cpus = os.cpus();
    if (cpus && cpus.length && cpus[0] && cpus[0].model) {
      cpu = String(cpus[0].model).trim();
    }
  } catch {}

  const parts = cpu ? [host, cpu, procId] : [host, procId];
  const h = crypto.createHash('md5').update(parts.join('|'), 'utf-8').digest('hex').toUpperCase();
  return (h.replace(/[01OI]/g, '') + h).slice(0, 5);
}

export function machineCode() {
  if (_machineCache) return _machineCache;

  // 1. 优先读已保存的
  try {
    const saved = fs.readFileSync(machineFile(), 'utf-8').trim();
    if (/^[A-Z0-9]{5}$/.test(saved)) {
      _machineCache = saved;
      return saved;
    }
  } catch {}

  // 2. 算一个并保存
  const code = computeMachineCode();
  _machineCache = code;
  try {
    fs.mkdirSync(path.dirname(machineFile()), { recursive: true });
    fs.writeFileSync(machineFile(), code, 'utf-8');
  } catch {}
  return code;
}

// ───────────────────── 卡密生成 / 校验 ─────────────────────
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉 I O 0 1

/**
 * 卡密档位（订阅版）。
 *
 * 档位只影响「生成时算多少天」，不改变卡密结构 —— 到期日已经在卡密里，
 * 校验端只看到期时间，不需要知道当初卖的是日卡还是年卡。
 *
 * days 是相对签发日的时长。
 * forever 特殊：用"距 EPOCH 的最大可编码天数"而非相对天数，
 * 因为 3 位 base32 的上限是 32767 天（距 2024-01-01），
 * 相对今天再加 32767 会溢出。
 */
const TIERS = {
  day:      { label: '日卡',   days: 1 },
  week:     { label: '周卡',   days: 7 },
  month:    { label: '月卡',   days: 30 },
  quarter:  { label: '季卡',   days: 90 },
  year:     { label: '年卡',   days: 365 },
  forever:  { label: '永久卡', days: 32767, absolute: true },  // 距 EPOCH 上限
};

export const TIER_KEYS = Object.keys(TIERS);

export function tierInfo(tier) {
  const t = TIERS[String(tier || '').toLowerCase()];
  return t ? { key: String(tier).toLowerCase(), ...t } : null;
}

export function tierLabel(tier) {
  return TIERS[String(tier || '').toLowerCase()]?.label || String(tier || '');
}

/** 按档位算到期日字符串（YYYY-MM-DD） */
export function tierExpiry(tier, baseDate = new Date()) {
  const t = TIERS[String(tier || '').toLowerCase()];
  if (!t) throw new Error('未知档位: ' + tier);

  if (t.absolute) {
    // 绝对档：直接用"距 EPOCH 的天数"，不叠加今天
    return daysToExpiry(t.days);
  }
  return new Date(baseDate.getTime() + t.days * 86400000).toISOString().slice(0, 10);
}

// 裸标识符 createDecipheriv 会被 strings 抓到，用数组 join 拆开（minify 不折叠 join）
const CD = ['create', 'Decipheriv'].join('');

function hmac4(payload) {
  // 走 secret.mjs 的 hmac()，不在本文件里直接拼密钥 ——
  // 这样 bundle 里不会再出现 "createHmac('sha256', <明文>)" 这种一眼可抄的形态。
  const h = secretHmac(payload).digest('hex').toUpperCase();
  return h.slice(0, 4);
}

function normalize(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * 生成卡密（给开发者用，不在用户端暴露）。
 * @param {string} bindTo 机器码；传空/不传 = 不绑定（万能码，慎用）
 * @returns {string} XXXXX-XXXXX-XXXXX-XXXX
 */
/**
 * 卡密结构（订阅版）
 *
 *   XXXXX-XXXXX-XXXXX-YYYY
 *   └──10位随机──┘└绑定┘└签名┘
 *
 * 到期日不直接写进卡密（太长且肉眼可改），而是**编码进前 10 位随机段**：
 *   · 第 1-3 位 = 到期日距 2024-01-01 的天数（base32，3 位可覆盖 ~32 年）
 *   · 第 4-10 位 = 真随机
 *
 * 为什么这样设计：
 *   到期日参与了 HMAC 签名，改一位签名就崩。
 *   而且肉眼看不出哪几位是日期，用户没法"猜"着改。
 *
 * 校验顺序：签名 → 机器绑定 → 到期时间。三道都过才算有效。
 */

// 天数基准：2024-01-01 UTC。往前推太多没意义，往后 3 位 base32 够 32768 天（89 年）
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

/** 把 "2026-11-25" 或 Date 转成"距基准的天数" */
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

/** 天数转回 "YYYY-MM-DD" */
function daysToExpiry(days) {
  const d = new Date(EPOCH_MS + days * 86400000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/**
 * 生成卡密。
 * @param {string} bindTo  机器码；'XXXXX' 表示不绑定
 * @param {string|Date} [expiryOrTier] 到期日 "YYYY-MM-DD"，或档位名（day/week/month/quarter/year/forever）
 * @param {object} [opts]  { tier } 显式指定档位（优先级低于第二参数的档位名）
 *
 * 两种调用方式：
 *   generateKey('25C2B', '2027-01-01')   // 指定到期日
 *   generateKey('25C2B', 'year')         // 指定档位，自动算到期日
 */
export function generateKey(bindTo, expiryOrTier, opts = {}) {
  const bind = normalize(String(bindTo || '').padEnd(5, 'X')).slice(0, 5);

  let exp;
  const tierKey = String(opts.tier || expiryOrTier || '').toLowerCase();
  if (TIERS[tierKey]) {
    // 传的是档位名
    exp = tierExpiry(tierKey);
  } else if (expiryOrTier instanceof Date) {
    exp = expiryOrTier.toISOString().slice(0, 10);
  } else if (typeof expiryOrTier === 'string' && expiryOrTier) {
    exp = expiryOrTier;                                  // 传的是到期日
  } else {
    const d = new Date();
    d.setUTCFullYear(d.getUTCFullYear() + 1);
    exp = d.toISOString().slice(0, 10);                  // 默认一年
  }

  const days = expiryToDays(exp);
  if (days < 0 || days > 32767) throw new Error('到期日超出可编码范围');

  const datePart = daysToBase32(days, 3);          // 3 位 base32 = 到期日

  // ── 时长字段（v1.1.0 加，为了支持续费累加）──
  //
  // 为什么需要它：卡密里原来只有"绝对到期日"，没有"这张卡值多少天"。
  // 续费时就无法算出该叠加多少 —— 只能覆盖（旧行为，年卡会被日卡吃掉）。
  //
  // 编码：2 位 base32 = 0..1023 天。永久卡存 1023。
  // 位置：payload[3..4]，原来是随机位的一部分（随机位从 7 减到 3，
  //       3 位随机 = 32768 种，防撞够用）。
  //
  // 哨兵 'QZ' 放在 payload[5..6]：旧卡这里是随机字符，
  // 撞上的概率 1/1024 —— 撞了也只是被当成可累加卡，最多多送几天，
  // 不会让已购用户用不了。这个方向的误判是安全的。
  const durDays = (() => {
    const t = String(opts.tier || '').toLowerCase();
    if (t && TIERS[t]) return TIERS[t].absolute ? 1023 : Math.min(1023, TIERS[t].days);
    // 没传档位：用「到期日 - 今天」反推
    const n = Math.round((Date.UTC(
      Number(exp.slice(0, 4)), Number(exp.slice(5, 7)) - 1, Number(exp.slice(8, 10))
    ) - Date.now()) / 86400000);
    if (n >= 1023) return 1023;
    return Math.max(1, Math.min(1023, n));
  })();

  const durPart = daysToBase32(durDays, 2);        // 2 位 base32 = 时长
  const MARK = 'QZ';                               // 哨兵：标记这是可累加的新卡
  const randPart = (() => {
    let s = '';
    for (let i = 0; i < 3; i++) s += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
    return s;
  })();

  const payload = datePart + durPart + MARK + randPart + bind;   // 3+2+2+3+5 = 15
  const c = payload + hmac4(payload);
  return `${c.slice(0, 5)}-${c.slice(5, 10)}-${c.slice(10, 15)}-${c.slice(15, 19)}`;
}

/**
 * 校验卡密。
 * @returns {{ok, reason?, machine?, bind?, payload?, expiry?, daysLeft?, expired?}}
 */
export function verifyKey(input) {
  const raw = normalize(input);
  if (raw.length !== 19) return { ok: false, reason: 'length' };

  const payload = raw.slice(0, 15);
  const sig = raw.slice(15, 19);
  const expect = hmac4(payload);

  // 时间安全比较：避免通过响应时间逐位试探
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) {
    return { ok: false, reason: 'signature' };
  }

  // 解出到期日
  const days = base32ToDays(payload.slice(0, 3));
  if (days < 0) return { ok: false, reason: 'signature' };
  const expiry = daysToExpiry(days);

  // ── 时长（续费累加用）──
  // 哨兵 'QZ' 在 payload[5..6]。旧卡这里随机，撞上就按可累加处理（安全方向）。
  // durDays = 0 表示"未知时长"（旧卡），activate 会退回覆盖逻辑。
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

  // ── 时间回拨检测 ──
  // 用户把系统时间调回过去，就能让已过期的卡"复活"。
  // 对策：每次校验都记录见过的最大时间戳；发现当前时间明显早于
  // 历史最大值，就判定为篡改，直接拒绝。
  //
  // 容差 2 天：用户可能跨时区、或系统时间有轻微偏差，别误伤。
  const nowRaw = Date.now();
  const clock = readClockMark();
  if (clock && nowRaw < clock.maxSeen - 2 * 86400000) {
    return {
      ok: false,
      reason: 'clock-rollback',
      bind, machine: my, expiry,
      clockBehindDays: Math.round((clock.maxSeen - nowRaw) / 86400000),
    };
  }
  writeClockMark(nowRaw);

  // 到期判断：按 UTC 当天 23:59:59 算，当天仍可用
  const now = nowRaw;
  const expMs = EPOCH_MS + days * 86400000 + 86399999;
  const daysLeft = Math.ceil((expMs - now) / 86400000);
  const tierInfo = inferTier(daysLeft);

  if (now > expMs) {
    return { ok: false, reason: 'expired', bind, machine: my, expiry, daysLeft: 0, expired: true, tier: tierInfo.key, tierLabel: tierInfo.label };
  }

  return {
    ok: true, payload, sig4: sig, bind, machine: my, expiry, daysLeft,
    tier: tierInfo.key, tierLabel: tierInfo.label,
    durDays, additive,          // ← 续费累加用；additive=false 表示旧卡（只有到期日）
  };
}

/**
 * 由剩余天数反推档位，仅用于界面显示（不影响校验）。
 *
 * 注意 daysLeft 是 Math.ceil 过的，且到期日按 UTC 日界算，
 * 所以"日卡"签发后当天可能显示剩 2 天。这里把阈值放宽一天，
 * 避免日卡被误显示成周卡。
 */
function inferTier(daysLeft) {
  const d = Math.max(0, Number(daysLeft) || 0);
  if (d <= 2) return { key: 'day', label: TIERS.day.label };
  if (d <= 8) return { key: 'week', label: TIERS.week.label };
  if (d <= 32) return { key: 'month', label: TIERS.month.label };
  if (d <= 93) return { key: 'quarter', label: TIERS.quarter.label };
  if (d <= 400) return { key: 'year', label: TIERS.year.label };
  return { key: 'forever', label: TIERS.forever.label };
}

// ───────────────────── 时间戳记录（防回拨） ─────────────────────
/**
 * 记录"见过的最新时间"。
 *
 * 为什么不只存在 license.txt 里：用户删掉 license.txt 重装就重置了。
 * 所以单独一个文件，且和 license 一起被清掉时会同时丢 —— 这是已知局限，
 * 但挡住"只改系统时间"这种最常见的手法已经够用。
 *
 * 真要更硬需要联网校时或写注册表多处冗余，那会显著增加复杂度，
 * 对小规模销售不划算。
 */
function clockPath() {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, APP_DIR, 'clock.dat');
}

function readClockMark() {
  try {
    const raw = fs.readFileSync(clockPath(), 'utf-8');
    const obj = JSON.parse(Buffer.from(raw, 'base64').toString('utf-8'));
    if (obj && typeof obj.maxSeen === 'number') return obj;
  } catch {}
  return null;
}

function writeClockMark(ts) {
  try {
    const cur = readClockMark();
    const maxSeen = Math.max(ts, cur ? cur.maxSeen : 0);
    const body = Buffer.from(JSON.stringify({ maxSeen }), 'utf-8').toString('base64');
    fs.mkdirSync(path.dirname(clockPath()), { recursive: true });
    fs.writeFileSync(clockPath(), body, 'utf-8');
  } catch {}
}

// ───────────────────── 落盘（XOR 混淆） ─────────────────────
/**
 * 存储位置：%APPDATA%\<工具名>\license.txt
 * 内容：XOR 混淆后的 base64，加上 4 字节校验。
 * 注意：这不是加密，只是让别人「打开文件看到的东西不像卡密」。
 */
const APP_DIR = 'UnifiedDownloader';

export function licenseDir() {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, APP_DIR);
}

export function licensePath() {
  return path.join(licenseDir(), 'license.txt');
}

// ═══════════════════ 已用卡密记录（防重复激活）═══════════════════
//
// 为什么需要它（v1.1.0 改成累加后暴露的漏洞）：
//   累加规则是「新到期 = max(今天,旧到期) + 本卡时长」。
//   如果同一张卡能反复激活，那就是**无限刷时长**：
//     同一张月卡点 3 次 → 30 天 × 3 = 90 天，白送两个月。
//   实测确认过：364 → 394 → 424 → 454。
//
// 为什么只存哈希：
//   万一用户把 used-cards.txt 发出去，也看不到卡密原文（卡密=钱）。
//
// 为什么用 HMAC 而不是裸 sha256：
//   卡密空间有限（3位到期+2位时长+2位哨兵+3位随机+5位机器码），
//   裸哈希能被离线穷举反查。用 SECRET 做 HMAC 就无法反查。
//
// ⚠ 本地方案的边界（必须诚实写清）：
//   删掉 %APPDATA%\UnifiedDownloader\ 整个目录，记录就没了，
//   同一张卡又能激活。真正杜绝只有服务端记录一条路。
//   这里的定位是：堵住"手滑点两次""同一张卡发给两个人"这类**无意重复**，
//   不是对抗有意的删档破解。
function usedCardsPath() {
  return path.join(licenseDir(), 'used-cards.txt');
}

/** 卡密的指纹（HMAC-SHA256 前 16 位十六进制，不可逆） */
function cardFingerprint(code) {
  const clean = normalize(code);
  return secretHmac('used|v1|' + clean).digest('hex').slice(0, 16).toUpperCase();
}

/**
 * 读已用卡密记录。
 *
 * 格式（一行一条，TAB 分隔）：
 *   FINGERPRINT<TAB>EXPIRY<TAB>ISO_TIME
 *
 * 为什么存到期日而不只是指纹：
 *   用户买了 3 张月卡累加到 454 天，重装系统后拿第一张卡恢复，
 *   如果只按卡内日期算就是 31 天 —— 累加的 423 天全丢。
 *   存下"这张卡激活后达到的到期日"，恢复时取历史最高值就能补回来。
 *   （实测：修复前 454 → 31 天，丢 423 天）
 *
 * 兼容旧格式：没有 TAB 的纯指纹行也能读（expiry 为 null）。
 */
function readUsedCards() {
  const map = new Map();          // fp -> { expiry, at }
  try {
    const t = fs.readFileSync(usedCardsPath(), 'utf-8');
    for (const line of t.split(/\r?\n/)) {
      const raw = line.trim();
      if (!raw) continue;
      const parts = raw.split('\t');
      const fp = String(parts[0] || '').trim().toUpperCase();
      if (!fp) continue;
      const expiry = parts[1] && /^\d{4}-\d{2}-\d{2}$/.test(parts[1].trim())
        ? parts[1].trim() : null;
      const at = parts[2] || null;
      map.set(fp, { expiry, at });
    }
  } catch { /* 文件不存在 = 没有记录 */ }
  return map;
}

/**
 * 记一条已用卡密。
 * @param {string} code   卡密
 * @param {string} expiry 这张卡激活后达到的到期日（YYYY-MM-DD）
 */
function markCardUsed(code, expiry) {
  const fp = cardFingerprint(code);
  const map = readUsedCards();
  const prev = map.get(fp);
  // 到期日只增不减：同一指纹重复写时保留更晚的那个
  let keep = expiry || (prev && prev.expiry) || null;
  if (prev && prev.expiry && expiry && prev.expiry > expiry) keep = prev.expiry;
  map.set(fp, { expiry: keep, at: new Date().toISOString() });

  try {
    fs.mkdirSync(licenseDir(), { recursive: true });
    const lines = [...map.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => [k, v.expiry || '', v.at || ''].join('\t').replace(/\t+$/, ''));
    fs.writeFileSync(usedCardsPath(), lines.join('\n') + '\n', 'utf-8');
  } catch { /* 写不进去也不该让激活失败 */ }
  return fp;
}

/** 这张卡是不是已经用过（指纹层面） */
export function isCardUsed(code) {
  return readUsedCards().has(cardFingerprint(code));
}

/**
 * 本机历史上达到过的**最晚到期日**。
 *
 * 恢复授权时用它兜底：如果历史最高比"按卡内日期算出来的"更晚，
 * 说明用户之前累加过，不能让他因为重装而丢天数。
 *
 * 只认本机自己的记录 —— 换台机器没有这个文件，仍然按卡内日期算，
 * 不会变成"一张卡跨机器白拿"。
 */
export function maxSeenExpiry() {
  let best = null;
  for (const { expiry } of readUsedCards().values()) {
    if (expiry && (!best || expiry > best)) best = expiry;
  }
  return best;
}

function xorBuf(buf, key) {
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ key[(i * 7 + 3) % key.length];
  return out;
}

/**
 * 保存激活数据。
 * 存的是「卡密 + 专属 blob」整体，不是单纯卡密。
 */
export function saveLicense(code, blob) {
  const clean = normalize(code);
  const body = Buffer.from(
    JSON.stringify({
      c: clean,
      b: blob ? { d: blob.d, i: blob.i, t: blob.t } : null,
      t: new Date().toISOString(),
      m: machineCode(),
    }),
    'utf-8'
  );
  const obf = xorBuf(body, Buffer.from('udl-2026'));
  const sealed = Buffer.concat([Buffer.from('UDL2'), obf]);
  const sum = crypto.createHash('sha256').update(sealed).digest().subarray(0, 4);
  const out = Buffer.concat([sealed, sum]);

  fs.mkdirSync(licenseDir(), { recursive: true });
  fs.writeFileSync(licensePath(), out.toString('base64'), 'utf-8');
}

export function clearLicense() {
  try { fs.rmSync(licensePath(), { force: true }); } catch {}
}

/**
 * 读本地激活数据并重新校验。
 * 每次都重算机器码 —— 换机器后拷 license.txt 也没用。
 */
export function loadLicense() {
  let b64;
  try { b64 = fs.readFileSync(licensePath(), 'utf-8'); } catch { return { ok: false, reason: 'absent' }; }

  let buf;
  try { buf = Buffer.from(b64.trim(), 'base64'); } catch { return { ok: false, reason: 'corrupt' }; }
  const magic = buf.subarray(0, 4).toString();
  if (buf.length < 12 || (magic !== 'UDL1' && magic !== 'UDL2')) return { ok: false, reason: 'corrupt' };

  const sealed = buf.subarray(0, buf.length - 4);
  const sum = buf.subarray(buf.length - 4);
  const expect = crypto.createHash('sha256').update(sealed).digest().subarray(0, 4);
  if (!sum.equals(expect)) return { ok: false, reason: 'tampered' };

  let obj;
  try {
    obj = JSON.parse(xorBuf(buf.subarray(4, buf.length - 4), Buffer.from('udl-2026')).toString('utf-8'));
  } catch { return { ok: false, reason: 'corrupt' }; }

  if (!obj || !obj.c) return { ok: false, reason: 'corrupt' };

  const v = verifyKey(obj.c);
  if (!v.ok) return { ok: false, reason: v.reason, code: obj.c };
  return { ok: true, code: obj.c, blob: obj.b || null, savedAt: obj.t, machine: v.machine };
}

// ───────────────────── 对外：一站式激活 ─────────────────────
/**
 * 激活。
 * @param {string} input  Activation code 或纯卡密
 * @returns {{ok:boolean, reason?:string, machine?:string, config?:object, resource?:object, needBlob?:boolean}}
 */
export function activate(input) {
  const dec = decodeActivation(input);
  if (dec.kind === 'bad') return { ok: false, reason: 'format' };

  let code = dec.code;
  const v = verifyKey(code);
  if (!v.ok) return v;

  // ── 防重放：这张卡是不是已经用过了 ──
  //
  // 累加功能让"重复激活同一张卡"变成刷时长漏洞（实测 364→394→424→454）。
  // 这里做两层判断：
  //   1. 指纹在已用列表里 → 这张卡确实用过
  //   2. 但"用过"不等于"必须拒绝" —— 用户重装系统后要恢复授权，
  //      或者续费累加后重签了新卡（code 变了，指纹也变了，不受影响）
  //
  // 所以真正要拒的是「纯重放」：激活后到期日没有任何增长。
  // 这个判断放在算完 finalExpiry 之后（见下面 replayRejected）。
  const fp = cardFingerprint(code);
  const alreadyUsed = readUsedCards().has(fp);

  // 解密资源：这一步就是「卡密参与真实运算」
  const r = unlockResource(code, dec.blob);
  if (!r.ok) {
    return {
      ok: false,
      reason: 'blob:' + r.reason,
      needBlob: true,
      machine: v.machine,
    };
  }

  // ═══════════════ 续费累加（v1.1.0）═══════════════
  //
  // 旧行为：saveLicense(code) 直接覆盖 —— 年卡会被日卡吃掉（白丢 364 天）。
  //
  // 新规则：新到期 = max(今天, 旧到期) + 这张卡的时长
  //
  //   已有年卡（剩 300 天） + 新买月卡（30 天） → 剩 330 天
  //   已过期             + 新买月卡（30 天） → 剩 30 天
  //   首次激活           + 月卡（30 天）      → 剩 30 天
  //
  // 为什么不是"旧到期 + 时长"（直接相加）：
  //   那样"已过期三年"的卡也能白拿三年 + 新时长，等于给过期用户补历史。
  //   取 max(今天, 旧到期) 才是正确的续费语义。
  //
  // 兼容旧卡（additive=false）：卡里没有时长字段，只能按覆盖处理，
  // 但要**取较晚者** —— 短卡覆盖长卡对用户是净损失，必须避免。
  let finalExpiry = v.expiry;
  let finalDaysLeft = v.daysLeft;
  let stacked = false;
  let stackNote = '';

  const prev = loadLicense();
  const prevInfo = prev.ok ? verifyKey(prev.code) : null;
  const prevExpiry = prevInfo && prevInfo.ok ? prevInfo.expiry : null;

  if (prevExpiry && prevExpiry !== v.expiry) {
    const dayMs = 86400000;
    const toMs = (d) => Date.UTC(
      Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))
    );

    const prevMs = toMs(prevExpiry);
    const newMs = toMs(v.expiry);
    const todayMs = Date.UTC(
      new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()
    );

    if (v.additive && v.durDays > 0) {
      // 新卡带时长 → 真累加
      const baseMs = Math.max(todayMs, prevMs);
      const sumMs = baseMs + v.durDays * dayMs;
      const sumDate = new Date(sumMs);
      const sumExp = sumDate.toISOString().slice(0, 10);

      // 只有当累加结果**比原来两张卡都晚**才有意义
      if (sumMs > Math.max(prevMs, newMs)) {
        finalExpiry = sumExp;
        finalDaysLeft = Math.ceil(
          (EPOCH_MS + expiryToDays(sumExp) * dayMs + 86399999 - Date.now()) / dayMs
        );
        stacked = true;
        stackNote = `累加：${prevExpiry} + ${v.durDays} 天 → ${sumExp}`;

        // 重新签发一张卡，把累加后的到期日写进去。
        // 不重签的话下次 status() 读的还是卡里原来的到期日，累加就白做了。
        const rebind = v.bind || 'XXXXX';
        const newCode = generateKey(rebind, sumExp, { tier: null });

        // ⚠ 关键：blob 是用 deriveResourceKey(整张卡密) 派生密钥加密的。
        //   换了 code 就必须用**新 code** 重新加密，否则存盘后
        //   unlockResource(新code, 旧blob) 密钥对不上 →
        //   reason:'resource:decrypt' → 表现为"激活成功、重启就失效"。
        //   （这个坑实测踩过：累加算对了，但 status() 返回 activated:false）
        const newBlob = resealBlob(r.res, newCode);
        code = newCode;
        dec.blob = newBlob;
      }
    } else {
      // 旧卡（没时长字段）：取较晚者，绝不让短卡吃掉长卡
      if (prevMs > newMs) {
        finalExpiry = prevExpiry;
        finalDaysLeft = prevInfo.daysLeft;
        stackNote = `旧卡无时长字段，保留较晚的 ${prevExpiry}（不覆盖）`;
      }
    }
  }

  // ── 防重放判定 ──
  //
  // 判据就是「这张卡的指纹已在已用列表里」，**不再比日期**。
  //
  // 为什么不比日期（踩过的坑）：累加规则是 max(今天,旧到期)+时长，
  // 所以同一张卡第二次激活算出的到期日**永远比原来大**（394→424→454）。
  // 一开始写的是 `if (alreadyUsed && 新到期 <= 旧到期)`，
  // 那个条件永不成立，防重放形同虚设 —— 实测同一张月卡连点 3 次，
  // 天数从 364 一路涨到 454。
  //
  // 唯一的例外：**当前没有有效激活**时允许重新激活。
  //   场景：用户重装系统 / 删了配置目录，拿原卡恢复授权。
  //   这是合理的（他买的还是同一份授权，不该因为重装就作废）。
  //   有 prevExpiry 说明本机已激活，再用同一张卡就是重放。
  if (alreadyUsed && prevExpiry) {
    return {
      ok: false,
      reason: 'card-used',
      machine: v.machine,
      expiry: prevExpiry,
      daysLeft: prevInfo ? prevInfo.daysLeft : undefined,
      fingerprint: fp,
    };
  }

  // ── 重装恢复：本机没激活，但用过卡 ──
  //
  // 场景：用户买了 3 张月卡累加到 454 天，重装系统后拿第 1 张卡恢复。
  // 只按卡内日期算 → 31 天，累加的 423 天全丢（实测过）。
  //
  // 所以拿本机历史最高到期日兜底：比按卡内算的更晚，就用历史值。
  // 只认本机记录（used-cards.txt）—— 换台机器没有这个文件，
  // 仍按卡内日期算，不会变成"一张卡跨机器白拿"。
  if (!prevExpiry) {
    const hist = maxSeenExpiry();
    if (hist && hist > finalExpiry) {
      const histDays = Math.ceil(
        (EPOCH_MS + expiryToDays(hist) * 86400000 + 86399999 - Date.now()) / 86400000
      );
      // 历史值还没过期才用它（过期了就用卡内日期重新开始）
      if (histDays > 0) {
        stackNote = `恢复：按本机历史记录恢复到 ${hist}（卡内日期只有 ${finalExpiry}）`;
        finalExpiry = hist;
        finalDaysLeft = histDays;
        stacked = false;

        // ⚠ 必须重签卡，把恢复后的到期日写进去。
        //   只改 finalExpiry 不够 —— saveLicense 存的是原始卡，
        //   status() 里 verifyKey(原始卡) 返回的 expiry 还是卡内日期，
        //   天数照样是 31。实测踩过：stackNote 显示找到 2028-01-25，
        //   但 status() 仍然是 31 天。
        const rbind = v.bind || 'XXXXX';
        const rcode = generateKey(rbind, hist, { tier: null });
        const rblob = resealBlob(r.res, rcode);
        code = rcode;
        dec.blob = rblob;
      }
    }
  }

  // 记账：**原始卡密**必须单独记（这是防重放的关键）。
  //
  // ⚠ 不能只记 code —— 累加时 code 已经被换成重签的新卡，
  //   原始卡密的指纹就从没进过列表，于是"同一张卡反复激活"永远判不出来。
  //   实测踩过：used-cards.txt 里有 3 条记录，全是重签卡，原始卡一条没有。
  // 记「这张卡激活后达到的到期日」，供重装恢复时兜底
  markCardUsed(dec.code, finalExpiry);
  // 重签的新 code 也记一条（用户拿重签卡再激活时不漏判）
  if (code !== dec.code) markCardUsed(code, finalExpiry);

  saveLicense(code, dec.blob);
  return {
    ok: true,
    machine: v.machine,
    payload: v.payload,
    expiry: finalExpiry,
    daysLeft: finalDaysLeft,
    config: configFor(v.payload, v.sig4),
    resource: r.res,
    sealed: dec.kind === 'sealed',
    stacked,                      // 是否发生了累加
    stackNote,                    // 给 UI/CLI 显示的一行说明
    prevExpiry,                   // 激活前的到期日（null = 首次）
  };
}

export function status() {
  const lic = loadLicense();
  if (!lic.ok) return { activated: false, reason: lic.reason, machine: machineCode() };

  const v = verifyKey(lic.code);
  if (!v.ok) {
    return {
      activated: false,
      reason: v.reason,
      machine: machineCode(),
      expiry: v.expiry,
      expired: !!v.expired,
      tier: v.tier,
      tierLabel: v.tierLabel,
      code: lic.code,
    };
  }

  const r = unlockResource(lic.code, lic.blob);
  if (!r.ok) return { activated: false, reason: 'resource:' + r.reason, machine: machineCode() };

  return {
    activated: true,
    code: lic.code,
    savedAt: lic.savedAt,
    machine: lic.machine,
    expiry: v.expiry,
    daysLeft: v.daysLeft,
    tier: v.tier,
    tierLabel: v.tierLabel,
    config: configFor(v.payload, v.sig4),
    resource: r.res,
  };
}

// ───────────────────── 派生媒体密钥（关键） ─────────────────────
/**
 * 加密的「运行必需资源」。
 *
 * ── 这一层是整套防护的核心，值得花点篇幅说清 ──
 *
 * 需求：用户绕过卡密校验（把 verifyKey 改成 return {ok:true}）时，
 *       程序必须**真的跑不起来**，而不只是"少了个高级功能"。
 *
 * 做法：把下载流程**必须用到**的资源加密存起来 ——
 *       具体是 CDN 镜像表（没有它，B站视频流在多数网络环境直接连不上）。
 *
 *       key 的来源包含卡密末 4 位签名（sig4）：
 *         key = HMAC(SECRET, 'res|v1|' + sig4_prefix)
 *
 *       为了让所有用户共用一份 blob（零运维），这里对 sig4 做**归一化**：
 *       只取 sig4 的校验位特征参与派生 —— 详见 deriveResourceKey。
 *
 * ── 诚实的说明 ──
 *   共享 blob 意味着 key 在大范围内相同，理论上可以被提取复用。
 *   真正的防护来自"攻击者必须理解并重新实现整条派生链"，
 *   而不是密码学上的不可破。任何本地离线方案都是这个性质。
 *
 *   如果哪天要更强，就上「一卡一 blob」（见 gen-license.mjs 的 sealwith），
 *   代价是每卖一份要单独生成并下发。
 */
/**
 * 激活数据 = 卡密 + 该卡密专属的资源 blob。
 *
 * ── 为什么必须一卡一 blob（走过三条弯路之后） ──
 *
 *   弯路一：key 吃完整 payload      → 一卡一 blob（当时的结论：不可行，运维重）
 *   弯路二：key 吃档位（4 档共享）   → 伪造 payload 有 1/4 概率蒙对，实测能解开
 *   弯路三：key 吃 sig4（16 桶共享） → 伪造者随便编 4 字符也落进某个桶，实测能解开
 *
 *   根因（数学性质，不是实现 bug）：
 *     只要「所有可能的桶都有 blob」，伪造就一定能解开；
 *     要让伪造必失败，就必须有「空桶」，而空桶会让真用户也激活失败。
 *     除非 —— 每个用户一份专属 blob。所以只能一卡一 blob。
 *
 * ── 运维成本的实际解法 ──
 *
 *   blob 只有约 144 字符（见 gen-license.mjs 输出），
 *   把它和卡密拼成**一整串激活码**发给用户，用户一次性粘贴即可。
 *   卖 1000 份就生成 1000 张，生成器可以批量跑。
 *
 * 激活码格式：
 *   BASE64(JSON{ k: 卡密, d: 密文, i: iv, t: tag })
 *   形如：eyJrIjoiRzZaV0MtOVVQNUwtMjVDMkItMDJGQiIsImQiOiJ...
 *
 *   用户看到的是一串长 base64，粘贴后自动解出卡密与 blob。
 *   如果想保持"卡密式"手感，也可以让用户分两次输入（卡密 + blob）。
 */
export function decodeActivation(input) {
  const t = String(input || '').trim();
  // 兼容：纯卡密（走 shared 模式或未加密发行）
  if (/^[A-Za-z0-9]{4,5}(-[A-Za-z0-9]{4,5}){3}$/.test(t)) {
    return { kind: 'plain', code: t };
  }
  // 标准：base64(JSON)
  try {
    const raw = Buffer.from(t.replace(/\s+/g, ''), 'base64').toString('utf-8');
    const obj = JSON.parse(raw);
    if (obj && obj.k) {
      return { kind: 'sealed', code: String(obj.k), blob: obj };
    }
  } catch {}
  return { kind: 'bad' };
}

/**
 * 用卡密 + 专属 blob 解密运行必需资源。
 *
 * key = HMAC(SECRET, 'res|v1|' + 完整卡密)
 *   —— 一卡一 key，伪造者没有合法卡密就推不出 key，GCM 必然失败。
 */
/**
 * 用指定卡密重新加密资源 blob。
 *
 * 为什么需要它：blob 的密钥来自 deriveResourceKey(整张卡密)。
 * 卡密一变（比如续费累加后重签），旧 blob 就解不开了。
 * 所以重签时必须把资源用新密钥重新封一遍。
 *
 * @param {object} res  已解出的资源对象
 * @param {string} code 新的卡密
 * @returns {{d:string, i:string, t:string}}
 */
function resealBlob(res, code) {
  const key = deriveResourceKey(code);
  const iv = crypto.randomBytes(12);
  const CD = ['create', 'Cipheriv'].join('');
  const c = crypto[CD]('aes-256-gcm', key, iv);
  const enc = Buffer.concat([
    c.update(JSON.stringify(res), 'utf-8'),
    c.final(),
  ]);
  return {
    d: enc.toString('base64'),
    i: iv.toString('base64'),
    t: c.getAuthTag().toString('base64'),
  };
}

export function deriveResourceKey(sig4OrCode) {
  const c = String(sig4OrCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (c.length < 19) throw new Error('bad code');
  return secretHmac('res|v1|' + c).digest();
}

/**
 * 解密资源。
 * @param {string} code 完整卡密
 * @param {object} blob { d, i, t }
 */
/**
 * 解密运行必需资源（CDN 镜像表等）。
 *
 * 必须同时有 code 和 blob 才能解 —— 这是整套防护的关键：
 *   · 只有 code（没 blob）→ 拒绝。否则删掉 blob 就能白拿资源
 *   · blob 被改一个字节  → GCM 认证失败 → 拒绝
 *   · code 与 blob 不配对 → key 不对 → 拒绝
 *
 * 开发态例外：设置了 DSH_DL_DEV=1 时放行默认资源，方便本地调试。
 * 发布版绝不能带这个环境变量。
 */
export function unlockResource(code, blob) {
  const devMode = process.env.DSH_DL_DEV === '1';

  if (!blob || !blob.d) {
    if (devMode) return { ok: true, res: defaultResource(), plain: true };
    // 没 blob 就是没激活（或激活数据被删）。给内置资源等于放弃防护。
    return { ok: false, reason: 'no-blob' };
  }

  try {
    const key = deriveResourceKey(code);
    const iv = Buffer.from(blob.i, 'base64');
    const tag = Buffer.from(blob.t, 'base64');
    const data = Buffer.from(blob.d, 'base64');
    const d = crypto[CD]('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    const plain = Buffer.concat([d.update(data), d.final()]);
    return { ok: true, res: JSON.parse(plain.toString('utf-8')) };
  } catch {
    return { ok: false, reason: 'decrypt' };
  }
}

/** 资源解不开时，下载会因为没有 CDN 镜像表而失败 —— 这就是"真实运算" */

/**
 * 发布版内置的资源表。
 *
 * ── 为什么这里是空的 ──
 *   一卡一 blob 方案下，每张激活码自带 blob，不需要内置表：
 *     激活码 = base64{ k: 卡密, d/i/t: 该卡专属加密资源 }
 *   内置表只在"免激活试用版"场景才有意义，而那种模式等于没防护。
 *
 *   所以：RES_BLOBS 保持空对象，unlockResource 只认激活码带来的 blob。
 *   如果有人想改成"内置一份共享 blob"，会退化成伪造可解（见卡密说明文档第三章）。
 */
const RES_BLOBS = {};

/** 功能开关配置（明文，不含敏感逻辑；真正的门在 unlockResource） */
function configFor(_payload, _sig4) {
  return defaultConfig();
}

/** 供生成器调用 */
export function __secret() { return SECRET(); }

export const RES_BLOB_STATE = () => ({ devMode: process.env.DSH_DL_DEV === '1' });

/**
 * 内置默认资源（未提供 blob 时的开发态回退）。
 *
 * ⚠ 正式发行前务必确认：这个函数**不能**包含完整的镜像表。
 *   否则破解者只要删掉 blob 校验、让它走到这个分支，就白拿镜像表，
 *   整个"卡密参与运算"的门就形同虚设。
 *   正式包里这里只给空表 —— 没有 blob 就没有镜像，下载会失败。
 */
function defaultResource() {
  // 正式发行版：内置资源里**不放任何镜像域名**。
  // 镜像表只从激活码解密得到 —— 这样二进制里没有可抄的东西，
  // 也避免了"删掉 blob 就能白拿"的退化路径。
  //
  // 开发调试（DSH_DL_DEV=1）才给一份，方便本地跑通。
  if (process.env.DSH_DL_DEV === '1') {
    // 开发模式下从环境变量读，源码里不留域名。
    // 本地调试时设置：
    //   set DSH_DL_DEV=1
    //   set DSH_DL_MIRRORS=host1,host2,host3
    const raw = process.env.DSH_DL_MIRRORS || '';
    const list = raw.split(',').map((x) => x.trim()).filter(Boolean);
    return { v: 1, mirrors: { bilibili: list }, dev: true };
  }
  return { v: 1, mirrors: {}, strict: true };
}

function defaultConfig() {
  return {
    qualities: ['best', '4k', '2160', '1440', '1080', '720', '480', '360'],
    maxConcurrent: 1,
    features: { sites: true, music: true, zhihu: true, video: true },
  };
}
