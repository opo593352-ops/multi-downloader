/**
 * browser.mjs — 统一浏览器定位
 *
 * 为什么单独抽出来：
 *   抖音 / 知乎 / 网页抓取三个模块都要找 Chrome/Edge，
 *   原来每个文件各抄一份候选路径，改一处漏两处。
 *
 * 找什么：
 *   只需要 **Chromium 内核**（Chrome / Edge / Brave / Chromium），
 *   因为要用 CDP（Chrome DevTools Protocol）。Firefox 不支持，直接排除。
 *
 * 查找顺序（从最可靠到最兜底）：
 *   1. 环境变量 DSH_DL_BROWSER（用户显式指定，优先级最高）
 *   2. 注册表 StartMenuInternet（系统认过的浏览器，路径一定对）
 *   3. 常见安装路径（覆盖 Program Files / x86 / 用户目录 / 便携版）
 *   4. PATH 里的 chrome / msedge
 *   5. 全盘扫 App Paths 注册项
 *
 * 找不到时的态度：
 *   **明确告诉用户装什么、装哪个版本、装完放哪**，
 *   而不是抛一个 ENOENT 让人去猜。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

/** 已知的 Chromium 内核浏览器，按优先级排 */
const KNOWN = [
  {
    name: 'Chrome',
    exe: 'chrome.exe',
    paths: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ],
  },
  {
    name: 'Edge',
    exe: 'msedge.exe',
    paths: [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ],
  },
  {
    name: 'Brave',
    exe: 'brave.exe',
    paths: [
      'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    ],
  },
  {
    name: 'Chromium',
    exe: 'chromium.exe',
    paths: [
      'C:\\Program Files\\Chromium\\Application\\chrome.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Chromium\\Application\\chrome.exe'),
    ],
  },
];

function exists(p) {
  if (!p) return false;
  try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; }
}

/**
 * 从注册表读系统登记的浏览器路径。
 * 这条最可靠 —— 用户能正常上网就说明这里一定有值。
 */
function fromRegistry() {
  const out = [];
  const roots = [
    'HKLM\\SOFTWARE\\Clients\\StartMenuInternet',
    'HKLM\\SOFTWARE\\WOW6432Node\\Clients\\StartMenuInternet',
    'HKCU\\SOFTWARE\\Clients\\StartMenuInternet',
  ];

  for (const root of roots) {
    let names = [];
    try {
      const raw = execSync(`reg query "${root}"`, {
        encoding: 'utf-8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
      });
      names = raw.split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => {
          // 只要子键行：以 HKEY 开头，且比根键更深一层
          if (!l.startsWith('HKEY')) return false;
          if (l === root || l === root.replace(/\\/g, '\\')) return false;
          const depth = (l.match(/\\/g) || []).length;
          const rootDepth = (root.match(/\\/g) || []).length;
          return depth === rootDepth + 1;
        })
        .map((l) => l.slice(l.lastIndexOf('\\') + 1));
    } catch { continue; }

    for (const n of names) {
      // 只要 Chromium 内核（Firefox 不支持 CDP）
      if (/firefox|opera|vivaldi|waterfox|librewolf/i.test(n)) continue;
      try {
        const raw = execSync(`reg query "${root}\\${n}\\shell\\open\\command" /ve`, {
          encoding: 'utf-8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
        });
        const m = raw.match(/"([^"]+\.exe)"/);
        if (m && exists(m[1])) out.push({ name: n, path: m[1], from: 'registry' });
      } catch {}
    }
  }
  return out;
}

/** 从 App Paths 读（有些绿色安装只登记在这里） */
function fromAppPaths() {
  const out = [];
  const keys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
  ];
  for (const k of keys) {
    try {
      const raw = execSync(`reg query "${k}" /ve`, {
        encoding: 'utf-8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
      });
      const m = raw.match(/"([^"]+\.exe)"/) || raw.match(/([A-Za-z]:\\[^\r\n]+\.exe)/);
      if (m && exists(m[1])) out.push({ name: path.basename(m[1]), path: m[1], from: 'app-paths' });
    } catch {}
  }
  return out;
}

/**
 * 找可用的 Chromium 浏览器。
 * @param {object} opts { prefer: 'chrome'|'edge'|null, explicit: string }
 * @returns {{ok:true, path:string, name:string, from:string} | {ok:false, reason:string, tried:string[]}}
 */
export function findBrowser(opts = {}) {
  const tried = [];

  // 1. 显式指定
  const explicit = opts.explicit || process.env.DSH_DL_BROWSER || '';
  if (explicit) {
    tried.push(explicit);
    if (exists(explicit)) {
      return { ok: true, path: explicit, name: path.basename(explicit), from: 'explicit' };
    }
    // 显式指定了但不存在 —— 直接报错，不要偷偷换别的
    return {
      ok: false,
      reason: `指定的浏览器不存在: ${explicit}`,
      tried,
    };
  }

  // 2. 注册表
  for (const r of fromRegistry()) {
    tried.push(r.path);
    return { ok: true, path: r.path, name: r.name, from: r.from };
  }

  // 3. 常见路径
  const order = opts.prefer === 'edge'
    ? [KNOWN[1], KNOWN[0], KNOWN[2], KNOWN[3]]
    : KNOWN;

  for (const b of order) {
    for (const p of b.paths) {
      tried.push(p);
      if (exists(p)) {
        return { ok: true, path: p, name: b.name, from: 'path' };
      }
    }
  }

  // 4. App Paths
  for (const r of fromAppPaths()) {
    tried.push(r.path);
    return { ok: true, path: r.path, name: r.name, from: r.from };
  }

  return {
    ok: false,
    reason: '没找到 Chromium 内核浏览器',
    tried: [...new Set(tried)],
  };
}

/**
 * 找不到浏览器时给用户看的话。
 * 必须写清楚"装什么"和"装完要不要重启"，否则用户会来问。
 */
export function browserHelpText(r) {
  const lines = [
    '',
    '╔═══════════════════════════════════════════════════════╗',
    '║            缺少浏览器，无法执行此功能                 ║',
    '╚═══════════════════════════════════════════════════════╝',
    '',
    '  抖音 / 知乎 / 网页抓取 这三个功能需要 Chromium 内核的浏览器。',
    '',
    '  推荐做法（二选一，都不用重启电脑）：',
    '    1) 装 Google Chrome：https://www.google.cn/chrome/',
    '    2) 用 Windows 自带的 Edge（Win10/11 都有，一般不用装）',
    '',
    '  装好后重新运行本程序即可，无需额外配置。',
    '',
    '  如果浏览器装在非常规位置，可以手动指定：',
    '    set DSH_DL_BROWSER=D:\\你的路径\\chrome.exe',
    '    或者命令行加参数：--chrome "D:\\你的路径\\chrome.exe"',
    '',
  ];

  if (r && r.reason) lines.push('  诊断: ' + r.reason);
  if (r && r.tried && r.tried.length) {
    lines.push('  已尝试以下路径（都不存在）:');
    for (const t of r.tried.slice(0, 8)) lines.push('    ' + t);
    if (r.tried.length > 8) lines.push(`    …还有 ${r.tried.length - 8} 个`);
  }
  lines.push('');
  return lines.join('\n');
}
