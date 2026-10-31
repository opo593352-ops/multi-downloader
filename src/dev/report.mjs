/**
 * report.mjs — 错误反馈（自动发邮件）
 *
 * 设计要点：
 *
 * 1. **不能阻塞主流程**。用户点下载失败，程序先正常报错退出，
 *    上报在后台跑；发不出去也不能影响用户体验。
 *
 * 2. **必须脱敏**。日志里可能有：本地路径（含用户名）、
 *    cookie、卡密、机器名。上报前全部替换掉。
 *
 * 3. **频率限制**。同一台机器一天最多发 3 封，
 *    避免用户疯狂点重试把邮箱打爆，也避免被当成垃圾邮件源。
 *
 * 4. **SMTP 凭据不能硬编码在二进制里**。
 *    这里读同目录的 report-config.json（不进发布包，
 *    由你在打包时单独放进去或者用户目录）。
 *    没有配置文件就静默跳过，不报错。
 *
 * 配置文件格式（report-config.json）：
 *   {
 *     "host": "smtp.163.com",
 *     "port": 465,
 *     "secure": true,
 *     "user": "发件邮箱@163.com",
 *     "pass": "SMTP授权码",
 *     "to": "sjsjdj173@163.com"
 *   }
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import crypto from 'node:crypto';

const MAX_PER_DAY = 3;

/**
 * 收件地址也不能明文写。
 * `sjsjdj173@163.com` 出现在二进制里，等于把开发者邮箱公开
 * （strings 一下就有，然后被爬去发垃圾邮件/钓鱼）。
 * 这里同样拆段 + XOR，与下面的内置凭据一致。
 */
const TO_MASK = 0x37;
const TO_SEGS = [[0x44, 0x5d, 0x44, 0x5d, 0x53, 0x5d, 0x06, 0x00, 0x04, 0x77, 0x06, 0x01, 0x04, 0x19, 0x54, 0x58, 0x5a]];

function defaultTo() {
  let out = '';
  for (const seg of TO_SEGS) for (const b of seg) out += String.fromCharCode(b ^ TO_MASK);
  return out;
}

function baseDir() {
  const exe = process.execPath || '';
  const name = path.basename(exe).toLowerCase();
  const isSea = name !== 'node.exe' && name !== 'node';
  if (isSea) return path.dirname(exe);
  return path.dirname(path.resolve(process.argv[1] || '.'));
}

function stateDir() {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, 'UnifiedDownloader');
}

/**
 * 内置 SMTP 凭据（拆段 + XOR，运行时才拼）。
 *
 * ── 为什么不能再用 report-config.json 随包分发 ──
 *
 * 旧做法是把 report-config.json 打进发布包，里面明文写着
 *   user / pass（163 SMTP 授权码）
 * 结果：每一个买家解压就能看到你的发件邮箱密码，拿去发垃圾邮件、
 * 或者直接把授权码作废，你的错误上报通道立刻死掉。
 * 这跟「卡密生成器不能外发」是同一类错误 —— 只是没那么显眼。
 *
 * 现在的策略：
 *   1. 内置一份，拆段混淆（和 license.mjs 的 SECRET 同手法）
 *   2. 外部 report-config.json 仍然支持，作为**覆盖**（给换邮箱/调试用）
 *   3. 发布包里**不再放**这个文件（build-all.cmd 已加删除）
 *
 * 注意：内置凭据最终必然存在于内存/二进制里，混淆只提高门槛。
 * 真要更强就得上服务端接口 + 每机 token，对小规模不划算。
 */
const SMTP_MASK = 0x37;
const SMTP_SEGS = {
  // 每段都 XOR 过；运行期按 SMTP_MASK 还原。
  // 明文只在开发者机器上：见 report-config.json（**不进发布包**）。
  host: [[0x44, 0x5a, 0x43, 0x47, 0x19, 0x06, 0x01, 0x04, 0x19, 0x54, 0x58, 0x5a]],
  user: [[0x44, 0x5d, 0x44, 0x5d, 0x53, 0x5d, 0x06, 0x00, 0x04, 0x77, 0x06, 0x01, 0x04, 0x19, 0x54, 0x58, 0x5a]],
  pass: [[0x72, 0x70, 0x62, 0x54, 0x61, 0x7a, 0x46, 0x5c, 0x54, 0x72, 0x70, 0x00, 0x60, 0x7b, 0x6f, 0x47]],
};

function unmask(segs) {
  let out = '';
  for (const seg of segs) {
    for (const b of seg) out += String.fromCharCode(b ^ SMTP_MASK);
  }
  return out;
}

/** 内置默认配置；解不出来（例如被裁掉的构建）就返回 null */
function builtinConfig() {
  try {
    const user = unmask(SMTP_SEGS.user);
    const pass = unmask(SMTP_SEGS.pass);
    if (!user || !pass) return null;
    return {
      host: unmask(SMTP_SEGS.host) || 'smtp.163.com',
      port: 465,
      secure: true,
      user,
      pass,
      to: defaultTo(),
    };
  } catch { return null; }
}

