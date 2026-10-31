#!/usr/bin/env node
/**
 * cli.mjs — 统一入口（单 EXE 的唯一 main）
 *
 * 把 抖音 / 音乐 / 知乎 三个引擎打进同一个可执行文件，靠第一个参数分派：
 *
 *   下载器.exe video <url> [...]        抖音视频
 *   下载器.exe music search <关键词>    音乐搜索
 *   下载器.exe music get <关键词>       音乐下载
 *   下载器.exe music preview <关键词>   音乐试听
 *   下载器.exe sites <url> [...]        站点视频（B站/优酷/腾讯等）
 *   下载器.exe zhihu <url> [...]        知乎转 Markdown
 *   下载器.exe gui                      打印可用命令
 *   下载器.exe --version
 *
 * 分派方式：改写 process.argv 后调用对应模块的 run()，
 * 各模块内部仍按原有参数格式解析，互不干扰。
 */

// 版本号。
//
// 构建时用 esbuild --define:__VER__="'1.0.0'" 覆盖，不改这个字面量 ——
// 以前是拿 sed/python 去替换源码里的 '1.0.1'，打完再改回来；中途失败就会
// 留下错误的版本号，而且看不出来（和 BUILD_INTERNAL 是同一类事故）。
// 现在默认值只是"直接 node 跑时看到什么"，产物版本由构建脚本决定。
const VERSION = '1.2.0-beta1';

// 静态 import：esbuild 才能把三个模块真正打进同一个 bundle。
// 用动态 import(变量) 会被保留成运行时求值，单 EXE 里没有外部文件，必然报
// "Cannot find module <path>/xxx.mjs"。
import * as modVideo from '../engines/douyin-dl.mjs';
import * as modMusic from '../engines/music-dl.mjs';
import * as modZhihu from '../engines/zhihu-md.mjs';
import * as modSites from '../engines/video-dl.mjs';
import * as modLicense from '../dev/license.mjs';
import * as modGrab from '../engines/web-grab.mjs';
import * as modReport from '../dev/report.mjs';
import * as modNovel from '../engines/novel-dl.mjs';
import * as modWechat from '../engines/wechat-md.mjs';
import * as modPlaylist from '../engines/playlist.mjs';
import * as modStock from '../engines/stock.mjs';
import * as modKuaishou from '../engines/kuaishou-dl.mjs';
import { gateStatus, internalResource } from '../dev/gate.mjs';
import { BUILD_INTERNAL } from '../dev/buildflag.mjs';

