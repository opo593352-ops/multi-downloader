/**
 * ⚠️ 已废弃 —— 本文件随 v1.2.0 开源，密钥已公开，不再具有任何保护作用。
 *
 * 本软件已转为**完全免费开源**，授权闸门已关闭（见 dev/gate.mjs 的
 * FREE_EDITION = true）。这个文件里的 SECRET 现在只是历史遗留。
 *
 * 如果你 fork 出去想重新做收费版：
 *   1. 用你自己的随机源重新生成 SECRET（不要用这里的值）
 *   2. 重新生成 SCRAMBLED / PERM / IV / CT / TAG / DIGEST
 *   3. 把 gate.mjs 的 FREE_EDITION 改成 false
 *   4. **不要**把新的 secret.mjs 提交到公开仓库
 *
 * 保留这份代码的理由：两千多行卡密逻辑删了很难加回来，
 * 而保留它对普通用户零影响（闸门已经关了）。
 */

/**
 * secret.mjs — 授权主密钥（SECRET）的唯一来源
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么要有这个文件
 * ═══════════════════════════════════════════════════════════════
 *
 * 旧实现（2026-10-27 之前）：
 *
 *   const SEG_MASK = 0x5a;
 *   const SEGS = [[0x6f,0x62,0x6e,0x1b], [0x69,0x69,0x6d,0x18,0x1c], ...];
 *   function buildSecret() {
 *     for (const seg of SEGS) for (const b of seg) out += String.fromCharCode(b ^ SEG_MASK);
 *   }
 *
 * 这是**一串字节 + 一个 XOR 常量**。任何拿到 bundle 的人（哪怕只是 minify 后的
 * 文件，不需要反编译）写三行代码就能打印出 SECRET：
 *
 *   SEGS.flat().map(b => String.fromCharCode(b ^ 0x5a)).join('')
 *
 * 10 秒的事。拿到 SECRET 的后果比"改 return true"严重一个量级：
 *   · 能自己签发任意档位、任意机器码的卡密
 *   · 能自己派生出资源 key，解开任意 blob
 *   · 整个销售线当场报废，且不可挽回（已发出去的卡密没法统一作废）
 *
 * ── 现在的做法 ──
 *
 * 1. 密钥材料**不以可读形态存在**：32 字节材料用逐字节掩码 + 位置置换打散，
 *    单独看既不是 salt、也不是密钥，必须先跑完还原流程。
 * 2. 真正的 SECRET 是 **AES-256-GCM 密文**，密钥由 scrypt（N=16384）派生。
 *    要拿到明文，必须：
 *       a. 还原被置换/掩码的材料
 *       b. 按正确顺序切出 salt / info 两段
 *       c. 用 scrypt 派生 32 字节 key（参数必须完全一致）
 *       d. 用 GCM 解密并校验 tag（改一个字节就失败）
 * 3. 解出来后做**摘要自检**：不匹配就抛错，绝不回退到默认值
 *    （回退默认值是这类代码最常见的自毁方式——一旦回退，攻击者只要暴力改坏
 *      材料就能拿到一个"已知"的密钥）。
 *
 * ── 诚实的边界 ──
 *
 * 只要客户端本地校验，SECRET 最终必然出现在进程内存里，理论上一定能被
 * 内存 dump 拿到。本文件的目标**不是不可破**，而是：
 *   · 让「strings 一下就有」变成「必须先读懂整套还原流程」
 *   · 让顺手复制一段 XOR 表去自己造卡密的人彻底断念
 *   · 把 SECRET 的复用面收窄到一处（license.mjs / keygen.mjs 都从这里取）
 *
 * 真正的强度提升在 gate.mjs：即使有人 dump 出 SECRET，也要面对
 * 「每个功能自己验权、验权失败就少料」的多点结构，而不是一个 if。
 *
 * ═══════════════════════════════════════════════════════════════
 */

import crypto from 'node:crypto';