/** 读 SMTP 配置：外部文件（覆盖）→ 内置 → 环境变量 */
function loadConfig() {
  const candidates = [
    path.join(baseDir(), 'report-config.json'),
    path.join(stateDir(), 'report-config.json'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (cfg && cfg.user && cfg.pass) {
          return {
            host: cfg.host || 'smtp.163.com',
            port: Number(cfg.port) || 465,
            secure: cfg.secure !== false,
            user: cfg.user,
            pass: cfg.pass,
            to: cfg.to || defaultTo(),
          };
        }
      }
    } catch {}
  }
  // 环境变量兜底（便于 CI/调试）
  if (process.env.DSH_SMTP_USER && process.env.DSH_SMTP_PASS) {
    return {
      host: process.env.DSH_SMTP_HOST || 'smtp.163.com',
      port: Number(process.env.DSH_SMTP_PORT) || 465,
      secure: process.env.DSH_SMTP_SECURE !== '0',
      user: process.env.DSH_SMTP_USER,
      pass: process.env.DSH_SMTP_PASS,
      to: process.env.DSH_SMTP_TO || defaultTo(),
    };
  }
  // 内置凭据：发布版靠这条工作，不再需要随包的 report-config.json
  return builtinConfig();
}

// ───────────────────── 脱敏 ─────────────────────
/**
 * 上报前必须抹掉这些。宁可信息少一点，也不能把用户隐私传出去。
 */
function sanitize(text) {
  let s = String(text || '');

  // 本地路径里的用户名：C:\Users\xxx\... → C:\Users\<user>\...
  s = s.replace(/([A-Za-z]:\\Users\\)[^\\\s]+/gi, '$1<user>');
  s = s.replace(/(\/home\/)[^\/\s]+/g, '$1<user>');
  s = s.replace(/(\/Users\/)[^\/\s]+/g, '$1<user>');

  // 邮箱
  s = s.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>');

  // 卡密 / 激活码（19 位分组 或 长 base64）
  s = s.replace(/\b[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{4}\b/g, '<key>');
  s = s.replace(/\beyJ[A-Za-z0-9+/=]{80,}/g, '<activation>');

  // cookie / token / 密码
  s = s.replace(/((?:cookie|token|password|passwd|secret|authorization)["'\s:=]+)[^\s"',;]{8,}/gi, '$1<redacted>');

  // 机器名
  try {
    const hn = os.hostname();
    if (hn && hn.length > 2) s = s.split(hn).join('<hostname>');
  } catch {}

  return s;
}

// ───────────────────── 频率限制 ─────────────────────
function rateLimitFile() {
  return path.join(stateDir(), 'report-count.json');
}

function checkAndBumpRate() {
  const f = rateLimitFile();
  const today = new Date().toISOString().slice(0, 10);
  let rec = { date: today, count: 0 };
  try {
    if (fs.existsSync(f)) {
      const old = JSON.parse(fs.readFileSync(f, 'utf-8'));
      if (old && old.date === today) rec = old;
    }
  } catch {}

  if (rec.count >= MAX_PER_DAY) return false;
  rec.count++;
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(rec), 'utf-8');
  } catch {}
  return true;
}

// ───────────────────── 极简 SMTP 客户端 ─────────────────────
/**
 * 只用最小实现：AUTH LOGIN + MAIL/RCPT/DATA。
 * 不引第三方库（SEA 打包友好），也不支持 STARTTLS（163/QQ 用 465 直连 SSL）。
 */
function smtpSend(cfg, mail) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect(
      { host: cfg.host, port: cfg.port, servername: cfg.host, timeout: 30000 },
      () => {}
    );

    let buf = '';
    let step = 0;
    let finished = false;

    const done = (err) => {
      if (finished) return;
      finished = true;
      try { sock.destroy(); } catch {}
      err ? reject(err) : resolve();
    };

    const send = (line) => {
      try { sock.write(line + '\r\n'); } catch (e) { done(e); }
    };

    const b64 = (s) => Buffer.from(s, 'utf-8').toString('base64');

    sock.on('data', (chunk) => {
      buf += chunk.toString('utf-8');

      // SMTP 多行响应：末行是 "250 xxx"（第 4 个字符是空格）
      while (true) {
        const idx = buf.indexOf('\r\n');
        if (idx < 0) break;
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (line.length >= 4 && line[3] === '-') continue;   // 还有后续行

        const code = line.slice(0, 3);

        try {
          switch (step) {
            case 0:   // 220 服务就绪
              if (code !== '220') return done(new Error('SMTP 未就绪: ' + line));
              send('EHLO unified-downloader');
              step = 1;
              break;
            case 1:   // 250 EHLO 响应
              if (code !== '250') return done(new Error('EHLO 失败: ' + line));
              send('AUTH LOGIN');
              step = 2;
              break;
            case 2:   // 334 用户名
              if (code !== '334') return done(new Error('AUTH 不支持: ' + line));
              send(b64(cfg.user));
              step = 3;
              break;
            case 3:   // 334 密码
              if (code !== '334') return done(new Error('用户名被拒: ' + line));
              send(b64(cfg.pass));
              step = 4;
              break;
            case 4:   // 235 认证成功
              if (code !== '235') return done(new Error('认证失败（检查授权码）: ' + line));
              send(`MAIL FROM:<${cfg.user}>`);
              step = 5;
              break;
            case 5:
              if (code !== '250') return done(new Error('MAIL FROM 失败: ' + line));
              send(`RCPT TO:<${mail.to}>`);
              step = 6;
              break;
            case 6:
              if (code !== '250' && code !== '251') return done(new Error('RCPT TO 失败: ' + line));
              send('DATA');
              step = 7;
              break;
            case 7:
              if (code !== '354') return done(new Error('DATA 被拒: ' + line));
              send(mail.raw);
              send('.');
              step = 8;
              break;
            case 8:
              if (code !== '250') return done(new Error('邮件被拒: ' + line));
              send('QUIT');
              step = 9;
              break;
            case 9:
              return done(null);
            default:
              return done(null);
          }
        } catch (e) {
          done(e);
        }
      }
    });

    sock.on('error', (e) => done(e));
    sock.on('timeout', () => done(new Error('SMTP 超时')));
  });
}