const COMMANDS = {
  report: {
    title: '发送错误报告',
    args: '<描述文字> [--log <日志文件>]',
    mod: { run: runReport },
    module: './report.mjs',
    examples: [
      '下载器.exe report "点开始下载后闪退"',
      '下载器.exe report "报错" --log logs/ui-20261025.log',
    ],
  },
  license: {
    title: '激活与授权',
    args: 'status | activate <激活码> | machine | deactivate',
    mod: { run: runLicense },
    module: './license.mjs',
    examples: [
      '下载器.exe license machine',
      '下载器.exe license activate "<激活码>"',
      '下载器.exe license status',
    ],
  },
  video: {
    title: '抖音视频下载',
    args: '<链接/分享文本> [...] [-q 画质] [-o 目录] [--audio] [--headful]',
    mod: modVideo,
    module: './douyin-dl.mjs',
    examples: [
      '下载器.exe video "https://v.douyin.com/xxxxx/"',
      '下载器.exe video "https://v.douyin.com/xxxxx/" -q 4k',
    ],
  },
  music: {
    title: '音乐聚合（酷我/QQ/网易云 · 货比三家）',
    args: 'search|get|preview <关键词> [-p 平台] [-n 条数] [-o 目录]',
    mod: modMusic,
    module: './music-dl.mjs',
    examples: [
      '下载器.exe music search "雨爱"',
      '下载器.exe music get "雨爱"',
      '下载器.exe music preview "雨爱" --platform kuwo',
    ],
  },
  sites: {
    title: '站点视频（B站/优酷/腾讯/芒果 等）',
    args: '<链接> [...] [-q 清晰度] [-o 目录] [--subs] [--cookies-from chrome] [--json]',
    mod: modSites,
    module: './video-dl.mjs',
    examples: [
      '下载器.exe sites "https://www.bilibili.com/video/BV1xx411c7mD"',
      '下载器.exe sites "<url>" -q 1080 --subs',
      '下载器.exe sites "<url>" --cookies-from chrome',
    ],
  },
  grab: {
    title: '通用网页抓取（测试）',
    args: '<url> [--images] [--text] [--links] [--all] [-o 目录] [--json]',
    mod: modGrab,
    module: './web-grab.mjs',
    examples: [
      '下载器.exe grab "https://example.com/article"',
      '下载器.exe grab "<url>" --all -o D:\\grab',
      '下载器.exe grab "<url>" --images --min-w 800',
    ],
  },
  zhihu: {
    title: '知乎文章 → Markdown',
    args: '<链接> [...] [-o 目录] [--headful] [--wait ms]',
    mod: modZhihu,
    module: './zhihu-md.mjs',
    examples: [
      '下载器.exe zhihu "https://zhuanlan.zhihu.com/p/xxxxx"',
      '下载器.exe zhihu "https://zhuanlan.zhihu.com/p/xxxxx" -o D:\\notes --headful',
    ],
  },
  novel: {
    title: '小说下载（笔趣阁系）',
    args: '<书籍链接> [...] [-o 目录] [--from N] [--to N] [--delay ms] [--list]',
    mod: modNovel,
    module: './novel-dl.mjs',
    examples: [
      '下载器.exe novel "https://www.biquge365.net/book/004552/"',
      '下载器.exe novel "<链接>" --list',
      '下载器.exe novel "<链接>" --from 1 --to 20 -o D:\\novels',
    ],
  },
  wechat: {
    title: '公众号文章 → Markdown / Word',
    args: '<链接> [...] [-o 目录] [-f md,txt,docx] [--no-images]',
    mod: modWechat,
    module: './wechat-md.mjs',
    examples: [
      '下载器.exe wechat "https://mp.weixin.qq.com/s/xxxxx"',
      '下载器.exe wechat "<链接>" -f md,docx -o D:\\notes',
      '下载器.exe wechat "<链接>" --no-images',
    ],
  },
  playlist: {
    title: '歌单批量下载（剪辑配乐）',
    args: '<歌单链接> [-n 数量] [--from N] [--to N] [--meta] [--list]',
    mod: modPlaylist,
    module: './playlist.mjs',
    examples: [
      '下载器.exe playlist "https://music.163.com/playlist?id=3778678"',
      '下载器.exe playlist 3778678 -n 10 --meta',
      '下载器.exe playlist "<链接>" --from 50 --to 80',
    ],
  },
  stock: {
    title: '免版权素材（B-roll，可商用）',
    args: '<关键词> 或 --scene <场景> [-n 数量] [--min-height 1080]',
    mod: modStock,
    module: './stock.mjs',
    examples: [
      '下载器.exe stock --scene 城市夜景 -n 8',
      '下载器.exe stock nature -n 5 --min-height 1080',
      '下载器.exe stock --list',
    ],
  },
  kuaishou: {
    title: '快手视频 / 图集',
    args: '<链接> [...] [--headful] [--profile] [-o 目录]',
    mod: modKuaishou,
    module: './kuaishou-dl.mjs',
    examples: [
      '下载器.exe kuaishou "<链接>" --headful --profile',
      '下载器.exe kuaishou "<链接>" --profile',
    ],
  },
};

/**
 * 授权子命令。
 * 注意：这里不 import 具体实现，全部通过 license.mjs 的导出走，
 * 保证"卡密参与真实运算"这条链只有一处实现。
 */
