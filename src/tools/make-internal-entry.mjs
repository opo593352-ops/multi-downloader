#!/usr/bin/env node
/**
 * make-internal-entry.mjs — 生成免卡密入口
 *
 * 为什么不直接在 .cmd 里用 node -e：
 *   cmd 会把单引号、括号、中文注释吞掉，导致语法错误。
 *   写成独立脚本文件最稳。
 *
 * 做的事：把 cli.mjs 里的 `const BUILD_INTERNAL = false;`
 * 换成 `true`，输出到 build/cli-internal.mjs。
 *
 * 注意：只改这一行。其余代码完全一致，保证测试版和正式版行为相同。
 */

import fs from 'node:fs';
import path from 'node:path';

const src = path.join(process.cwd(), 'cli.mjs');
const outDir = path.join(process.cwd(), 'build');
// 必须输出到 src 根目录：cli.mjs 里全是 './xxx.mjs' 相对导入，
// 放到 build/ 子目录下 esbuild 会找不到。
const out = path.join(process.cwd(), '_cli-internal.mjs');

if (!fs.existsSync(src)) {
  console.error('找不到 cli.mjs，请在 src 目录下运行');
  process.exit(1);
}

let code = fs.readFileSync(src, 'utf-8');

// 精确匹配那一行（含注释），只替换 false → true
const pattern = /const BUILD_INTERNAL = false;/;
if (!pattern.test(code)) {
  console.error('FATAL: cli.mjs 里找不到 "const BUILD_INTERNAL = false;"');
  console.error('      可能被改过，请检查激活闸门那段代码');
  process.exit(1);
}

const count = (code.match(/const BUILD_INTERNAL = false;/g) || []).length;
if (count !== 1) {
  console.error(`FATAL: 找到 ${count} 处标记，预期 1 处`);
  process.exit(1);
}

code = code.replace(pattern, 'const BUILD_INTERNAL = true;');

// 顺手把版本号加个后缀，避免和正式版混淆
code = code.replace(/const VERSION = '([\d.]+)';/, "const VERSION = '$1-internal';");

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(out, code, 'utf-8');

console.log('  已生成 _cli-internal.mjs（临时文件，构建后删除）');
console.log('  BUILD_INTERNAL: false -> true');
console.log('  VERSION 加 -internal 后缀');
