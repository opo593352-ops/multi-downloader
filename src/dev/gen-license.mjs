#!/usr/bin/env node
/**
 * gen-license.mjs — 卡密生成器（仅供开发者使用，不要随发布包分发）
 *
 * 用法：
 *   node gen-license.mjs machine <机器码>        生成绑定某台机器的卡密
 *   node gen-license.mjs machine <机器码> -n 5   批量生成 5 个
 *   node gen-license.mjs universal              生成不绑定的万能码
 *   node gen-license.mjs verify <卡密>          校验一个卡密属于哪台机器
 *   node gen-license.mjs self                   打印本机机器码
 *   node gen-license.mjs mine                   查看本机激活状态
 *   node gen-license.mjs reset                  清除本机激活（测试用）
 *   node gen-license.mjs seal                   生成加密的功能配置 blob
 *
 * 注意：本脚本与 license.mjs 共用 SEGS/SECRET，
 * 所以**只能自己留着**，绝不能放进发布包。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as lic from './license.mjs';

const TIER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const args = process.argv.slice(2);
const cmd = args[0];

function out(s = '') { console.log(s); }

function batch(bindTo, n) {
  const list = [];
  for (let i = 0; i < n; i++) list.push(lic.generateKey(bindTo));
  return list;
}

function printKeys(keys, bindTo) {
  out('');
  out('┌─────────────────────────────────────────────────────┐');
  out('│  卡密                                                │');
  out('└─────────────────────────────────────────────────────┘');
  out('');
  out('  绑定机器码: ' + (bindTo || '（不绑定，万能码）'));
  out('');
  keys.forEach((k, i) => {
    out(`  ${String(i + 1).padStart(2, ' ')}. ${k}`);
  });
  out('');
  out('  提示: 每个码只能用在一台机器；换机器需重新生成。');
  out('');
}

switch (cmd) {
  case 'machine': {
    const target = args[1];
    if (!target) { out('用法: gen-license.mjs machine <机器码> [-n 数量]'); process.exit(1); }
    const ni = args.indexOf('-n');
    const n = ni >= 0 ? Math.max(1, parseInt(args[ni + 1], 10) || 1) : 1;
    const keys = batch(target.toUpperCase(), n);
    printKeys(keys, target.toUpperCase());
    break;
  }

  case 'universal': {
    const ni = args.indexOf('-n');
    const n = ni >= 0 ? Math.max(1, parseInt(args[ni + 1], 10) || 1) : 1;
    const keys = batch('XXXXX', n);
    printKeys(keys, null);
    out('  ⚠ 万能码可被任意转发，正式销售不要用。仅用于自己测试。');
    out('');
    break;
  }

  case 'verify': {
    const code = args[1];
    if (!code) { out('用法: gen-license.mjs verify <卡密>'); process.exit(1); }
    const v = lic.verifyKey(code);
    out('');
    out('  卡密: ' + code);
    out('  结果: ' + (v.ok ? '✅ 有效' : '❌ 无效'));
    if (!v.ok) {
      const map = {
        length: '长度不对（应为 19 位字母数字，形如 XXXXX-XXXXX-XXXXX-XXXX）',
        signature: '签名校验失败（卡密被改动，或不是本工具生成的）',
        machine: '机器码不匹配（这个码是给别的机器生成的）',
      };
      out('  原因: ' + (map[v.reason] || v.reason));
      if (v.bind) out('  该码绑定: ' + v.bind);
      if (v.machine) out('  本机机器码: ' + v.machine);
    } else {
      out('  绑定: ' + (v.bind === 'XXXXX' ? '不绑定（万能码）' : v.bind));
    }
    out('');
    break;
  }

  case 'self': {
    out('');
    out('  本机机器码: ' + lic.machineCode());
    out('');
    out('  把这个码发给卖家，让他生成绑定你这台机器的卡密。');
    out('');
    break;
  }

  case 'mine': {
    const st = lic.status();
    out('');
    out('  本机机器码: ' + st.machine);
    out('  激活状态  : ' + (st.activated ? '✅ 已激活' : '❌ 未激活'));
    if (st.activated) {
      out('  卡密      : ' + st.code);
      out('  激活时间  : ' + st.savedAt);
    } else {
      out('  原因      : ' + st.reason);
      out('  存储位置  : ' + lic.licensePath());
    }
    out('');
    break;
  }

  case 'reset': {
    lic.clearLicense();
    out('  已清除本机激活记录: ' + lic.licensePath());
    break;
  }

  case 'issue': {
    // ★ 正式发卡命令：一张卡 → 一整串激活码（卡密 + 该卡专属 blob）
    //
    //   node gen-license.mjs issue <机器码> [-n 数量]
    //
    // 输出可直接复制发给用户，用户粘贴一次即可激活。
    const bindTo = args[1];
    if (!bindTo) { out('用法: gen-license.mjs issue <机器码> [-n 数量]'); process.exit(1); }
    const ni = args.indexOf('-n');
    const n = ni >= 0 ? Math.max(1, parseInt(args[ni + 1], 10) || 1) : 1;

    const res = {
      v: 1,
      mirrors: {
        bilibili: [
          'upos-sz-mirrorcos.bilivideo.com',
          'upos-sz-mirrorali.bilivideo.com',
          'upos-sz-mirrorhw.bilivideo.com',
          'upos-sz-mirror08c.bilivideo.com',
        ],
      },
      api: { retry: 3, uaProfile: 'chrome131' },
    };

    out('');
    out('┌────────────────────────────────────────────────────────────┐');
    out('│  激活码（复制整串发给用户，粘贴一次即可）                    │');
    out('└────────────────────────────────────────────────────────────┘');
    out('');

    for (let i = 0; i < n; i++) {
      const code = lic.generateKey(bindTo.toUpperCase());
      const key = lic.deriveResourceKey(code);
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([c.update(JSON.stringify(res), 'utf-8'), c.final()]);
      const blob = { d: enc.toString('base64'), i: iv.toString('base64'), t: c.getAuthTag().toString('base64') };

      const activation = Buffer.from(JSON.stringify({ k: code, ...blob }), 'utf-8').toString('base64');

      out(`  【第 ${i + 1} 张】机器码 ${bindTo.toUpperCase()}`);
      out(`  卡密   : ${code}`);
      out(`  激活码 : ${activation}`);
      out(`  长度   : ${activation.length} 字符`);
      out('');
    }
    out('  提示: 激活码含该机器专属的加密资源，换机器需重新签发。');
    out('');
    break;
  }

  case 'sigtest': {
    const code = args[1] || lic.generateKey('XXXXX');
    const sig4 = code.replace(/-/g, '').slice(15, 19);
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const a = A.indexOf(sig4[0]);
    const b = A.indexOf(sig4[2]);
    out('');
    out('  卡密: ' + code);
    out('  sig4: ' + sig4);
    out('  桶  : ' + ((Math.max(0,a) * 7 + Math.max(0,b) * 3) % 16));
    out('');
    break;
  }

  default:
    out(`
卡密生成器（开发者工具，勿随包分发）

  machine <机器码> [-n N]   生成绑定该机器的卡密
  universal [-n N]          生成不绑定的万能码（仅测试）
  verify <卡密>             校验卡密
  self                      打印本机机器码
  mine                      查看本机激活状态
  reset                     清除本机激活
  sealwith <卡密>            生成加密功能配置 blob

示例:
  node gen-license.mjs self
  node gen-license.mjs machine 25C2B
  node gen-license.mjs machine 25C2B -n 5
  node gen-license.mjs verify G6ZWC-9UP5L-25C2B-02FB
`);
}