function runLicense() {
  const argv = process.argv.slice(2);
  const sub = (argv[0] || '').toLowerCase();
  const arg = argv[1] || '';

  switch (sub) {
    case 'machine': {
      const mc = modLicense.machineCode();
      console.log('');
      console.log('  本机机器码: ' + mc);
      console.log('');
      console.log('  把这个码发给卖家，换取绑定本机的激活码。');
      console.log('');
      break;
    }
    case 'activate': {
      if (!arg) {
        console.error('用法: 下载器.exe license activate "<激活码>"');
        process.exitCode = 1;
        break;
      }
      const r = modLicense.activate(arg);
      console.log('');
      if (r.ok) {
        console.log('  ✅ 激活成功');
        console.log('  机器码: ' + r.machine);
        if (r.expiry) console.log('  有效期至: ' + r.expiry + '  （剩 ' + r.daysLeft + ' 天）');

        // 续费累加提示：让用户看见"我买的天数加上去了"，否则会怀疑没生效
        if (r.stacked && r.prevExpiry) {
          console.log('  📈 已累加：原到期 ' + r.prevExpiry + ' + 本卡时长 → ' + r.expiry);
        } else if (r.prevExpiry && r.prevExpiry !== r.expiry && !r.stacked) {
          console.log('  ⚠ 保留了较晚的到期日 ' + r.expiry + '（原 ' + r.prevExpiry + '，本卡更短，未覆盖）');
        }

        modSites.setActiveResource(r.resource);
        console.log('');
      } else if (r.reason === 'expired') {
        console.log('  ⏰ 激活码已过期（' + (r.expiry || '?') + '）');
        console.log('  请联系卖家续期。');
        console.log('');
        process.exitCode = 1;
      } else if (r.reason === 'card-used') {
        // 防重放：同一张卡不能重复累加（否则就是无限刷时长）
        console.log('  🔒 这张卡已经在本机用过了');
        if (r.expiry) console.log('  当前有效期至: ' + r.expiry + (r.daysLeft ? '（剩 ' + r.daysLeft + ' 天）' : ''));
        console.log('');
        console.log('  一张卡只能叠加一次。要继续延长，请购买新卡。');
        console.log('  如果是换了电脑 / 重装系统后要恢复授权，请联系卖家换发。');
        console.log('');
        process.exitCode = 1;
      } else {
        const map = {
          format: '激活码格式不对（应为一整串 base64，或 XXXXX-XXXXX-XXXXX-XXXX 形式的卡密）',
          length: '卡密长度不对',
          signature: '卡密签名校验失败（码被改动，或不是本软件签发的）',
          machine: '机器码不匹配（这个码不是给本机签发的）',
          'blob:decrypt': '激活码里的授权数据无法解密（码被改动，或与卡密不配对）',
        };
        console.log('  ❌ 激活失败: ' + (map[r.reason] || r.reason));
        if (r.machine) console.log('  本机机器码: ' + r.machine);
        console.log('');
        process.exitCode = 1;
      }
      break;
    }
    case 'status': {
      const st = modLicense.status();
      console.log('');
      console.log('  机器码: ' + st.machine);
      if (st.activated) {
        console.log('  状态  : ✅ 已激活');
        if (st.tierLabel) console.log('  档位  : ' + st.tierLabel);
        console.log('  卡密  : ' + st.code);
        if (st.expiry) {
          const d = st.daysLeft;
          const warn = d <= 7 ? '  ⚠ 即将到期' : '';
          console.log('  到期  : ' + st.expiry + '  （剩 ' + d + ' 天）' + warn);
        }
        console.log('  激活于: ' + st.savedAt);
      } else if (st.expired) {
        console.log('  状态  : ⏰ 已过期（' + (st.expiry || '?') + '）');
        if (st.tierLabel) console.log('  档位  : ' + st.tierLabel);
        console.log('  提示  : 请联系卖家续期，然后重新激活');
      } else {
        console.log('  状态  : ❌ 未激活 (' + st.reason + ')');
        console.log('  提示  : 用 license activate "<激活码>" 激活');
      }
      console.log('');
      break;
    }
    case 'deactivate': {
      modLicense.clearLicense();
      console.log('  已清除本机激活记录。');
      break;
    }
    default:
      console.log(`
授权命令

  下载器.exe license machine              查看本机机器码
  下载器.exe license activate "<激活码>"   激活
  下载器.exe license status               查看激活状态
  下载器.exe license deactivate           清除激活
`);
  }
}

/**
 * 未激活时的阻断提示。
 *
 * 设计原则：把"怎么解决"写清楚，别让用户以为程序坏了。
 * 机器码必须显示 —— 否则用户还得先去别处找，多一步就多一批退款。
 */
function printLockedNotice(licState) {
  const mc = (licState && licState.machine) || '?????';
  const reason = (licState && licState.reason) || 'absent';

  const reasonText = {
    absent: '尚未激活',
    corrupt: '激活文件损坏',
    tampered: '激活文件被改动过',
    signature: '激活码无效',
    machine: '激活码与本机不匹配',
    expired: '已过期' + (licState && licState.expiry ? '（' + licState.expiry + '）' : ''),
    'clock-rollback': '系统时间被改过（检测到时间倒退，请校准系统时间后重试）',
    'resource:no-blob': '激活数据不完整',
    'resource:decrypt': '激活数据无法解密',
  }[reason] || ('激活无效（' + reason + '）');

  console.error('');
  console.error('╔═══════════════════════════════════════════════════════╗');
  console.error('║                    软 件 未 激 活                     ║');
  console.error('╚═══════════════════════════════════════════════════════╝');
  console.error('');
  console.error('  状态  : ' + reasonText);
  console.error('  机器码: ' + mc);
  console.error('');
  console.error('  使用方法:');
  console.error('    1) 把上面的机器码发给卖家，换取激活码');
  console.error('    2) 运行:');
  console.error('         下载器.exe license activate "<激活码>"');
  console.error('');
  console.error('  也可以直接打开 下载器UI.exe，用菜单「授权 → 输入激活码」。');
  console.error('');
  console.error('  查看当前状态: 下载器.exe license status');
  console.error('');
}

