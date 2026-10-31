/**
 * doc-export.mjs — 把抓到的正文导出成 md / txt / docx
 *
 * 为什么自己实现 docx 而不是装库：
 *   1. 走 SEA 单文件打包，装第三方库会让包变大且容易踩动态 require 的坑
 *   2. .docx 本质就是一个 zip + 几个固定 XML，自己拼完全可控
 *   3. 中文只用到基础样式，不需要 OOXML 的高级特性
 *
 * 支持：
 *   toMarkdown(content)  原样（知乎那边已经产出 md 了）
 *   toText(content)      md → 纯文本（去掉 # * ` > 这些标记，保留段落）
 *   toDocx(content, meta) md → docx（标题/段落/加粗/斜体/列表/引用/代码/图片占位）
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

// ───────────────────── md → 纯文本 ─────────────────────
/**
 * 去掉 Markdown 语法，保留可读的文字结构。
 * 不追求完美还原，目标是"用记事本能读、能搜索"。
 */
export function toText(md) {
  let s = String(md || '');

  // 代码块：保留内容，去掉围栏
  s = s.replace(/^```[^\n]*\n([\s\S]*?)```$/gm, (_, code) => code);

  // 图片：保留替代文字或 URL
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => (alt ? `[图片: ${alt}]` : `[图片: ${url}]`));

  // 链接：[文字](url) → 文字 (url)
  s = s.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (_, t, u) => (t ? `${t} (${u})` : u));

  // 标题：# 去掉
  s = s.replace(/^#{1,6}\s+/gm, '');

  // 引用：> 去掉但保留缩进
  s = s.replace(/^>\s?/gm, '');

  // 列表：- / * / 1. 换成 · 或保留数字
  s = s.replace(/^\s*[-*+]\s+/gm, '· ');
  s = s.replace(/^\s*(\d+)\.\s+/gm, '$1. ');

  // 加粗/斜体/删除线/行内代码
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '$1');
  s = s.replace(/\*\*(.+?)\*\*/g, '$1');
  s = s.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '$1');
  s = s.replace(/~~(.+?)~~/g, '$1');
  s = s.replace(/`([^`]+)`/g, '$1');

  // 分隔线
  s = s.replace(/^\s*(---+|\*\*\*+|___+)\s*$/gm, '');

  // 表格：竖线变空格
  s = s.replace(/^\|(.+)\|$/gm, (_, row) =>
    row.split('|').map((c) => c.trim()).filter(Boolean).join('  ')
  );
  s = s.replace(/^\s*\|?[\s:-]+\|[\s:|-]*$/gm, '');

  // 压缩多余空行
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim() + '\n';
}

// ───────────────────── md → docx ─────────────────────
/**
 * 极简 docx 生成器。
 *
 * docx = zip 包，必须包含：
 *   [Content_Types].xml
 *   _rels/.rels
 *   word/document.xml        ← 正文
 *   word/styles.xml          ← 样式定义（标题层级要用它）
 *   docProps/core.xml        ← 可选元数据
 *
 * 这里手写 zip（不压缩，用 stored 方式）避免依赖。
 * 代价是文件略大，但几十 KB 的文档完全无感。
 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * 写一个最小可用的 zip。
 * entries: [{ name, data(Buffer) }]
 * 用 deflate 压缩（比 stored 小很多，且 zlib 是内置的）。
 */
function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf-8');
    const raw = e.data;
    const crc = crc32(raw);
    let comp = raw;
    let method = 0;
    try {
      const d = zlib.deflateRawSync(raw, { level: 9 });
      if (d.length < raw.length) { comp = d; method = 8; }
    } catch {}

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);       // 签名
    local.writeUInt16LE(20, 4);               // 版本
    local.writeUInt16LE(0x0800, 6);           // 标志：UTF-8 文件名
    local.writeUInt16LE(method, 8);           // 压缩方式
    local.writeUInt16LE(0, 10);               // 时间
    local.writeUInt16LE(0, 12);               // 日期
    local.writeUInt32LE(crc, 14);             // CRC
    local.writeUInt32LE(comp.length, 18);     // 压缩后大小
    local.writeUInt32LE(raw.length, 22);      // 原始大小
    local.writeUInt16LE(nameBuf.length, 26);  // 文件名长度
    local.writeUInt16LE(0, 28);               // extra 长度

    localParts.push(local, nameBuf, comp);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    centralParts.push(central, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }

  const localBuf = Buffer.concat(localParts);
  const centralBuf = Buffer.concat(centralParts);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(localBuf.length, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([localBuf, centralBuf, end]);
}

function xmlEsc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 一个 run（带格式的文字片段） */
function run(text, { b = false, i = false, mono = false } = {}) {
  if (!text) return '';
  const props = [];
  if (b) props.push('<w:b/>');
  if (i) props.push('<w:i/>');
  if (mono) props.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Microsoft YaHei"/>');
  const rPr = props.length ? `<w:rPr>${props.join('')}</w:rPr>` : '';
  // 文本里的换行要转成 <w:br/>
  const parts = String(text).split('\n');
  const body = parts.map((p, i2) =>
    (i2 > 0 ? '<w:br/>' : '') + `<w:t xml:space="preserve">${xmlEsc(p)}</w:t>`
  ).join('');
  return `<w:r>${rPr}${body}</w:r>`;
}

/** 一个段落 */
function para(runs, { style = null, align = null, spacingAfter = 120, indentFirst = false } = {}) {
  const pPr = [];
  if (style) pPr.push(`<w:pStyle w:val="${style}"/>`);
  if (align) pPr.push(`<w:jc w:val="${align}"/>`);
  if (indentFirst) pPr.push('<w:ind w:firstLine="480"/>');
  pPr.push(`<w:spacing w:after="${spacingAfter}" w:line="360" w:lineRule="auto"/>`);
  return `<w:p><w:pPr>${pPr.join('')}</w:pPr>${runs}</w:p>`;
}

/** 解析行内格式（**粗** *斜* `代码`） */
function parseInline(text) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(run(text.slice(last, m.index)));
    const tok = m[0];
    if (tok.startsWith('**')) out.push(run(tok.slice(2, -2), { b: true }));
    else if (tok.startsWith('`')) out.push(run(tok.slice(1, -1), { mono: true }));
    else out.push(run(tok.slice(1, -1), { i: true }));
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(run(text.slice(last)));
  return out.join('');
}

