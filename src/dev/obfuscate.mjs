#!/usr/bin/env node
/**
 * obfuscate.mjs — 构建后处理：把敏感字符串改成运行时解密
 *
 * ═══════════════════════════════════════════════════════════════
 * v1.0.1 重写说明
 * ═══════════════════════════════════════════════════════════════
 *
 * 旧实现（v1.0.0）：
 *
 *   var __dsKey = (function(){ var k = [0x5c]; return k[0]; })();
 *   function __ds(b) {
 *     var buf = Buffer.from(b, 'base64');
 *     for (var i = 0; i < buf.length; i++) buf[i] ^= __dsKey ^ ((i*13+7)&0xff);
 *     return buf.toString('utf-8');
 *   }
 *
 * 问题：**密钥和算法都在明面上**。看到 __ds('...') 随手写个循环就能把
 * 30 个敏感串（镜像域名、上报邮箱、接口路径）全部还原。等于没混淆。
 *
 * 现在：AES-256-GCM。
 *   · 内容密钥由构建期随机生成，只以**打散数字**形式存在
 *   · 每段密文自带 iv + tag，改一个字节解不开
 *   · 解密函数本身不含任何常量密钥，必须按顺序执行材料还原
 *
 * 诚实的边界：本地解密的东西一定能被解出来（跑一遍就有明文）。
 * 目标是"不能一次性批量 dump"，不是"不可破"。真正的机密
 * （SECRET）走的是 dev/secret.mjs 的另一条路径。
 *
 * 顺带修掉的空转项：
 *   'createDecipheriv' / 'createCipheriv' 在旧表里永远不命中 ——
 *   它们是 `crypto.createDecipheriv(...)` 这种**标识符调用**，
 *   不是引号包裹的字面量，正则 `(['"])createDecipheriv\1` 匹配不到。
 *   现在源码侧统一写成 crypto['create' + 'Decipheriv']，本脚本
 *   会命中拼接后的完整串；如果哪天又变回裸标识符，会打印警告而不是静默跳过。
 *
 * 用法：node obfuscate.mjs <input.cjs> <output.cjs>
 */

import fs from 'node:fs';
import crypto from 'node:crypto';

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error('用法: node obfuscate.mjs <input> <output>');
  process.exit(1);
}

let src = fs.readFileSync(inPath, 'utf-8');

/**
 * 要藏起来的字符串。
 * 只挑"看一眼就知道怎么做"的，不去动普通文案（那会让文件变怪且容易出错）。
 */
const SENSITIVE = [
  // 镜像域名（卡密保护的核心）
  'upos-sz-mirrorcos.bilivideo.com',
  'upos-sz-mirrorali.bilivideo.com',
  'upos-sz-mirrorhw.bilivideo.com',
  'upos-sz-mirror08c.bilivideo.com',
  // 裸前缀也要藏：源码里拆成 ['upos-sz-mirror','cos.bili','video.com']，
  // 只藏完整域名的话，二进制里仍留着 'upos-sz-mirror' 这种半截线索
  'upos-sz-mirror',
  'mountaintoys',
  'bilivideo',
  // 技术栈线索
  'yt_dlp',
  'yt-dlp',
  'CDP timeout',
  'Network.getAllCookies',
  'Page.addScriptToEvaluateOnNewDocument',
  'Runtime.evaluate',
  'Target.attachToTarget',
  // 加解密 API 名（源码里写成 crypto['create' + 'Decipheriv']，
  // esbuild 折叠后变回完整字面量，这里才命中得到）
  'createDecipheriv',
  'createCipheriv',
  'a_bogus',
  'scramble_id',
  // 站点特征
  'aweme/v1/web/aweme/detail',
  'antiserver.kuwo.cn',
  'u.y.qq.com',
  'music.163.com',
  // 内部命名
  'DSH_DL_SELFTEST',
  'DSH_DL_DEV',
  // 资源派生前缀（改它等于换了整套 blob 格式，必须藏）
  'res|v1|',
  'feat|v1|',
  // 开发者身份 / 上报通道
  'sjsjdj173@163.com',
  'smtp.163.com',
];

// ───────────────────── 内容密钥（构建期随机，打散存放） ─────────────────────
const KEY = crypto.randomBytes(32);

/** 把 32 字节密钥打散成 8 个「看起来像无关常量」的数字 */
function scatter(key) {
  const words = [];
  for (let i = 0; i < key.length; i += 4) {
    const w = key.readUInt32LE(i);
    // 与一个固定但非零的掩码异或，避免出现整齐的 0x00000000
    words.push((w ^ 0x9e3779b9) >>> 0);
  }
  // 顺序也打乱（定值排列），单看数组得不到连续密钥
  const perm = [3, 0, 6, 1, 7, 4, 2, 5];
  return perm.map((i) => words[i]);
}

function unpermute(scattered) {
  const perm = [3, 0, 6, 1, 7, 4, 2, 5];
  const words = new Array(8);
  for (let i = 0; i < perm.length; i++) words[perm[i]] = scattered[i];
  const buf = Buffer.alloc(32);
  for (let i = 0; i < 8; i++) buf.writeUInt32LE((words[i] ^ 0x9e3779b9) >>> 0, i * 4);
  return buf;
}

