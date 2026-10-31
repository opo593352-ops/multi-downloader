/**
 * port.mjs — 挑一个真正能 bind 的本机端口
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么需要它（2026-10-28 抖音功能整条挂掉）
 * ═══════════════════════════════════════════════════════════════
 *
 * 现象：
 *   抖音视频一点就报「Chrome 调试端口未就绪」，一条都下不了。
 *   但知乎、网页抓取都正常 —— 这种"部分功能坏"最容易被误判成
 *   "抖音又改风控了"，然后白折腾几小时。
 *
 * 真凶（只有把 Chrome 的 stderr 抓出来才看得到）：
 *
 *   bind() returned an error: 以一种访问权限不允许的方式做了一个
 *   访问套接字的尝试。(0x271D)
 *   Cannot start http server for devtools.
 *
 *   0x271D = WSAEACCES。Windows 有一批「保留端口段」，Hyper-V / WSL /
 *   Docker / 某些安全软件会批量占掉；落在段内的端口**谁都 bind 不了**，
 *   跟权限、跟 Chrome 版本都没关系。
 *
 * 本机实测（`netsh interface ipv4 show excludedportrange protocol=tcp`）：
 *
 *   保留段: 9295-9394 | 9571-9670 | 8971-9070 | 10436-10535 ...
 *   ┌ 抖音  默认 9333  → 落在 9295-9394  ✗ 必挂
 *   ├ 抓取  默认 9663  → 落在 9571-9670  ✗ 必挂
 *   └ 知乎  默认 9444  → 不在任何段内     ✓ 正常
 *
 *   这就是"为什么只有两个功能坏"的完整解释。
 *
 * ═══════════════════════════════════════════════════════════════
 * 做法
 * ═══════════════════════════════════════════════════════════════
 *
 *   从首选端口开始，用 node 自己 bind 一次验证：
 *     · 成功 → 关掉，把这个端口交给 Chrome
 *     · EACCES（保留段）/ EADDRINUSE（被占）→ 端口 +1 再试
 *   最多顺延 40 个。全失败就返回原端口，让 Chrome 自己报原始错误
 *   （总比在这里吞掉原因好）。
 *
 *   用 node 验证是可靠的：Node 和 Chrome 在 Windows 上走同一套 Winsock，
 *   bind 权限判定完全一致。
 *
 * ⚠ 不要用"连一下 127.0.0.1:port 看通不通"来判断 ——
 *   端口没被占用时连接会立刻被拒，看起来像"不可用"，
 *   而实际上它正是我们要的空闲端口。必须用 **bind**。
 */

import net from 'node:net';

/**
 * @param {number} preferred 首选端口
 * @param {number} [maxTries=400] 最多顺延多少个
 * @returns {Promise<number>} 可用的端口（可能是 preferred 本身）
 */
export function findFreePort(preferred, maxTries = 400) {
  return new Promise((resolve) => {
    let port = preferred;
    let tried = 0;

    const attempt = () => {
      // 上限定得大一些：Windows 保留段是**整段连着**的，
      // 本机 9295-9394 就一次吃掉 100 个端口。上限设 40 时，
      // 从 9333 往下试 40 个全在段内 → 直接判定"全失败"回退原端口，
      // 等于什么都没修（这个假阴性实测踩过）。
      // 400 足够跨过任何单个保留段，同时仍能在极端情况下退出。
      if (tried++ >= maxTries) {
        // 全失败：返回原端口，让 Chrome 报它自己的错，别在这里掩盖原因
        return resolve(preferred);
      }

      // ⚠ 每次必须**新建** server。
      //   复用同一个 net.Server 实例时，error 之后直接对它 listen(新端口)，
      //   Node 会抛 ERR_SERVER_ALREADY_LISTEN -> 静默失败，
      //   于是"明明 EACCES 却返回可用"（实测踩到）。
      const srv = net.createServer();
      const tryPort = port;

      const next = () => {
        try { srv.removeAllListeners(); } catch {}
        try { srv.close(); } catch {}
        port++;
        attempt();
      };

      srv.once('error', () => {
        // EACCES = Windows 保留段；EADDRINUSE = 被占用。两种都往下顺延。
        next();
      });

      srv.once('listening', () => {
        try { srv.removeAllListeners(); } catch {}
        // 关掉再交还端口，Chrome 马上就能 bind
        srv.close(() => resolve(tryPort));
      });

      try {
        srv.listen(tryPort, '127.0.0.1');
      } catch {
        next();
      }
    };

    attempt();
  });
}

/**
 * 带提示的版本：端口变了就打一行警告。
 * @param {number} preferred
 * @param {(msg:string)=>void} [warnFn]
 * @returns {Promise<number>}
 */
export async function pickPort(preferred, warnFn = (m) => console.error('[warn]', m)) {
  const actual = await findFreePort(preferred);
  if (actual !== preferred) {
    warnFn(`  端口 ${preferred} 不可用（Windows 保留段或被占用），自动改用 ${actual}`);
  }
  return actual;
}
