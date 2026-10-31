/**
 * 取依赖.mjs — 自动下载 ffmpeg / yt-dlp 到 src/
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么需要这个脚本
 * ═══════════════════════════════════════════════════════════════
 *
 * ffmpeg（84MB）和 yt-dlp（22MB）是二进制，不该进 git 仓库：
 *   · 会让 clone 变得极慢
 *   · GitHub 单文件上限 100MB，ffmpeg 接近红线
 *   · 每次升级都要重新提交 106MB，历史迅速膨胀
 *
 * 但开发者本地又确实需要它们（站点视频缺了就不工作）。
 * 所以：`.gitignore` 排除 *.exe，新克隆的人跑一次这个脚本。
 *
 * ═══════════════════════════════════════════════════════════════
 * 用法
 * ═══════════════════════════════════════════════════════════════
 *
 *   node tools/取依赖.mjs            # 缺什么补什么
 *   node tools/取依赖.mjs --force    # 全部重下
 *   node tools/取依赖.mjs --check    # 只检查，不下载
 *
 * 下载到 src/ 根目录（和引擎同级，引擎会自动找到）。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));   // <root>/tools
const SRC = path.resolve(HERE, '..', 'src');                 // <root>/src

const TARGETS = [
  {
    name: 'ffmpeg.exe',
    // gyan.dev 的 essentials build：体积适中，编码器够用
    url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
    // 是 zip，要解压后从 bin/ 里取
    fromZip: 'ffmpeg-*/bin/ffmpeg.exe',
    size: 87_000_000,
    probe: ['-version'],
    probeRe: /ffmpeg version/i,
    note: '音视频合并。站点视频必需。',
  },
  {
    name: 'yt-dlp.exe',
    url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
    size: 23_000_000,
    probe: ['--version'],
    probeRe: /^\d{4}\.\d{2}\.\d{2}/,
    note: '站点解析引擎。站点视频必需。',
  },
];

const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const CHECK_ONLY = argv.includes('--check');

const log = (...a) => console.log(...a);
const warn = (...a) => console.error('[warn]', ...a);

function fmtSize(b) {
  if (b > 1024 ** 2) return (b / 1024 ** 2).toFixed(1) + ' MB';
  if (b > 1024) return (b / 1024).toFixed(0) + ' KB';
  return b + ' B';
}

/** 跑一下 exe，确认真的能用（不是 0 字节的空壳） */
async function probe(exe, args, re) {
  const { spawnSync } = await import('node:child_process');
  try {
    const r = spawnSync(exe, args, {
      encoding: 'utf-8', timeout: 20000, windowsHide: true,
    });
    const out = String(r.stdout || '') + String(r.stderr || '');
    return r.status === 0 && re.test(out);
  } catch { return false; }
}

/** 带进度地下载一个 URL */
async function fetchTo(url, dest, label) {
  log(`  下载 ${label} …`);
  log(`    ${url}`);

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
        + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const total = Number(res.headers.get('content-length') || 0);
  const part = dest + '.part';
  try { fs.unlinkSync(part); } catch {}

  const file = fs.createWriteStream(part);
  let got = 0;
  let lastTick = 0;

  // 空闲检测：和 dev/dl.mjs 一个道理，卡住要能发现
  let lastByteAt = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - lastByteAt > 60_000) {
      try { file.destroy(); } catch {}
    }
  }, 5000);
  watchdog.unref?.();

  try {
    for await (const chunk of res.body) {
      got += chunk.length;
      lastByteAt = Date.now();
      if (!file.write(chunk)) await new Promise((r) => file.once('drain', r));
      const now = Date.now();
      if (total && now - lastTick > 400) {
        lastTick = now;
        process.stderr.write(
          `\r    ${((got / total) * 100).toFixed(0)}%  ${fmtSize(got)}/${fmtSize(total)}   `
        );
      }
    }
  } finally {
    clearInterval(watchdog);
    await new Promise((r) => file.end(r));
  }
  process.stderr.write('\n');

  if (total && got !== total) {
    try { fs.unlinkSync(part); } catch {}
    throw new Error(`下载不完整 ${fmtSize(got)}/${fmtSize(total)}`);
  }

  await fsp.rename(part, dest);
  return got;
}