/** 组装 RFC 5322 邮件（UTF-8 base64 正文） */
function buildMail(cfg, subject, body) {
  const encSubject = '=?UTF-8?B?' + Buffer.from(subject, 'utf-8').toString('base64') + '?=';
  const boundary = '----udl' + crypto.randomBytes(8).toString('hex');

  const raw = [
    `From: "UnifiedDownloader" <${cfg.user}>`,
    `To: <${cfg.to}>`,
    `Subject: ${encSubject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body, 'utf-8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n');

  return { to: cfg.to, raw };
}

// ───────────────────── 对外接口 ─────────────────────
/**
 * 收集环境信息（已脱敏）
 */
export function collectEnvInfo(extra = {}) {
  const info = {
    time: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    osRelease: (() => { try { return os.release(); } catch { return '?'; } })(),
    cpus: (() => { try { return os.cpus().length; } catch { return 0; } })(),
    memGB: (() => { try { return Math.round(os.totalmem() / 1024 ** 3); } catch { return 0; } })(),
    ...extra,
  };
  return info;
}

/**
 * 上报一次错误。**永不抛异常**（调用方不需要 try/catch）。
 *
 * @param {object} opts
 *   kind     错误类别（如 'crash' | 'manual' | 'engine-fail'）
 *   message  错误摘要
 *   detail   详细日志（会被脱敏并截断）
 *   extra    附加字段
 * @returns {Promise<{sent:boolean, reason?:string}>}
 */
export async function reportError(opts = {}) {
  try {
    const cfg = loadConfig();
    if (!cfg) return { sent: false, reason: 'no-config' };

    if (!checkAndBumpRate()) return { sent: false, reason: 'rate-limited' };

    const kind = opts.kind || 'error';
    const msg = sanitize(opts.message || '(无摘要)');
    const detail = sanitize(String(opts.detail || '')).slice(0, 20000);

    const env = collectEnvInfo(opts.extra || {});
    const body = [
      '=== 统一下载器 错误报告 ===',
      '',
      '【类型】' + kind,
      '【摘要】' + msg,
      '',
      '【环境】',
      ...Object.entries(env).map(([k, v]) => `  ${k}: ${v}`),
      '',
      '【详细日志】',
      detail || '(无)',
      '',
      '---',
      '本邮件由客户端自动发送，已自动脱敏（路径/邮箱/卡密/cookie）。',
    ].join('\n');

    const mail = buildMail(cfg, `[下载器错误] ${kind} - ${msg.slice(0, 60)}`, body);
    await smtpSend(cfg, mail);
    return { sent: true };
  } catch (e) {
    // 上报失败绝不能影响主流程
    return { sent: false, reason: e.message };
  }
}

/** 配置文件是否存在（UI 用来决定要不要显示"发送报告"按钮） */
export function isReportConfigured() {
  return loadConfig() !== null;
}

/** 供测试：绕过频率限制直接发一封 */
export async function reportErrorForce(opts = {}) {
  const cfg = loadConfig();
  if (!cfg) return { sent: false, reason: 'no-config' };
  const body = [
    '=== 测试邮件 ===',
    '时间: ' + new Date().toISOString(),
    '摘要: ' + sanitize(opts.message || 'test'),
    '',
    sanitize(String(opts.detail || '')),
  ].join('\n');
  const mail = buildMail(cfg, '[下载器] 测试邮件', body);
  try {
    await smtpSend(cfg, mail);
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}
