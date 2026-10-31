/**
 * gate.mjs — 功能闸门（纵深校验）
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么需要它
 * ═══════════════════════════════════════════════════════════════
 *
 * 旧结构（v1.0.0）只有 cli.mjs 里**一个** if：
 *
 *   const activated = ...;
 *   if (!activated && !isLicenseCmd) { printLockedNotice(); process.exit(2); }
 *
 * 问题：
 *   1. 单点。把它改成 `if (false)`，五个功能一次全开。
 *   2. 宣传口径说"改 return true 跑不起来"——那句话只对 sites 成立
 *      （镜像表在激活码里）。抖音 / 音乐 / 知乎 / 抓取都不依赖 blob，
 *      闸门一破就全通。防护强度被高估了。
 *
 * ── 现在的结构 ──
 *
 * 每个引擎在自己的 run() 入口独立问一次"我能干活吗"，而不是信任上游。
 * 校验不是布尔值，而是要拿到一件**材料**：
 *
 *   ticket = HMAC-SHA256(SECRET, 'feat|v1|' + feature + '|' + blob.d)
 *
 *   · blob.d 来自激活码（一卡一份，每张卡都不同）
 *   · SECRET 来自 dev/secret.mjs（AES-GCM 封装）
 *
 * 所以想绕过必须同时：
 *   a. 拿到 SECRET（不再是 XOR 表）
 *   b. 拿到本机激活码里的 blob.d
 *   c. 在**每一处**入口都伪造出正确的 ticket
 *
 * 这比"改一个 if"贵得多。它仍然不是不可破的（本地校验的通病，见下），
 * 但门槛从"一行改动"抬到了"重实现整条派生链"。
 *
 * ── ticket 干什么用 ──
 *
 * 不作为网络参数（会被站点当成异常），而是作为**本地状态凭据**：
 *   · 拼进断点续传临时文件名
 *   · 写进输出目录的 .dl-ticket，下次启动校验
 *   · 出现在日志签名里
 *
 * 两处使用：引擎启动时校验一次，任务完成时写回一次。中间任何一处
 * 材料不对，都会在用户可见的地方表现成"授权异常"。
 *
 * ── 诚实的边界（必须写清，别自欺）──
 *
 * 只要校验在客户端，最终一定能被 patch。真正的目标：
 *   · 把"一行 if"变成"多点 + 材料依赖 + 每卡不同"
 *   · 让破解者必须理解完整派生链，而不是删掉两行
 *   · 保留可维护性：新增功能只需要在 run() 开头加一行 assertFeature
 *
 * 想更强只有一条路：联网校验（服务端签发 runtime token）。
 * 那会引入服务器成本和离线不可用问题，当前规模不划算 —— 这是取舍，不是遗漏。
 */

import crypto from 'node:crypto';
import { SECRET } from './secret.mjs';
import { status, loadLicense } from './license.mjs';
import { BUILD_INTERNAL } from './buildflag.mjs';

// 功能白名单。
// ⚠ 新增引擎时**必须**在这里加名字，否则 assertFeature 会返回
//   'unknown-feature'，那个功能直接不可用（而且报错看起来像"未授权"，
//   很容易误判成卡密问题）。
export const FEATURES = [
  'video',    // 抖音
  'music',    // 音乐三平台
  'sites',    // 站点视频（B站等）
  'grab',     // 通用网页抓取
  'zhihu',    // 知乎（含专栏批量）
  'novel',    // 小说
  'wechat',   // 公众号
  'kuaishou', // 快手
  'stock',    // 免版权素材（Pixabay / Pexels）
];

let _state = null;

/**
 * 取当前授权材料（带缓存，避免每个功能都读盘）。
 * 注意：不清缓存 —— 进程生命周期内授权状态不会变；
 * 重新激活是另一个进程的事。
 */
/**
 * 内测版状态（构建期常量）。
 *
 * ⚠ 这里必须用**三元表达式**而不是 `if (BUILD_INTERNAL) { ... }`。
 *   esbuild 把 `if (false) {...}` 折叠成 `if (!1) {...}` —— 分支永不执行，
 *   但**块体仍留在产物里**，于是 "internal-build" 这种字符串会被
 *   strings 抓到，等于告诉破解者"这里有个内测分支"。
 *   三元表达式会被折叠成 `null`，块体整个消失。
 *
 * ── 为什么内测版必须自带镜像表（v1.0.0 一测版修的 bug）──
 *
 *   内测版没有激活码 → 没有 blob → `unlockResource` 拿不到镜像表。
 *   于是「站点视频」在 B站 第三方 CDN 连不上时**必然失败**，
 *   而内测版对外说的是"五个功能全部解锁"。
 *
 *   实测：BV1GJ411x7h7 在原 CDN 不通的网络下，
 *        内测版直接 `fetch failed`，正式版（已激活）却能走镜像成功。
 *
 *   修法：内测版内置一份镜像表。它只存在于 BUILD_INTERNAL=true 的构建里，
 *   发布版会被折叠成 null —— 所以「删掉 blob 就能白拿镜像」这条退化路径
 *   依然不存在（见 license.mjs 的 defaultResource 说明）。
 */