/**
 * 把 Markdown 转成 WordprocessingML 正文。
 * 支持：h1-h3、普通段落、有序/无序列表、引用、代码块、分隔线、图片占位
 */
function mdToBody(md) {
  const lines = String(md || '').split(/\r?\n/);
  const out = [];
  let inCode = false;

  for (let raw of lines) {
    const line = raw.replace(/\s+$/, '');

    // 代码块围栏
    if (/^```/.test(line)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(para(run(line || ' ', { mono: true }), { spacingAfter: 0 }));
      continue;
    }

    if (!line.trim()) { out.push(para('')); continue; }

    // 标题
    let m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      const lv = Math.min(3, m[1].length);   // docx 用 Heading1-3 足够
      out.push(para(parseInline(m[2]), { style: `Heading${lv}`, spacingAfter: 160 }));
      continue;
    }

    // 分隔线
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      out.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:color="CCCCCC"/></w:pBdr></w:pPr></w:p>');
      continue;
    }

    // 引用
    m = line.match(/^>\s?(.*)$/);
    if (m) {
      out.push(para(parseInline(m[1]), { style: 'Quote' }));
      continue;
    }

    // 无序列表
    m = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (m) {
      out.push(para(run('• ') + parseInline(m[2]), { spacingAfter: 60 }));
      continue;
    }

    // 有序列表
    m = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (m) {
      out.push(para(run(m[2] + '. ') + parseInline(m[3]), { spacingAfter: 60 }));
      continue;
    }

    // 图片：docx 里内嵌图片要写 relationship，太重；先用占位文字标明
    m = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (m) {
      out.push(para(run(`[图片] ${m[1] || ''} ${m[2]}`, { i: true }), { align: 'center', spacingAfter: 160 }));
      continue;
    }

    // 普通段落
    out.push(para(parseInline(line), { indentFirst: true }));
  }
  return out.join('');
}

/** 样式表：定义 Heading1-3 / Quote / Normal */
function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr>
      <w:rFonts w:ascii="Segoe UI" w:hAnsi="Segoe UI" w:eastAsia="Microsoft YaHei"/>
      <w:sz w:val="22"/><w:szCs w:val="22"/>
    </w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="360" w:after="180"/><w:outlineLvl w:val="0"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="280" w:after="140"/><w:outlineLvl w:val="1"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading3">
    <w:name w:val="heading 3"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="220" w:after="120"/><w:outlineLvl w:val="2"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Quote">
    <w:name w:val="Quote"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:ind w:left="480"/><w:pBdr><w:left w:val="single" w:sz="18" w:color="DDDDDD" w:space="8"/></w:pBdr></w:pPr>
    <w:rPr><w:color w:val="666666"/></w:rPr>
  </w:style>
</w:styles>`;
}

/**
 * 生成 docx。
 * @param {string} md  正文（Markdown）
 * @param {object} meta { title, author, source, capturedAt, stats }
 * @returns {Buffer}
 */
export function toDocx(md, meta = {}) {
  const bodyParts = [];

  // 标题
  if (meta.title) {
    bodyParts.push(para(run(meta.title), { style: 'Heading1', align: 'center', spacingAfter: 240 }));
  }

  // 元信息块
  const infoLines = [];
  if (meta.author) infoLines.push(`作者：${meta.author}`);
  if (meta.source) infoLines.push(`来源：${meta.source}`);
  if (meta.capturedAt) infoLines.push(`抓取时间：${meta.capturedAt}`);
  if (meta.stats) infoLines.push(`字数：${meta.stats.chars}　图片：${meta.stats.images}`);
  for (const l of infoLines) {
    bodyParts.push(para(run(l, { i: true }), { align: 'center', spacingAfter: 60 }));
  }
  if (infoLines.length) {
    bodyParts.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:color="BBBBBB"/></w:pBdr></w:pPr></w:p>');
  }

  // 正文
  bodyParts.push(mdToBody(md));

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${bodyParts.join('')}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${xmlEsc(meta.title || '')}</dc:title>
  <dc:creator>${xmlEsc(meta.author || '统一下载器')}</dc:creator>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;

  return makeZip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf-8') },
    { name: '_rels/.rels', data: Buffer.from(rels, 'utf-8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf-8') },
    { name: 'word/styles.xml', data: Buffer.from(stylesXml(), 'utf-8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(docRels, 'utf-8') },
    { name: 'docProps/core.xml', data: Buffer.from(core, 'utf-8') },
  ]);
}

/** 按格式导出。返回写入的文件路径。 */
export async function exportAs(format, md, outDir, baseName, meta) {
  await fsp.mkdir(outDir, { recursive: true });
  const fmt = String(format || 'md').toLowerCase();

  if (fmt === 'docx') {
    const dest = path.join(outDir, baseName + '.docx');
    const buf = toDocx(md, meta);
    await fsp.writeFile(dest, buf);
    return { dest, bytes: buf.length, format: 'docx' };
  }
  if (fmt === 'txt') {
    const dest = path.join(outDir, baseName + '.txt');
    const body = toText(md);
    await fsp.writeFile(dest, body, 'utf-8');
    return { dest, bytes: Buffer.byteLength(body), format: 'txt' };
  }
  const dest = path.join(outDir, baseName + '.md');
  await fsp.writeFile(dest, md, 'utf-8');
  return { dest, bytes: Buffer.byteLength(md), format: 'md' };
}
