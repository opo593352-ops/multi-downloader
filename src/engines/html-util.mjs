/**
 * html-util.mjs — HTML 文本处理工具
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么单独抽一个文件
 * ═══════════════════════════════════════════════════════════════
 *
 * 实体解码这件事，CSDN / 知乎 / 公众号 / 通用抓取都要用，
 * 但之前每个模块各写一份「&amp; → &」，只处理了五六个常见实体。
 *
 * 实测 CSDN 正文里全是数字实体：
 *   &#xff08;  → （
 *   &#xff0c;  → ，
 *
 * 不解码的结果就是「字数看着不少，显示出来全是 &#xff0c;」——
 * 交接文档里记的「CSDN 744 字偏少」半个原因就是这个。
 *
 * 这里提供一套完整的解码 + 清理，所有引擎共用。
 */

/**
 * 常见命名实体表（覆盖 HTML4 + 中文排版常用的那些）
 *
 * 不引第三方库的原因：项目是零依赖单文件分发，
 * 装 entities 那种包会让 bundle 变大，而实际用到的就这几十个。
 */
const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: '\u00a0', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009',
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  sbquo: '‚', bdquo: '„', laquo: '«', raquo: '»',
  bull: '•', middot: '·', dagger: '†', Dagger: '‡',
  sect: '§', para: '¶', deg: '°', plusmn: '±', times: '×', divide: '÷',
  frac12: '½', frac14: '¼', frac34: '¾',
  ne: '≠', le: '≤', ge: '≥', asymp: '≈', infin: '∞',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔',
  lArr: '⇐', rArr: '⇒', hArr: '⇔',
  euro: '€', pound: '£', yen: '¥', cent: '¢',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', pi: 'π', sigma: 'σ',
  omega: 'ω', mu: 'μ', lambda: 'λ', theta: 'θ',
  hearts: '♥', spades: '♠', clubs: '♣', diams: '♦',
  star: '☆', starf: '★', check: '✓', cross: '✗',
};

/**
 * 解码 HTML 实体。
 *
 * 顺序很重要：
 *   1. 先解数字实体（&#xxx; / &#xXX;）——CSDN 这类站点全是这个
 *   2. 再解命名实体
 *   3. **&amp; 必须放最后**，否则 `&amp;lt;` 会被先解成 `&lt;` 再解成 `<`，
 *      把本该显示成「&lt;」的文字变成标签。
 */
export function decodeEntities(s) {
  if (!s) return '';
  let out = String(s);

  // ── 1. 数字实体 ──
  // &#12345;  十进制
  out = out.replace(/&#(\d{1,7});?/g, (m, dec) => {
    const code = parseInt(dec, 10);
    if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return m;
    try { return String.fromCodePoint(code); } catch { return m; }
  });
  // &#x1F600; / &#X1F600;  十六进制
  out = out.replace(/&#[xX]([0-9a-fA-F]{1,6});?/g, (m, hex) => {
    const code = parseInt(hex, 16);
    if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return m;
    try { return String.fromCodePoint(code); } catch { return m; }
  });

  // ── 2. 命名实体（&amp; 单独留到最后）──
  out = out.replace(/&([a-zA-Z][a-zA-Z0-9]{1,31});/g, (m, name) => {
    if (name === 'amp') return m;              // 留给第 3 步
    if (Object.prototype.hasOwnProperty.call(NAMED, name)) return NAMED[name];
    return m;
  });

  // ── 3. &amp; 最后处理 ──
  out = out.replace(/&amp;/g, '&');

  return out;
}

/**
 * 去标签 + 解码实体 + 规整空白。
 *
 * ⚠ 先解码还是先去标签？
 *   先去标签，再解码。反过来的话 `&lt;script&gt;` 解码成 `<script>`
 *   会被当成真标签删掉，正文里的代码示例就丢了。
 */
export function htmlToText(html, opts = {}) {
  if (!html) return '';
  let s = String(html);

  // script / style 整块删掉（内容不是正文）
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');

  // 块级元素转换行
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|blockquote|pre)>/gi, '\n');

  // 去所有标签
  s = s.replace(/<[^>]+>/g, '');

  // 解码实体
  s = decodeEntities(s);

  // 行处理
  const lines = s.split('\n').map((l) => l.replace(/\u00a0/g, ' ').replace(/[ \t]+$/g, ''));
  let out = lines.join('\n');

  if (opts.keepBlank !== true) {
    out = out.replace(/\n{3,}/g, '\n\n').trim();
  }
  return out;
}

/**
 * 从 HTML 里抽取所有图片的真实地址。
 *
 * CSDN / 公众号 / 知乎都用懒加载，真实地址可能在：
 *   src / data-src / data-original / data-lazy-src / srcset
 * 而且常是 // 开头的协议相对地址。
 */
export function extractImages(html) {
  const out = [];
  const seen = new Set();
  const re = /<img([^>]*)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1];
    const pick = (name) => {
      const r = new RegExp(name + '\\s*=\\s*["\']([^"\']+)["\']', 'i');
      const mm = attrs.match(r);
      return mm ? mm[1].trim() : '';
    };
    let src = pick('data-src') || pick('data-original') || pick('data-lazy-src') || pick('src');
    if (!src) {
      // srcset: "a.png 1x, b.png 2x" —— 取第一个
      const ss = pick('srcset');
      if (ss) src = ss.split(',')[0].trim().split(/\s+/)[0];
    }
    if (!src) continue;
    if (src.startsWith('//')) src = 'https:' + src;
    if (!/^https?:/i.test(src)) continue;
    if (src.startsWith('data:')) continue;
    if (seen.has(src)) continue;
    seen.add(src);
    out.push(src);
  }
  return out;
}
