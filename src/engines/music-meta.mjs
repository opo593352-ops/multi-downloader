/**
 * music-meta.mjs — 歌词 / 封面 / 专辑信息（剪辑线用）
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么单独一个模块，不塞进 music-dl.mjs
 * ═══════════════════════════════════════════════════════════════
 *
 *   music-dl.mjs 已经 30 KB、管三平台搜索+解析+下载+过滤，再加元数据
 *   会变成"什么都干"的巨石文件，改一处要重新理解全部。
 *
 *   元数据是**独立能力**：不下载音频也能用（做视频配乐时常常只想先拿歌词
 *   和封面做时间轴），所以单独成文件、单独测。
 *
 * ═══════════════════════════════════════════════════════════════
 * 三平台各自的坑（都实测过）
 * ═══════════════════════════════════════════════════════════════
 *
 * 酷我：
 *   · 歌词  http://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=<rid>
 *     返回 lrclist[]，每项 { time, lineLyric }，time 是 "12.34" 秒字符串。
 *     **要自己转成标准 LRC 的 [mm:ss.xx] 格式**，剪辑软件才认。
 *   · 封面  http://artistpicserver.kuwo.cn/pic.web?corp=kuwo&type=url&rid=<rid>
 *     有的歌没有封面，返回 404 或 0 字节 —— 必须容忍。
 *
 * QQ 音乐：
 *   · 歌词  https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=<mid>
 *     **必须带 Referer: https://y.qq.com/**，否则返回 403。
 *     返回的 lyric 是 **HTML 实体转义 + base64**，要 decodeURIComponent
 *     再 from base64，顺序反了会得到乱码。
 *   · 封面  https://y.qq.com/n/yqq/album/<albumMid>_<n>.jpg
 *
 * 网易云：
 *   · 歌词  https://music.163.com/api/song/lyric?id=<id>&lv=1&tv=1
 *     直接给 lrc.lyric 原文，最省事。
 *   · 封面  song.al.picUrl
 *
 * ═══════════════════════════════════════════════════════════════
 * 输出约定
 * ═══════════════════════════════════════════════════════════════
 *
 *   <name>.lrc          标准 LRC，UTF-8（**不是 UTF-8 BOM**，PR/AE 都能读）
 *   <name>.cover.jpg    封面原图（不压缩，剪辑软件要高质量）
 *   <name>.meta.json    结构化元数据，给批量脚本/后续自动化用
 *
 *   文件名和音频一致（`歌名 - 歌手`），这样剪辑软件拖进去能自动配对。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const log = (...a) => console.log(...a);
const warn = (...a) => console.error('[warn]', ...a);

function safeName(s, max = 70) {
  return String(s || 'track')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim()
    .slice(0, max) || 'track';
}

async function getText(url, headers = {}, timeoutMs = 20000) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: '*/*', ...headers },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function getJson(url, headers = {}, timeoutMs = 20000) {
  const t = await getText(url, headers, timeoutMs);
  try { return JSON.parse(t); } catch { throw new Error('返回不是 JSON'); }
}

async function getBuf(url, headers = {}, timeoutMs = 30000) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'image/*,*/*;q=0.8', ...headers },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100) throw new Error(`文件过小 (${buf.length}B)`);
  return buf;
}

/** 按字节魔数判断图片格式 —— 图床经常 Content-Type 撒谎 */
function sniffImageExt(buf) {
  if (!buf || buf.length < 12) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) return 'webp';
  return 'jpg';
}

// ───────────────────── 歌词格式归一 ─────────────────────

/**
 * 把「秒数字符串」转成 LRC 的 [mm:ss.xx]
 *
 * 酷我给的是 "12.34"；有的平台给 "12.3" 或 "1234"（毫秒）。
 * 统一按「数值是秒」处理，超过 10000 的当成毫秒（防御性判断：
 * 一首歌不会超过 10000 秒 = 2.7 小时，但毫秒值轻易上万）。
 */
function toLrcTime(raw) {
  let n = Number(raw);
  if (!Number.isFinite(n) || n < 0) n = 0;
  if (n > 10000) n = n / 1000;              // 看起来是毫秒
  const m = Math.floor(n / 60);
  const s = n - m * 60;
  return `[${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}]`;
}

/**
 * 把平台原始歌词列表归一成标准 LRC。
 * @param {Array<{time:string|number, text:string}>} lines
 */
function buildLrc(lines) {
  const out = lines
    .filter((l) => l && l.text != null)
    .map((l) => `${toLrcTime(l.time)}${l.text}`);
  // 至少要有时间轴，否则不算 LRC（纯文本歌词放 .lrc 里剪辑软件不认）
  if (!out.some((l) => l.startsWith('['))) return null;
  return out.join('\n') + '\n';
}