const INTERNAL_MIRRORS = ['upos-sz-mirror', 'cos.bili', 'video.com'].join('');
const INTERNAL_MIRRORS2 = ['upos-sz-mirror', 'ali.bili', 'video.com'].join('');
const INTERNAL_MIRRORS3 = ['upos-sz-mirror', 'hw.bili', 'video.com'].join('');
const INTERNAL_MIRRORS4 = ['upos-sz-mirror', '08c.bili', 'video.com'].join('');

const INTERNAL_STATE = BUILD_INTERNAL
  ? {
      ok: true,
      code: '(internal)',
      machine: 'internal',
      tier: 'forever',
      tierLabel: '内测版',
      expiry: null,
      daysLeft: 32767,
      blobD: 'internal-build',
      // 内测版没有激活码，镜像表只能内置 —— 否则站点视频在多数网络下用不了
      resource: {
        v: 1,
        tier: 'forever',
        tierLabel: '内测版',
        mirrors: {
          bilibili: [INTERNAL_MIRRORS, INTERNAL_MIRRORS2, INTERNAL_MIRRORS3, INTERNAL_MIRRORS4],
        },
        api: { retry: 3, uaProfile: 'chrome131' },
        internal: true,
      },
      internal: true,
    }
  : null;

function state() {
  if (_state) return _state;

  // 内测版直接放行（发布版里 INTERNAL_STATE 被折叠成 null，走不到这里）
  if (INTERNAL_STATE) {
    _state = INTERNAL_STATE;
    return _state;
  }

  let st;
  try { st = status(); } catch (e) { st = { activated: false, reason: 'status:' + e.message }; }

  if (!st || !st.activated) {
    _state = { ok: false, reason: (st && st.reason) || 'absent', machine: st && st.machine };
    return _state;
  }

  // blob.d 是"每卡一份"的材料，没有它就算不出 ticket
  const blobD = readBlobD();
  if (!blobD) {
    _state = { ok: false, reason: 'resource:no-blob', machine: st.machine };
    return _state;
  }

  _state = {
    ok: true,
    code: st.code,
    machine: st.machine,
    tier: st.tier,
    tierLabel: st.tierLabel,
    expiry: st.expiry,
    daysLeft: st.daysLeft,
    blobD,
    resource: st.resource || null,
  };
  return _state;
}

/** 从落盘的激活记录里取 blob.d（走 license.mjs 的官方解码，别自己猜格式） */
function readBlobD() {
  try {
    const lic = loadLicense();
    if (!lic || !lic.ok || !lic.blob) return '';
    return typeof lic.blob.d === 'string' ? lic.blob.d : '';
  } catch {
    return '';
  }
}

/** 功能票：一卡一票，feature 之间互不通用 */
export function ticket(feature) {
  const s = state();
  if (!s.ok) return null;
  return crypto
    .createHmac('sha256', SECRET())
    .update('feat|v1|' + String(feature).toLowerCase() + '|' + s.blobD, 'utf-8')
    .digest('hex');
}

/**
 * 校验某功能是否可用。
 * @param {string} feature FEATURES 里的名字
 * @returns {{ok:boolean, reason?:string, ticket?:string, info?:object}}
 */
export function checkFeature(feature) {
  const f = String(feature || '').toLowerCase();
  if (!FEATURES.includes(f)) return { ok: false, reason: 'unknown-feature' };

  const s = state();
  if (!s.ok) return { ok: false, reason: s.reason, machine: s.machine };

  let t;
  try { t = ticket(f); } catch (e) { return { ok: false, reason: 'secret:' + e.message }; }
  if (!t || t.length !== 64) return { ok: false, reason: 'ticket' };

  // 反向自检：票必须能由材料重算出来。
  // 这一步的意义是：如果攻击者把 ticket() 改成返回常量，
  // 这里的重算会失败（常量 vs 真值），从而在**另一个函数**里露馅。
  // 单点 patch 不再够用。
  try {
    const again = crypto
      .createHmac('sha256', SECRET())
      .update('feat|v1|' + f + '|' + s.blobD, 'utf-8')
      .digest('hex');
    if (again !== t) return { ok: false, reason: 'ticket-mismatch' };
  } catch (e) {
    return { ok: false, reason: 'secret:' + e.message };
  }

  return {
    ok: true,
    ticket: t,
    info: {
      tier: s.tier,
      tierLabel: s.tierLabel,
      expiry: s.expiry,
      daysLeft: s.daysLeft,
      machine: s.machine,
    },
  };
}

/** 引擎入口用。抛错即代表"该功能不可用"，由 cli 统一转成 exit=2。 */
/**
 * 免费版总开关（v1.2.0 开源）。
 *
 * 本软件已转为开源免费，所有功能无条件放行。
 *
 * 为什么保留卡密代码而不删：
 *   1. 两千多行，删了想加回来很难
 *   2. 社区 fork 可能需要（比如公司内部部署要限制人数）
 *   3. 保留但不启用，对普通用户零影响
 *
 * 想恢复收费：把这个常量改成 false，并确保 dev/secret.mjs 里的密钥
 * 是你自己重新生成的（原密钥已随源码公开，任何人都能签卡）。
 */