/** 解 zip 取出某个文件（不引入第三方依赖，用系统 tar） */
async function extractFromZip(zipPath, pattern, outPath) {
  const { spawnSync } = await import('node:child_process');
  const tmpDir = path.join(path.dirname(zipPath), '_unzip_tmp');
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });

  // Windows 10+ 自带 bsdtar，能解 zip
  const r = spawnSync('tar', ['-xf', zipPath, '-C', tmpDir], {
    encoding: 'utf-8', windowsHide: true, timeout: 180000,
  });
  if (r.status !== 0) {
    throw new Error(`解压失败: ${r.stderr || r.status}\n  手动解压 ${zipPath} 后把 bin/ffmpeg.exe 放到 src/`);
  }

  // 找匹配的文件
  const findFile = (dir, re) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        const found = findFile(p, re);
        if (found) return found;
      } else if (re.test(e.name)) {
        return p;
      }
    }
    return null;
  };

  const re = new RegExp(pattern.replace('*', '.*').split('/').pop() + '$', 'i');
  const found = findFile(tmpDir, re);
  if (!found) {
    await fsp.rm(tmpDir, { recursive: true, force: true });
    throw new Error(`zip 里没找到 ${pattern}`);
  }

  await fsp.copyFile(found, outPath);
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.rm(zipPath, { force: true });
}

async function handle(t) {
  const dest = path.join(SRC, t.name);

  // 已存在且能用 → 跳过
  if (!FORCE && fs.existsSync(dest)) {
    const ok = await probe(dest, t.probe, t.probeRe);
    if (ok) {
      const sz = fs.statSync(dest).size;
      log(`  ✓ ${t.name.padEnd(12)} 已存在且可用  ${fmtSize(sz)}`);
      return 'ok';
    }
    log(`  ! ${t.name.padEnd(12)} 已存在但跑不起来，重下`);
    try { fs.unlinkSync(dest); } catch {}
  }

  if (CHECK_ONLY) {
    log(`  ✗ ${t.name.padEnd(12)} 缺失  —— ${t.note}`);
    return 'missing';
  }

  log(`  ↓ ${t.name.padEnd(12)} ${t.note}`);

  if (t.fromZip) {
    const zipPath = path.join(SRC, '_dl_' + t.name + '.zip');
    await fetchTo(t.url, zipPath, t.name + '（zip）');
    await extractFromZip(zipPath, t.fromZip, dest);
  } else {
    await fetchTo(t.url, dest, t.name);
  }

  const sz = fs.statSync(dest).size;
  const ok = await probe(dest, t.probe, t.probeRe);
  if (!ok) {
    log(`  ✗ ${t.name} 下载了但跑不起来（${fmtSize(sz)}）`);
    return 'fail';
  }
  log(`  ✓ ${t.name.padEnd(12)} ${fmtSize(sz)}  可用`);
  return 'ok';
}

async function main() {
  log('');
  log('═══════════════════════════════════════════════');
  log('  取依赖（ffmpeg / yt-dlp）');
  log('═══════════════════════════════════════════════');
  log(`  目标目录: ${SRC}`);
  log('');

  if (CHECK_ONLY) log('  （只检查，不下载）\n');

  const results = [];
  for (const t of TARGETS) {
    try {
      results.push([t.name, await handle(t)]);
    } catch (e) {
      log(`  ✗ ${t.name}: ${e.message}`);
      results.push([t.name, 'fail']);
    }
    log('');
  }

  const missing = results.filter(([, r]) => r !== 'ok');
  if (missing.length === 0) {
    log('═══════════════════════════════════════════════');
    log('  ✓ 全部就绪，可以构建了');
    log('═══════════════════════════════════════════════');
    log('    bash build.sh');
    log('');
    return;
  }

  log('═══════════════════════════════════════════════');
  log('  ✗ 还有依赖没就绪');
  log('═══════════════════════════════════════════════');
  for (const [n, r] of missing) log(`    ${n}: ${r}`);
  log('');
  log('  手动方案：');
  log('    ffmpeg  https://www.gyan.dev/ffmpeg/builds/  → 取 bin/ffmpeg.exe');
  log('    yt-dlp  https://github.com/yt-dlp/yt-dlp/releases/latest');
  log('    两个文件都放到 src/ 根目录');
  log('');
  process.exitCode = 1;
}

main().catch((e) => {
  console.error('\n[致命]', e.message);
  process.exit(1);
});