/** 给纯文本歌词加一个 00:00 时间轴（有些平台只给文本） */
function textToLrc(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  // 已经是 LRC 就直接用
  if (/^\[\d{2}:\d{2}/m.test(t)) return t.endsWith('\n') ? t : t + '\n';
  // 否则整体挂到 00:00（不伪造时间轴，避免和音频错位）
  return `[00:00.00]${t.replace(/\r?\n/g, ' / ')}\n`;
}

// ───────────────────── 酷我 ─────────────────────

async function kuwoMeta(song) {
  const rid = String(song.id || '').replace(/^MUSIC_/, '');
  if (!rid) return null;

  const out = { platform: 'kuwo', lrc: null, cover: null, album: song.album || '' };

  // 歌词 + 曲目信息一次拿全
  try {
    const j = await getJson(
      `http://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${encodeURIComponent(rid)}`,
      { Referer: 'http://www.kuwo.cn/' }
    );
    const list = (j && j.data && j.data.lrclist) || [];
    if (list.length) {
      out.lrc = buildLrc(list.map((x) => ({ time: x.time, text: x.lineLyric })));
    }
    const info = (j && j.data && j.data.songinfo) || {};
    if (info.album) out.album = info.album;
    if (info.artist) out.artist = info.artist;
    if (info.songname) out.title = info.songname;
  } catch (e) {
    warn(`  酷我歌词失败: ${e.message}`);
  }

  // 封面
  try {
    const buf = await getBuf(
      `http://artistpicserver.kuwo.cn/pic.web?corp=kuwo&type=url&rid=${encodeURIComponent(rid)}`,
      { Referer: 'http://www.kuwo.cn/' }
    );
    out.cover = buf;
  } catch { /* 有的歌确实没封面，静默跳过 */ }

  return out;
}

// ───────────────────── QQ 音乐 ─────────────────────

async function qqMeta(song) {
  // QQ 的 id 字段是 songmid
  const mid = String(song.id || '');
  if (!mid) return null;

  const out = { platform: 'qq', lrc: null, cover: null, album: song.album || '' };
  const H = { Referer: 'https://y.qq.com/' };

  // 歌词：必须带 Referer，否则 403
  try {
    const t = await getText(
      `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg` +
      `?songmid=${encodeURIComponent(mid)}&format=json&nobase64=0&g_tk=5381`,
      H
    );
    // 返回可能是 JSONP：MusicJsonCallback({...})
    const jsonStr = t.replace(/^[^(]*\(/, '').replace(/\)\s*$/, '');
    let j;
    try { j = JSON.parse(jsonStr); } catch { j = null; }
    if (j && j.lyric) {
      // 顺序很重要：先 HTML 实体反转义，再 base64 解
      const unescaped = String(j.lyric)
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&apos;/g, "'");
      let text = '';
      try { text = Buffer.from(unescaped, 'base64').toString('utf-8'); }
      catch { text = unescaped; }
      out.lrc = textToLrc(text);
    }
  } catch (e) {
    warn(`  QQ 歌词失败: ${e.message}`);
  }

  // 封面：songmid 换 albumMid 太绕，直接用 QQ 的专辑图接口兜底
  try {
    const j = await getJson(
      `https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?songmid=${encodeURIComponent(mid)}&format=json`,
      H
    );
    const d = j && j.data && j.data[0];
    const albumMid = d && d.album && d.album.mid;
    if (albumMid) {
      const buf = await getBuf(`https://y.qq.com/music/photo_new/T002R800x800M000${albumMid}.jpg`, H);
      out.cover = buf;
      if (d.album.name) out.album = d.album.name;
    }
  } catch { /* 没封面就算了 */ }

  return out;
}

// ───────────────────── 网易云 ─────────────────────

async function neteaseMeta(song) {
  const id = String(song.id || '');
  if (!id) return null;

  const out = { platform: 'netease', lrc: null, cover: null, album: song.album || '' };
  const H = { Referer: 'https://music.163.com/' };

  try {
    const j = await getJson(
      `https://music.163.com/api/song/lyric?id=${encodeURIComponent(id)}&lv=1&tv=1`,
      H
    );
    const raw = j && j.lrc && j.lrc.lyric;
    if (raw) out.lrc = textToLrc(raw);
    if (j && j.tlyric && j.tlyric.lyric) {
      // 翻译歌词单独存，剪辑时按需叠字幕
      const tl = textToLrc(j.tlyric.lyric);
      if (tl) out.lrcTrans = tl;
    }
  } catch (e) {
    warn(`  网易云歌词失败: ${e.message}`);
  }

  try {
    const j = await getJson(
      `https://music.163.com/api/song/detail?ids=[${encodeURIComponent(id)}]`,
      H
    );
    const s = j && j.songs && j.songs[0];
    if (s) {
      // ⚠ 字段名是 **album / artists**，不是新版接口的 al / ar。
      //   `api/song/detail` 走的是老结构（实测 2026-10-28）：
      //     album: { name, picUrl, blurPicUrl, ... }
      //     artists: [{ name }, ...]
      //   用 al/ar 会全部 undefined —— 表现就是"封面永远抓不到"，
      //   而且不报错，最难查（我第一次就是这么踩的）。
      const alb = s.album || s.al || {};
      if (alb.picUrl || alb.blurPicUrl) {
        const url = String(alb.picUrl || alb.blurPicUrl).replace(/^http:/, 'https:') + '?param=800y800';
        out.cover = await getBuf(url, H);
        out.album = alb.name || out.album;
      }
      const artists = s.artists || s.ar || [];
      if (artists.length) out.artist = artists.map((a) => a.name).join(' / ');
    }
  } catch { /* 没封面就算了 */ }

  return out;
}

// ───────────────────── 酷狗 ─────────────────────

/**
 * 酷狗的歌词/封面走 getSongInfo 同一个接口（已实测可用）。
 *
 * 坑：`imgUrl` 里带 `{size}` 占位符，必须替换成具体尺寸
 *     （`{size}` 原样请求会 404）。
 *     例：http://singerimg.kugou.com/uploadpic/softhead/{size}/2025…/xxx.jpg
 *     → 换成 480 才能拿到图。
 *
 * 歌词：getSongInfo 的 `lyrics` 字段有时为空，要再打一次
 *      http://m.kugou.com/app/i/getLyrics.php?songid=<audio_id>
 *      或用 krc 接口（带时间轴）。这里优先用 lrc。
 */
async function kugouMeta(song) {
  const hash = String(song.id || '');
  if (!hash) return null;

  const out = { platform: 'kugou', lrc: null, cover: null, album: song.album || '' };
  const H = { Referer: 'http://m.kugou.com/' };

  let info = {};
  try {
    const j = await getJson(
      `http://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${encodeURIComponent(hash)}`,
      H
    );
    info = j || {};
  } catch (e) {
    warn(`  酷狗信息失败: ${e.message}`);
  }

  // 歌词：走两步接口（search → download），**必须校验匹配**
  //
  // ⚠ 酷狗的歌词搜索很宽松，传 hash 进去也会返回"最接近"的候选，
  //   哪怕完全不匹配。实测：《两只老虎》返回的是薛之谦的铃声歌词
  //   （`酷狗音乐 就是歌多`）。
  //   不校验就写入，剪辑时会对上完全不相干的歌词，比没有更糟。
  //
  //   所以：候选的 song/singer 必须和我们要的对得上，否则宁可不给歌词。
  if (!out.lrc) {
    try {
      const searchUrl =
        `https://krcs.kugou.com/search?ver=1&man=yes&client=mobi` +
        `&keyword=${encodeURIComponent(song.title || '')}` +
        `&duration=&hash=${encodeURIComponent(hash)}`;
      const sj = await getJson(searchUrl, {});
      const cands = (sj && sj.candidates) || [];

      const want = String(song.title || '').trim().toLowerCase();
      const wantArtist = String(song.artist || '').trim().toLowerCase();

      // 名字要能在候选的 song 里找到（或反过来），且不能是"酷狗音乐"这种占位
      const ok = cands.find((c) => {
        const cs = String(c.song || '').trim().toLowerCase();
        const ca = String(c.singer || '').trim().toLowerCase();
        if (!cs || cs === '酷狗音乐') return false;
        const nameHit = want && (cs.includes(want) || want.includes(cs));
        if (!nameHit) return false;
        // 有歌手信息时也要对得上（允许部分匹配，如"杨丞琳"vs"杨丞琳/某某"）
        if (wantArtist && ca && !ca.includes(wantArtist) && !wantArtist.includes(ca)) {
          return false;
        }
        return true;
      });

      if (ok) {
        const dl =
          `https://lyrics.kugou.com/download?ver=1&client=pc` +
          `&id=${encodeURIComponent(ok.id)}&accesskey=${encodeURIComponent(ok.accesskey)}` +
          `&fmt=lrc&charset=utf8`;
        const dj = await getJson(dl, {});
        if (dj && dj.content) {
          let lrc = Buffer.from(String(dj.content), 'base64').toString('utf-8');
          // 去掉 BOM，否则第一行会带 \uFEFF，剪辑软件当成歌词内容
          lrc = lrc.replace(/^\uFEFF/, '');
          // 只有带时间轴的才算 LRC
          if (/\[\d{2}:\d{2}/.test(lrc)) out.lrc = lrc.endsWith('\n') ? lrc : lrc + '\n';
        }
      }
    } catch { /* 没匹配到歌词就算了，不给错歌词 */ }
  }

  // 封面：{size} 必须替换
  const imgRaw = info.album_img || info.imgUrl || '';
  if (imgRaw) {
    // 优先专辑图（比歌手头像合适）
    const url = String(imgRaw).replace('{size}', '480').replace(/^http:/, 'https:');
    try {
      out.cover = await getBuf(url, H);
    } catch {
      // 专辑图失败就退回歌手图
      if (info.imgUrl && String(info.imgUrl) !== String(imgRaw)) {
        try {
          out.cover = await getBuf(
            String(info.imgUrl).replace('{size}', '480').replace(/^http:/, 'https:'),
            H
          );
        } catch {}
      }
    }
  }

  if (info.songName) out.title = info.songName;
  if (info.author_name) out.artist = info.author_name;
  if (info.album_name) out.album = info.album_name;

  return out;
}

// ───────────────────── 对外 ─────────────────────

const PLATFORM_META = {
  kuwo: kuwoMeta,
  qq: qqMeta,
  netease: neteaseMeta,
  kugou: kugouMeta,
};

/**
 * 抓一首歌的歌词 + 封面 + 专辑。
 *
 * @param {{platform:string, id:string, title:string, artist:string, album?:string}} song
 * @param {string} outDir 输出目录
 * @param {{quiet?:boolean, baseName?:string}} [opts]
 * @returns {Promise<{lrc?:string, cover?:string, meta?:string, album?:string, skipped?:string}>}
 */
export async function fetchMusicMeta(song, outDir, opts = {}) {
  const fn = PLATFORM_META[song && song.platform];
  if (!fn) return { skipped: `平台 ${song && song.platform} 不支持元数据` };

  const base = safeName(opts.baseName || `${song.title} - ${song.artist}`);
  await fsp.mkdir(outDir, { recursive: true });

  let m = null;
  try {
    m = await fn(song);
  } catch (e) {
    return { skipped: e.message };
  }
  if (!m) return { skipped: '平台没返回元数据' };

  const result = {};

  // 歌词
  if (m.lrc) {
    const p = path.join(outDir, `${base}.lrc`);
    // 写 UTF-8 **不带 BOM**：带 BOM 的话有些老剪辑软件会把 ﻿ 当成第一行歌词
    await fsp.writeFile(p, m.lrc, 'utf-8');
    result.lrc = p;
  }
  if (m.lrcTrans) {
    const p = path.join(outDir, `${base}.trans.lrc`);
    await fsp.writeFile(p, m.lrcTrans, 'utf-8');
    result.lrcTrans = p;
  }

  // 封面
  if (m.cover) {
    const ext = sniffImageExt(m.cover);
    const p = path.join(outDir, `${base}.cover.${ext}`);
    await fsp.writeFile(p, m.cover);
    result.cover = p;
    result.coverBytes = m.cover.length;
  }

  // 结构化元数据
  const metaObj = {
    platform: m.platform,
    platformName: { kuwo: '酷我', qq: 'QQ音乐', netease: '网易云' }[m.platform] || m.platform,
    title: m.title || song.title || '',
    artist: m.artist || song.artist || '',
    album: m.album || '',
    lyricFile: result.lrc ? path.basename(result.lrc) : null,
    coverFile: result.cover ? path.basename(result.cover) : null,
    fetchedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
  };
  const mp = path.join(outDir, `${base}.meta.json`);
  await fsp.writeFile(mp, JSON.stringify(metaObj, null, 2) + '\n', 'utf-8');
  result.meta = mp;
  result.album = metaObj.album;

  if (!opts.quiet) {
    const bits = [];
    if (result.lrc) bits.push('歌词');
    if (result.cover) bits.push(`封面 ${(result.coverBytes / 1024).toFixed(0)}KB`);
    if (result.album) bits.push(`专辑「${result.album}」`);
    log(`    + ${bits.length ? bits.join(' / ') : '无附加信息'}`);
  }

  return result;
}

/** 给 CLI 单独用：把元数据当主功能跑（不下载音频） */
export async function runMetaOnly(song, outDir, opts = {}) {
  return fetchMusicMeta(song, outDir, opts);
}