/** 加密一个字符串 → base64(iv|tag|ct) */
function enc(s) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(s, 'utf-8'), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

const scatteredKey = scatter(KEY);
// 自检：上面的打散必须可逆，否则整个 bundle 解不开
if (!unpermute(scatteredKey).equals(KEY)) {
  console.error('FATAL: 密钥打散/还原自检失败，已中止（不写半成品）');
  process.exit(1);
}

/**
 * 解密函数，注入到 bundle 顶部。
 * 注意两点：
 *   1. 这里**没有**任何常量密钥 —— 材料在 __dsK 里打散，按 perm 还原。
 *   2. API 名用下标访问（__c[C1]），不写裸的 createDecipheriv ——
 *      否则这个 helper 自己就把明文名字带进二进制，混淆等于白做。
 */
const HELPER = `
var __dsK=(function(){var s=[${scatteredKey.map((n) => n >>> 0).join(',')}],p=[3,0,6,1,7,4,2,5],w=new Array(8),i=0;for(;i<8;i++)w[p[i]]=s[i];var b=Buffer.alloc(32);for(i=0;i<8;i++)b.writeUInt32LE((w[i]^0x9e3779b9)>>>0,i*4);return b;})();
var __dsC=require('node:crypto'),__dsM=['create','Decipheriv'].join('');
function __ds(b){
  var raw=Buffer.from(b,'base64');
  var iv=raw.subarray(0,12),tag=raw.subarray(12,28),ct=raw.subarray(28);
  var d=__dsC[__dsM]('aes-256-gcm',__dsK,iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct),d.final()]).toString('utf-8');
}
`;

let replaced = 0;
const report = [];
const warnings = [];

// 按长度倒序处理，避免短串先替换破坏长串
const sorted = [...SENSITIVE].sort((a, b) => b.length - a.length);

function replaceQuoted(input, s, note) {
  const esc = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hits = [];
  for (const q of ["'", '"', '`']) {
    const re = new RegExp(`${q}${esc}${q}`, 'g');
    const n = (input.match(re) || []).length;
    if (n) {
      input = input.replace(re, () => `__ds('${enc(s)}')`);
      hits.push(q + '×' + n);
    }
  }
  if (hits.length) {
    replaced++;
    report.push(`  ${s.slice(0, 40).padEnd(42)} ${note || ''}${hits.join(' ')}`);
  }
  return input;
}

for (const s of sorted) src = replaceQuoted(src, s);

// ── 兜底扫描 ──
// esbuild 的常量折叠会把 'a'+'b' 变回 'ab'，所以对最终产物再扫一遍。
// 只替换"被引号完整包裹"的字面量，避免破坏正则/标识符。
function sweepSensitive(text) {
  let out = text;
  let hits = 0;
  for (const s of sorted) {
    for (const q of ["'", '"', '`']) {
      const needle = q + s + q;
      if (out.includes(needle)) {
        const n = out.split(needle).length - 1;
        out = out.split(needle).join("__ds('" + enc(s) + "')");
        hits += n;
      }
    }
  }
  return { out, hits };
}

const sw = sweepSensitive(src);
src = sw.out;
if (sw.hits) report.push(`  兜底扫描替换 ${sw.hits} 处`);

// ── 空转检查 ──
// 标识符形态（crypto.createDecipheriv）不是字符串字面量，替换逻辑命中不了。
// 以前是静默失败 —— 现在明确警告，逼着源码侧改成拼接写法。
const IDENT_ONLY = ['createDecipheriv', 'createCipheriv'];
for (const id of IDENT_ONLY) {
  const asLiteral = src.includes(`'${id}'`) || src.includes(`"${id}"`);
  const asIdentifier = new RegExp(`[.\\s(]${id}\\s*\\(`).test(src);
  if (asIdentifier && !asLiteral) {
    warnings.push(
      `  ⚠ ${id} 仍以裸标识符出现（crypto.${id}(...)），本脚本无法混淆。\n` +
      `     源码侧请改成 crypto['create' + 'Decipheriv'](...) 后再跑。`
    );
  }
}

// ── 注入 helper ──
// 关键：shebang（#!/usr/bin/env node）必须在第 1 行，不能被挤走；
// 'use strict' 也要保持在文件最前面（它是指令序言，位置有语义）。
if (replaced > 0 || sw.hits) {
  let shebang = '';
  const sbMatch = src.match(/^#![^\n]*\n/);
  if (sbMatch) {
    shebang = sbMatch[0];
    src = src.slice(shebang.length);
  }

  const strictMatch = src.match(/^(['"])use strict\1;?/);
  if (strictMatch) {
    const idx = strictMatch[0].length;
    src = src.slice(0, idx) + '\n' + HELPER + '\n' + src.slice(idx);
  } else {
    src = HELPER + '\n' + src;
  }

  src = shebang + src;
}

fs.writeFileSync(outPath, src, 'utf-8');

console.log('');
console.log('  字符串混淆完成（AES-256-GCM）');
console.log('  替换条目: ' + replaced);
for (const r of report.slice(0, 30)) console.log(r);
if (warnings.length) {
  console.log('');
  for (const w of warnings) console.log(w);
}
console.log('');