// ───────────────────── 打散存放的密钥材料 ─────────────────────
// 32 字节 = salt(16) + info(16)，先按 MASK 掩码，再按 PERM 置换位置。
// 这两步都可逆，但**单独看这段数组得不到任何可用信息**。
const MASK = 0xb7;

/** 掩码后的材料（已置换）。还原 = reverse(PERM) → ^(MASK ^ (i*37+11)) */
const SCRAMBLED = [
  0x86, 0xb9, 0xe7, 0xe8, 0x00, 0xaa, 0x6e, 0x61,
  0xd2, 0x48, 0x73, 0x5d, 0xeb, 0x2f, 0x3d, 0x77,
  0x6a, 0x4b, 0xb1, 0xe2, 0x40, 0xd9, 0x50, 0x8a,
  0x72, 0xb9, 0x3d, 0x0c, 0x5c, 0xa0, 0xbe, 0xb2,
];

/** 位置置换表：PERM[置换后下标] = 原始下标。长度 32 的定值排列。 */
const PERM = [
  17, 3, 28, 9, 0, 22, 11, 31,
  6, 24, 14, 2, 19, 30, 8, 21,
  12, 27, 5, 16, 25, 1, 20, 10,
  29, 7, 23, 4, 15, 26, 13, 18,
];

const IV = Buffer.from('nPZaCy3ePP752jj9', 'base64');
const CT = Buffer.from('j/izndklij71fX4RgYfgdaTHtBH6MM6lcWGZ8WT41Bk=', 'base64');
const TAG = Buffer.from('QQAv655MCuXvZsqR6mVbbA==', 'base64');

/** sha1(SECRET) 前 8 位十六进制 —— 解开后自检，不匹配立即失败 */
const DIGEST = '3187f764';

// crypto[CD] 而不是 crypto.createDecipheriv：后者是裸标识符，minify 后仍是明文字面量。
// 数组 join 不会被常量折叠，二进制里查不到 'createDecipheriv'。
const CD = ['create', 'Decipheriv'].join('');

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };

let _cached = null;
let _failed = null;

/** 还原被打散的材料 → 32 字节 */
function material() {
  const raw = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) {
    const pos = PERM[i];
    raw[pos] = (SCRAMBLED[i] ^ MASK ^ ((i * 37 + 11) & 0xff)) & 0xff;
  }
  return raw;
}

/**
 * 取 SECRET。
 *
 * 失败时**抛错**而不是返回默认值 —— 让"改坏材料"变成程序直接不能用，
 * 而不是"改坏材料就得到一个已知密钥"。
 *
 * @returns {string} 32 位十六进制字符串
 */
export function SECRET() {
  if (_cached !== null) return _cached;
  if (_failed) throw _failed;

  try {
    const mat = material();
    const salt = mat.subarray(0, 16);
    const key = crypto.scryptSync(mat, salt, 32, SCRYPT);

    const d = crypto[CD]('aes-256-gcm', key, IV);
    d.setAuthTag(TAG);
    const plain = Buffer.concat([d.update(CT), d.final()]).toString('utf-8');

    const got = crypto.createHash('sha1').update(plain, 'utf-8').digest('hex').slice(0, 8);
    if (got !== DIGEST) throw new Error('secret integrity mismatch');

    if (!plain) throw new Error('secret empty');
    _cached = plain;
    return _cached;
  } catch (e) {
    _failed = new Error('授权密钥不可用（构建异常，请联系开发者）');
    _failed.cause = e;
    throw _failed;
  }
}

/** HMAC-SHA256(key=SECRET) —— 卡密签名与资源派生共用 */
export function hmac(data) {
  return crypto.createHmac('sha256', SECRET()).update(data, 'utf-8');
}

/** 自检：解不出或摘要不符返回 { ok:false }，绝不抛给调用方 */
export function assertIntegrity() {
  try {
    const s = SECRET();
    const got = crypto.createHash('sha1').update(s, 'utf-8').digest('hex').slice(0, 8);
    return { ok: got === DIGEST, len: s.length, digest: got };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}