export const FREE_EDITION = true;

/**
 * 开源版的固定票（12 位十六进制，和真实票的前 12 位同形状）。
 * tempWorkDir() 会把它拼进临时目录名并回读核对。
 */
const FREE_TICKET = '0f3e9a7c1b42';

export function assertFeature(feature, label) {
  // 开源免费版：全部放行，并给一张形状合法的票（tempWorkDir 要用）
  if (FREE_EDITION) {
    return { ok: true, ticket: FREE_TICKET, free: true };
  }

  // 帮助/版本类请求直接放行。
  // 安全上没风险：每个引擎的 main() 遇到 --help 都是"打印帮助后 return 或 exit"，
  // 一条下载路径都不会走。而不放行的话，未激活用户连"怎么激活"都看不到。
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) return { ok: true, ticket: null, help: true };

  const r = checkFeature(feature);
  if (r.ok) return r;

  const map = {
    absent: '尚未激活',
    corrupt: '激活文件损坏',
    tampered: '激活文件被改动过',
    expired: '授权已过期',
    'clock-rollback': '系统时间被改过',
    'resource:no-blob': '激活数据不完整（请重新粘贴激活码）',
    'resource:decrypt': '激活数据无法解密',
    ticket: '授权凭据无效',
    'ticket-mismatch': '授权凭据校验失败',
    'unknown-feature': '未知功能',
  };
  const reason = map[r.reason] || r.reason || '未授权';

  const err = new Error(`${label || feature} 不可用：${reason}`);
  err.code = 'ELOCKED';
  err.reason = r.reason;
  err.machine = r.machine;
  throw err;
}

/**
 * 断点续传 / 临时文件用的短票（取 ticket 前 12 位）。
 *
 * 让"材料"真正落到磁盘上的路径里 —— 少了它，临时目录/续传文件对不上，
 * 下载会当场失败。这是"票必须存在"的物理落点，而不是一句注释。
 */
export function shortTicket(feature) {
  // 开源免费版：发一张形状合法的固定票。
  //
  // 为什么不能直接 return null：
  //   tempWorkDir() 拿不到票就抛「缺少授权凭据」，下载当场失败。
  //   这是防破解的第二道闸（防"改 checkFeature 返回 ok 但没票"），
  //   开源版必须让它通过，否则功能全废 —— 实测踩过：
  //   站点视频报「sites 缺少授权凭据，任务无法开始」。
  //
  // 为什么是固定值而不是随机：
  //   临时目录名要可预测，断点续传才能跨进程对上。
  //   开源版没有"防谁"的需求，固定值最简单。
  if (FREE_EDITION) return FREE_TICKET;

  const r = checkFeature(feature);
  // 注意：不能只判 r.ok —— 破解者可能让 checkFeature 返回 {ok:true, ticket:null}。
  // 这里必须同时确认 ticket 是 64 位十六进制，否则返回 null 让调用方拒绝。
  if (!r || !r.ok || typeof r.ticket !== 'string' || r.ticket.length !== 64) return null;
  return r.ticket.slice(0, 12);
}

/**
 * 建一个带票的临时目录。
 *
 * 建完**立刻把目录名读回来核对**：如果攻击者把 checkFeature 改成
 * `return {ok:true}`（没有 ticket），这里拿不到票 → 直接抛。
 * 只改一个 if 不再够用。
 *
 * @returns {Promise<string>} 临时目录绝对路径
 */
export async function tempWorkDir(feature, prefix) {
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');

  const t = shortTicket(feature);
  if (!t) {
    const err = new Error(`${feature} 缺少授权凭据，任务无法开始`);
    err.code = 'ELOCKED';
    throw err;
  }

  const base = path.join(os.tmpdir(), `${prefix}-${t}-`);
  const dir = await fsp.mkdtemp(base);

  // 回读核对：目录名里必须真的带着这张票
  const name = path.basename(dir);
  if (!name.includes(t) || t.length !== 12) {
    const err = new Error(`${feature} 授权凭据校验失败`);
    err.code = 'ELOCKED';
    throw err;
  }
  return dir;
}

/**
 * 内测版的内置资源（镜像表）。
 * 发布版里 INTERNAL_STATE 是 null，这里返回 null —— 分支会被折叠掉。
 * 只在 cli.mjs 的 BUILD_INTERNAL 分支里调用。
 */
export function internalResource() {
  return INTERNAL_STATE ? INTERNAL_STATE.resource : null;
}

/** 供 UI / 自检读取，不抛错 */
export function gateStatus() {
  const s = state();
  const list = {};
  for (const f of FEATURES) {
    const r = checkFeature(f);
    list[f] = r.ok ? 'ok' : r.reason;
  }
  return {
    activated: !!s.ok,
    reason: s.reason || null,
    tier: s.tier || null,
    tierLabel: s.tierLabel || null,
    daysLeft: typeof s.daysLeft === 'number' ? s.daysLeft : null,
    machine: s.machine || null,
    features: list,
  };
}

/** 清缓存（测试用） */
export function __resetGate() { _state = null; }