/**
 * 手动上报。
 * 用户描述 + 可选日志文件，脱敏后发到开发者邮箱。
 */
async function runReport() {
  const argv = process.argv.slice(2);
  const li = argv.indexOf('--log');
  const logPath = li >= 0 ? argv[li + 1] : null;

  // 摘要只取位置参数。
  // 旧写法是 `argv.filter(a => !a.startsWith('--')).join(' ')`，它只过滤掉
  // 以 -- 开头的**开关**，却把开关后面的**取值**当成描述文字留下了：
  //   report "闪退" --log logs/ui.log
  //   → 邮件主题变成 "闪退 logs/ui.log"（路径混进摘要，脱敏后也不干净）
  // 正确做法：遇到 --log 就把它的取值一起跳过。
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--log') { i++; continue; }
    if (a.startsWith('--')) continue;
    pos.push(a);
  }
  const msg = pos.join(' ').trim();

  if (!msg) {
    console.error('用法: 下载器.exe report "<描述>" [--log <日志文件>]');
    process.exitCode = 1;
    return;
  }

  let detail = '';
  if (logPath) {
    try {
      const fs = await import('node:fs');
      detail = fs.readFileSync(logPath, 'utf-8').slice(-20000);
    } catch (e) {
      console.error('[提示] 读日志失败: ' + e.message);
    }
  }

  console.log('');
  console.log('  正在发送错误报告...');

  // --force：跳过每日限流（给调试/验证用，普通用户用不到）
  const force = argv.includes('--force');
  const r = force
    ? await modReport.reportErrorForce({ message: msg, detail })
    : await modReport.reportError({
        kind: 'manual',
        message: msg,
        detail,
        extra: { logPath: logPath || '(无)' },
      });

  if (r.sent) {
    console.log('  ✅ 已发送，感谢反馈');
  } else {
    const map = {
      'no-config': '本版本未配置上报邮箱，无法自动发送',
      'rate-limited': '今天发送次数已达上限（3 次），请明天再试',
    };
    console.log('  ⚠ 未发送: ' + (map[r.reason] || r.reason));
  }
  console.log('');
}

function printBanner() {
  const p = (globalThis.process && process.execPath || '下载器.exe').split(/[\\/]/).pop();
  console.log(`
╔═══════════════════════════════════════════════════════╗
║    抖音 · 音乐 · 站点视频 · 抓取 · 知乎  下载器       ║
║     Unified Downloader                        v${VERSION}  ║
╚═══════════════════════════════════════════════════════╝

用法: ${p} <命令> [参数...]

命令:`);
  for (const [key, c] of Object.entries(COMMANDS)) {
    console.log(`\n  ${key.padEnd(7)}  ${c.title}`);
    console.log(`           参数: ${c.args}`);
    for (const ex of c.examples) console.log(`           例:   ${ex}`);
  }
  console.log(`
说明:
  · 图形界面请双击 下载器UI.exe，它会自动调用本引擎
  · 三个子命令的参数与各自独立脚本完全一致
  · 加 --help 看某个子命令的详细帮助，例如: 下载器.exe music --help
`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = (argv[0] || '').toLowerCase();

  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help' || cmd === 'gui') {
    printBanner();
    process.exit(0);
  }

  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    console.log(`统一下载器 v${VERSION}`);
    process.exit(0);
  }

  const spec = COMMANDS[cmd];
  if (!spec) {
    console.error(`[错误] 未知命令: ${cmd}`);
    console.error(`可用命令: ${Object.keys(COMMANDS).join(' / ')}`);
    console.error(`运行 "${(process.execPath || '').split(/[\\/]/).pop()} help" 查看用法`);
    process.exit(1);
  }

  // 把子命令剥掉，让下游模块看到它熟悉的 argv 布局
  process.argv = [process.argv[0], process.argv[1], ...argv.slice(1)];

  let licState = null;
  try { licState = modLicense.status(); } catch (e) { licState = null; }

  // ── 激活闸门（第一层） ──
  //
  // ⚠ 这一层**不再是唯一的门**。
  //   现在每个引擎的 run() 开头都会自己 assertFeature()（见 dev/gate.mjs），
  //   所以把这里的 if 改成 false 已经不能把功能全开了 ——
  //   引擎侧会拿到"授权凭据无效"，任务开不了工。
  //
  //   这里保留这层的意义是**体验**：未激活时给出说得清的提示（含机器码，
  //   用户不用再去别处找），而不是让用户点一下、等三秒、才看到一句
  //   "授权凭据校验失败"。
  //
  // license 必须放行（否则用户没法激活，死锁）；report 也要放行 ——
  // 用户激活失败时正是最需要反馈的时候，不能因为未激活就发不出去。
  const isLicenseCmd = cmd === 'license' || cmd === 'report';

  // 内测版：**构建期常量**，来自 dev/buildflag.mjs（build.sh 覆写该文件）。
  // 发布版里它是字面量 false，esbuild --minify 会把下面的 && 分支整个折叠掉，
  // 连字节都不存在 —— 不存在"设个环境变量就白嫖"的路子。
  //
  // 历史教训（保留）：旧代码是
  //     process.env.DSH_DL_SELFTEST === '1'
  // 与 BUILD_INTERNAL 无关，于是发布版里 `set DSH_DL_SELFTEST=1` 就能免费用，
  // UI 的 --selftest 更是任何用户都能加。现在必须 BUILD_INTERNAL 才成立。
  const selftestBypass = BUILD_INTERNAL && process.env.DSH_DL_SELFTEST === '1';
  // 开源免费版：所有功能放行（见 dev/gate.mjs 的 FREE_EDITION）
  const activated = true;

  // 帮助/版本类请求不拦：未激活用户必须能看到"怎么激活"。
  // 引擎侧 assertFeature 对 --help 同样放行（只打印帮助，不走下载路径）。
  const wantsHelp = argv.includes('--help') || argv.includes('-h') || argv.includes('--version');

  if (!activated && !isLicenseCmd && !wantsHelp) {
    printLockedNotice(licState);
    process.exit(2);
  }

  // 已激活：把解出的资源注入 sites（CDN 镜像表就在里面）
  if (activated && licState && licState.resource) {
    try { modSites.setActiveResource(licState.resource); } catch {}
  }

  // 内测版：没有激活码就没有 blob，镜像表只能从 gate 的内置资源里取。
  // 不注入的话「站点视频」在 B站 第三方 CDN 不通时必然失败 ——
  // 而内测版对外宣称的是"五个功能全部解锁"，这就是个真实的坑。
  // 发布版里 BUILD_INTERNAL 是字面量 false，整个分支被折叠掉。
  if (BUILD_INTERNAL) {
    try {
      const res = internalResource();
      if (res) modSites.setActiveResource(res);
    } catch {}
  }

  try {
    if (typeof spec.mod.run !== 'function') {
      throw new Error(`${spec.module} 没有导出 run()，无法分派`);
    }
    await spec.mod.run();
  } catch (e) {
    // 授权类错误单独处理：不当作"引擎崩溃"上报，也不给一堆栈吓用户。
    if (e && e.code === 'ELOCKED') {
      const st = (() => { try { return gateStatus(); } catch { return null; } })();
      console.error('');
      console.error('╔═══════════════════════════════════════════════════════╗');
      console.error('║                   功 能 未 授 权                      ║');
      console.error('╚═══════════════════════════════════════════════════════╝');
      console.error('');
      console.error('  ' + e.message);
      if (st && st.machine) console.error('  机器码: ' + st.machine);
      console.error('');
      console.error('  运行 "下载器.exe license status" 查看激活状态');
      console.error('');
      process.exit(2);
    }

    console.error(`\n[致命] ${e.message}`);

    // 自动上报：失败不影响用户，也不额外打印干扰信息
    try {
      const r = await modReport.reportError({
        kind: 'engine-crash',
        message: e.message,
        detail: (e.stack || '') + '\n\n命令: ' + cmd,
        extra: { command: cmd },
      });
      if (r.sent) console.error('（已自动发送错误报告）');
    } catch {}

    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\n[致命]', e.message);
  process.exit(1);
});
