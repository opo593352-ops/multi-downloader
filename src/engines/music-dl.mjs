#!/usr/bin/env node
/**
 * music-dl.mjs — 网络音乐聚合下载器（货比三家）
 *
 * 同时搜索 酷我 / QQ音乐 / 网易云，解析直链、探测文件大小，
 * 横评对比后择优下载。全程纯 HTTP，不需要浏览器。
 *
 * 用法：
 *   node music-dl.mjs search "雨爱"
 *   node music-dl.mjs search "雨爱" --limit 5
 *   node music-dl.mjs get "雨爱" --best
 *   node music-dl.mjs get "雨爱" --platform kuwo
 *   node music-dl.mjs get "雨爱" --pick 2 --out D:\music
 *   node music-dl.mjs search "雨爱" --json
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { assertFeature } from '../dev/gate.mjs';
import { fetchMusicMeta } from './music-meta.mjs';

import { downloadFile as dlDownload } from '../dev/dl.mjs';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const OUT_DEFAULT = path.join(os.homedir(), 'Downloads', 'Music');

// 接口域名拆开写：二进制里不出现完整明文
const KW_HOST = 'antiserver' + '.kuwo.cn';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const warn = (...a) => console.error('[warn]', ...a);

// ───────────────────────── Cookie 罐 ─────────────────────────
class Jar {
  constructor() { this.m = new Map(); }
  absorb(res) {
    let list = [];
    try {
      list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    } catch { list = []; }
    for (const raw of list) {
      const first = String(raw).split(';')[0];
      const i = first.indexOf('=');
      if (i > 0) this.m.set(first.slice(0, i).trim(), first.slice(i + 1).trim());
    }
  }
  header() { return [...this.m].map(([k, v]) => `${k}=${v}`).join('; '); }
  get size() { return this.m.size; }
}

// ───────────────────────── HTTP 基础 ─────────────────────────
async function httpGet(url, opts = {}) {
  const headers = { 'User-Agent': UA, Accept: '*/*', ...(opts.headers || {}) };
  if (opts.referer) headers.Referer = opts.referer;
  if (opts.jar) {
    const c = opts.jar.header();
    if (c) headers.Cookie = c;
  }
  const res = await fetch(url, {
    headers,
    redirect: opts.redirect || 'follow',
    signal: AbortSignal.timeout(opts.timeout || 20000),
  });
  if (opts.jar) opts.jar.absorb(res);
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, buf, url: res.url, headers: res.headers, location: res.headers.get('location') };
}

async function getText(url, opts = {}) {
  const r = await httpGet(url, opts);
  return { ...r, text: r.buf.toString('utf-8') };
}

async function getJson(url, opts = {}) {
  const r = await getText(url, opts);
  try {
    return { ...r, json: JSON.parse(r.text) };
  } catch (e) {
    throw new Error(`JSON 解析失败: ${e.message} | 前120字: ${r.text.slice(0, 120)}`);
  }
}

/** 探测远程文件大小（HEAD，失败回退 Range GET） */
async function probeSize(url, referer) {
  const h = { 'User-Agent': UA, Accept: '*/*' };
  if (referer) h.Referer = referer;
  try {
    const r = await fetch(url, { method: 'HEAD', headers: h, signal: AbortSignal.timeout(12000) });
    const len = r.headers.get('content-length');
    if (r.ok && len) return { size: Number(len), type: r.headers.get('content-type') || '' };
  } catch {}
  try {
    const r = await fetch(url, {
      headers: { ...h, Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(12000),
    });
    const cr = r.headers.get('content-range');
    if (cr) {
      const m = cr.match(/\/(\d+)/);
      if (m) return { size: Number(m[1]), type: r.headers.get('content-type') || '' };
    }
    const len = r.headers.get('content-length');
    if (r.ok && len) return { size: Number(len), type: r.headers.get('content-type') || '' };
  } catch {}
  return { size: 0, type: '' };
}

// ───────────────────────── 工具 ─────────────────────────
function clean(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeName(s, max = 80) {
  return String(s || 'music')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function fmtSize(b) {
  if (!b) return '-';
  if (b > 1024 ** 2) return (b / 1024 ** 2).toFixed(2) + ' MB';
  return (b / 1024).toFixed(0) + ' KB';
}

/**
 * 读 mp4/m4a 的时长（秒）。读不到返回 0。
 * 用于判断"试听片段"到底是不是真片段 —— 酷我 format=aac&s=30 实测无效，
 * 返回的仍是完整音源（只是码率低、体积小），必须按时长判定。
 */
function mp4DurationSec(buf) {
  try {
    const i = buf.indexOf(Buffer.from('mvhd'));
    if (i < 0) return 0;
    const ver = buf[i + 4];
    let ts, du;
    if (ver === 0) {
      ts = buf.readUInt32BE(i + 16);
      du = buf.readUInt32BE(i + 20);
    } else {
      ts = buf.readUInt32BE(i + 24);
      du = Number(buf.readBigUInt64BE(i + 28));
    }
    if (!ts) return 0;
    return du / ts;
  } catch {
    return 0;
  }
}

function msToDur(ms) {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 标题归一化，用于跨平台匹配同一首歌 */
function normTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\(.*?\)|（.*?）|\[.*?\]|【.*?】/g, '')
    .replace(/[\s\-_·・.,!?'"“”‘’]/g, '')
    .trim();
}

// ───────────────────────── 酷我 ─────────────────────────
async function searchKuwo(keyword, limit = 5) {
  const q = encodeURIComponent(keyword);
  const url =
    `http://search.kuwo.cn/r.s?all=${q}&ft=music&itemset=web_2013&client=kt` +
    `&pn=0&rn=${limit}&rformat=json&encoding=utf8`;
  const r = await getText(url, { referer: 'http://www.kuwo.cn/' });
  const txt = r.text.replace(/'/g, '"');
  let j;
  try { j = JSON.parse(txt); } catch { throw new Error('酷我返回格式异常'); }
  const list = j.abslist || [];
  return list.map((s) => ({
    platform: 'kuwo',
    platformName: '酷我',
    id: s.MUSICRID || '',
    title: clean(s.SONGNAME),
    artist: clean(s.ARTIST),
    album: clean(s.ALBUM),
    duration: msToDur(Number(s.DURATION) * 1000),
  }));
}

async function resolveKuwo(song) {
  const url =
    `http://${KW_HOST}/anti.s?type=convert_url&format=mp3&response=url&rid=${encodeURIComponent(song.id)}`;
  const r = await getText(url, { referer: 'http://www.kuwo.cn/' });
  const link = r.text.trim();
  if (!/^https?:\/\//.test(link)) throw new Error('酷我未返回直链');
  const { size, type } = await probeSize(link, 'http://www.kuwo.cn/');

  // 试听片段：实测 format=aac&s=30 并不截断，返回的是低码率完整音源。
  // 所以这里只探测时长，让上层用「时长 < 60s」来判定是否真片段。
  let previewUrl = null;
  let previewSize = 0;
  let previewDur = 0;
  try {
    const pUrl =
      `http://${KW_HOST}/anti.s?type=convert_url&format=aac&response=url` +
      `&rid=${encodeURIComponent(song.id)}&f=ar&s=30`;
    const pr = await getText(pUrl, { referer: 'http://www.kuwo.cn/' });
    const pl = pr.text.trim();
    if (/^https?:\/\//.test(pl)) {
      const ps = await probeSize(pl, 'http://www.kuwo.cn/');
      previewUrl = pl;
      previewSize = ps.size;
      // 拉前 256KB 解析 mvhd 拿时长
      try {
        const head = await fetch(pl, {
          headers: { 'User-Agent': UA, Referer: 'http://www.kuwo.cn/', Range: 'bytes=0-262143' },
          signal: AbortSignal.timeout(12000),
        });
        const buf = Buffer.from(await head.arrayBuffer());
        previewDur = mp4DurationSec(buf);
      } catch {}
    }
  } catch {}

  return {
    url: link, size, type: type || 'audio/mpeg', ext: 'mp3',
    referer: 'http://www.kuwo.cn/',
    previewUrl, previewSize, previewExt: 'm4a', previewDur,
  };
}

// ───────────────────────── QQ 音乐 ─────────────────────────
async function searchQQ(keyword, limit = 5) {
  const q = encodeURIComponent(keyword);
  const url = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=${limit}&w=${q}&format=json`;
  const r = await getJson(url, { referer: 'https://y.qq.com/' });
  const list = (r.json.data && r.json.data.song && r.json.data.song.list) || [];
  return list.map((s) => ({
    platform: 'qq',
    platformName: 'QQ音乐',
    id: s.songmid,
    title: clean(s.songname),
    artist: clean((s.singer || []).map((x) => x.name).join('/')),
    album: clean(s.albumname),
    duration: msToDur(Number(s.interval) * 1000),
  }));
}

async function resolveQQ(song, jar) {
  // vkey 需要一枚 y.qq.com 的 cookie，没有就先取
  if (!jar.size) {
    try { await httpGet('https://y.qq.com/', { jar }); } catch {}
  }
  const body = {
    req_0: {
      module: 'vkey.GetVkeyServer',
      method: 'CgiGetVkey',
      param: {
        guid: '7332953976',
        songmid: [song.id],
        songtype: [0],
        uin: '0',
        loginflag: 1,
        platform: '20',
      },
    },
    comm: { uin: '0', format: 'json', ct: 24, cv: 0, platform: '20' },
  };
  const u =
    'https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&data=' +
    encodeURIComponent(JSON.stringify(body));
  const r = await getJson(u, { referer: 'https://y.qq.com/', jar });
  const data = r.json.req_0 && r.json.req_0.data;
  if (!data) throw new Error('QQ 接口无数据');
  const mi = (data.midurlinfo || [])[0] || {};
  if (!mi.purl) throw new Error(`QQ 无权限 (result=${mi.result})`);
  const sip = (data.sip || ['https://aqqmusic.tc.qq.com/'])[0].replace(/^http:/, 'https:');
  const link = sip + mi.purl;
  const { size, type } = await probeSize(link, 'https://y.qq.com/');
  const ext = /\.m4a/i.test(mi.purl) ? 'm4a' : 'mp3';
  // QQ 没有独立片段接口，试听复用同一音源（UI 侧限时 30 秒）
  return {
    url: link, size, type: type || 'audio/mp4', ext,
    referer: 'https://y.qq.com/',
    previewUrl: link, previewSize: size, previewExt: ext,
  };
}

// ───────────────────────── 网易云 ─────────────────────────
async function searchNetease(keyword, limit = 5) {
  const q = encodeURIComponent(keyword);
  const url = `https://music.163.com/api/search/get/web?s=${q}&type=1&limit=${limit}&offset=0`;
  const r = await getJson(url, { referer: 'https://music.163.com/' });
  const list = (r.json.result && r.json.result.songs) || [];
  return list.map((s) => ({
    platform: 'netease',
    platformName: '网易云',
    id: String(s.id),
    title: clean(s.name),
    artist: clean((s.artists || []).map((x) => x.name).join('/')),
    album: clean(s.album && s.album.name),
    duration: msToDur(Number(s.duration) || 0),
  }));
}

async function resolveNetease(song) {
  const outer = `https://music.163.com/song/media/outer/url?id=${song.id}.mp3`;
  const r = await httpGet(outer, { referer: 'https://music.163.com/' });
  const finalUrl = r.url || outer;
  if (/\/404/.test(finalUrl)) throw new Error('网易云该曲需登录或已下架');
  if (!/\.(mp3|m4a|flac)/i.test(finalUrl)) throw new Error('网易云未给出直链');
  const { size, type } = await probeSize(finalUrl, 'https://music.163.com/');

  // 网易云没有官方片段接口，试听就用完整直链的前 30 秒
  // （UI 侧用 <audio> 播，靠 currentTime 限制时长）
  return {
    url: finalUrl, size, type: type || 'audio/mpeg', ext: 'mp3',
    referer: 'https://music.163.com/',
    previewUrl: finalUrl, previewSize: size, previewExt: 'mp3',
  };
}

// ───────────────────────── 酷狗 ─────────────────────────

/**
 * 酷狗的坑（实测 2026-10-29）
 * ─────────────────────────────────────────────
 * 搜索接口很宽松，两个都能用：
 *   mobilecdn.kugou.com/api/v3/search/song      → data.info[]
 *   songsearch.kugou.com/song_search_v2         → data.lists[]
 *
 * 但**直链有版权墙**：
 *   m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=<hash>
 *   → 免费歌（privilege=0, pay_type=0）：url 有值，能直接下
 *   → 付费/版权歌（privilege=10, pay_type=2|3）：url 为空字符串
 *
 * 实测样本：
 *   「两只老虎-儿童儿歌」 priv=0  pay=0 → ✓ 拿到 sharefs.kugou.com 直链
 *   「雨爱」杨丞琳        priv=10 pay=3 → ✗ url 为空
 *   「小星星」多首        priv=10 pay=2 → ✗ url 为空
 *
 * 所以酷狗的定位是「**补充源**」：能下的下，不能下的老实标"受限"，
 * 不要伪装成失败（那会让用户以为程序坏了，实际是版权限制）。
 * 这也正好补上另外三家的盲区——儿歌、翻唱、老歌常有免费源。
 */
const KG_HOST = 'mobilecdn.kugou.com';

async function searchKugou(keyword, limit = 5) {
  const q = encodeURIComponent(keyword);
  const url =
    `http://${KG_HOST}/api/v3/search/song?format=json` +
    `&keyword=${q}&page=1&pagesize=${Math.max(limit, 5)}&showtype=1`;

  // ⚠ getJson 返回 { ...响应, json: 解析结果 }，必须读 .json，
  //   不能把这个包装对象当成 JSON 本身用（写错会静默返回空数组，
  //   表现就是"酷狗一条都不出现"，而且不报错 —— 极难查）。
  const r = await getJson(url, { referer: 'http://www.kugou.com/' });
  const list = (r.json.data && r.json.data.info) || [];
  if (!list.length) return [];

  return list.slice(0, limit).map((s) => {
    // 文件名形如「杨丞琳 - 雨爱【…】」，拆成歌名+歌手更整齐
    const raw = String(s.filename || s.songname || '').replace(/\[[^\]]*\]/g, '').trim();
    let title = clean(s.songname);
    let artist = clean(s.singername);
    if (!artist && raw.includes(' - ')) {
      const [a, b] = raw.split(' - ');
      artist = clean(a);
      if (!title) title = clean(b);
    }
    return {
      platform: 'kugou',
      platformName: '酷狗',
      id: s.hash || '',
      // 320k 的 hash 和 128k 不同，单独留着
      hash320: (s['320hash'] || '').toLowerCase(),
      title: title || clean(raw),
      artist,
      album: clean(s.album_name),
      duration: msToDur(Number(s.duration) * 1000),
    };
  });
}

async function resolveKugou(song) {
  // ⚠ 顺序很重要：**先试主 hash（128k）**，再试 320k 的 hash。
  //
  //   实测（2026-10-29）：同一首歌，主 hash 返回 privilege=0 有直链，
  //   而 320hash 返回 privilege=10 无直链。
  //   一开始我把 320hash 排前面（想着音质优先），结果所有歌都"受限"，
  //   明明主 hash 能下 —— 这个顺序反了就等于酷狗整个平台白接。
  const hashes = [];
  if (song.id) hashes.push(String(song.id).toLowerCase());
  if (song.hash320) hashes.push(String(song.hash320).toLowerCase());

  let lastErr = '没有可用 hash';
  for (const h of hashes) {
    try {
      const r = await getJson(
        `http://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${h}`,
        { referer: 'http://m.kugou.com/' }
      );
      const j = r.json || {};          // ← 同 searchKugou：必须读 .json
      const u = j.url;
      if (!u || String(u).length < 10) {
        // privilege=10 / pay_type!=0 → 版权限制，不是接口坏了
        const priv = j.privilege;
        const pay = j.pay_type;
        lastErr = (priv === 10 || pay)
          ? '受限（酷狗版权限制，未登录拿不到直链）'
          : '酷狗没返回播放地址';
        continue;
      }
      const size = Number(j.fileSize) || 0;
      // extName 有时是空，用 URL 后缀兜底
      let ext = String(j.extName || '').replace(/^\./, '').toLowerCase();
      if (!ext) {
        const m = String(u).match(/\.(mp3|m4a|flac|aac|ogg)(\?|$)/i);
        ext = m ? m[1].toLowerCase() : 'mp3';
      }
      return {
        url: u,
        size: size || (await probeSize(u, 'http://m.kugou.com/')),
        ext,
        kbps: Number(j.bitRate) || (ext === 'flac' ? 900 : 128),
        referer: 'http://m.kugou.com/',
        previewUrl: u, previewSize: size || 0, previewExt: ext,
      };
    } catch (e) {
      lastErr = e.message;
    }
  }
  throw new Error(lastErr);
}

// ═════════════════════ VIP 兜底源（聚合 API）═════════════════════
//
// 背景：QQ 音乐对会员曲直接 result=104003 不下发文件，
//      网易云官方接口 VIP 曲也只给 trial 片段。上面四家都拿不到时，
//      走这层聚合接口拿完整音源（含 999 无损档）。
//
// 注意：这是第三方聚合服务，可用性会波动。503/超时都当"该源不可用"
//      处理，不影响其他源，也不让整单失败。

const GD_HOST = 'music-api.gdstudio.xyz';
const GD_PLATFORMS = [
  { src: 'netease', name: '网易云·VIP' },
  { src: 'joox',    name: 'JOOX' },
];

/** 带重试和退避的聚合接口请求（503 是常态，不能一次就判死） */
async function gdQuery(qs, tries = 2, timeoutMs = 8000) {
  const url = `https://${GD_HOST}/api.php?${qs}`;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await getText(url, {
        referer: 'https://music.163.com/',
        timeout: timeoutMs,
      });
      try {
        return JSON.parse(r.text);
      } catch {
        throw new Error(`聚合接口返回非 JSON: ${r.text.slice(0, 100)}`);
      }
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep(300 * (i + 1));
    }
  }
  throw lastErr || new Error('聚合接口不可用');
}

/** 搜索：在所有支持的聚合源里并发找，合并去重 */
async function searchVip(keyword, limit = 5) {
  const q = encodeURIComponent(keyword);
  const jobs = GD_PLATFORMS.map(async (p) => {
    try {
      const arr = await gdQuery(
        `types=search&source=${p.src}&name=${q}&count=${limit}&pages=1`
      );
      if (!Array.isArray(arr)) return [];
      return arr.map((it) => ({
        platform: `vip:${p.src}`,
        platformName: p.name,
        id: String(it.id),
        title: clean(it.name),
        artist: clean((it.artist || []).join('/')),
        album: clean(it.album || ''),
        duration: msToDur(Number(it.duration) * 10), // 该接口 duration 是"0.1 秒"单位
        vipSource: p.src,
      }));
    } catch {
      return [];
    }
  });
  const all = (await Promise.all(jobs)).flat();
  // 同一首歌多源命中时只留第一条，避免列表被同一首歌刷屏
  const seen = new Set();
  return all.filter((s) => {
    const k = normTitle(s.title) + '|' + normTitle(String(s.artist).split('/')[0]);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, limit);
}

/**
 * 解析直链。
 *
 * 三级画质依次回退：999（无损）→ 320 → 128。
 * 接口偶尔某一档返回空，不代表整首没了 —— 必须往下试。
 */
async function resolveVip(song) {
  const src = song.vipSource || String(song.platform).split(':')[1] || 'netease';
  const id = encodeURIComponent(song.id);
  const tiers = [
    { br: '999', ext: 'flac', kbps: 900 },
    { br: '320', ext: 'mp3',  kbps: 320 },
    { br: '128', ext: 'mp3',  kbps: 128 },
  ];

  let lastErr = '';
  for (const t of tiers) {
    try {
      const d = await gdQuery(`types=url&source=${src}&id=${id}&br=${t.br}`, 2);
      const link = d && d.url;
      const size = Number(d && d.size) || 0;
      if (!link || size < 100000) {
        lastErr = `br=${t.br} 无直链`;
        continue;
      }
      // 用真实文件头校正扩展名：接口偶尔把 flac 标成 mp3
      let ext = t.ext;
      try {
        const head = await fetch(link, {
          headers: { 'User-Agent': UA, Referer: 'https://music.163.com/', Range: 'bytes=0-11' },
          signal: AbortSignal.timeout(10000),
        });
        const buf = Buffer.from(await head.arrayBuffer());
        if (head.ok) ext = sniffAudioExt(buf) || ext;
      } catch {}

      return {
        url: link,
        size,
        type: ext === 'flac' ? 'audio/flac' : 'audio/mpeg',
        ext,
        kbps: t.kbps,
        referer: 'https://music.163.com/',
        previewUrl: link, previewSize: size, previewExt: ext,
        vipTier: t.br,
      };
    } catch (e) {
      lastErr = e.message;
    }
  }
  throw new Error(`VIP 源无直链 (${lastErr})`);
}

/** 按魔数判断真实音频格式 */
function sniffAudioExt(buf) {
  if (!buf || buf.length < 4) return '';
  if (buf[0] === 0x66 && buf[1] === 0x4c && buf[2] === 0x61 && buf[3] === 0x43) return 'flac';
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return 'mp3';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3';
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return 'm4a';
  if (buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return 'ogg';
  return '';
}

// ───────────────────────── 平台聚合 ─────────────────────────
const PLATFORMS = [
  { key: 'kuwo', name: '酷我', search: searchKuwo, resolve: resolveKuwo },
  { key: 'qq', name: 'QQ音乐', search: searchQQ, resolve: resolveQQ },
  { key: 'netease', name: '网易云', search: searchNetease, resolve: resolveNetease },
  // 酷狗已下线（2026-11）：
  //   m.kugou.com/getSongInfo  → errcode 1002「操作太频繁」（IP 级限流）
  //   wwwapi.kugou.com         → err_code 30020（要求 SSA-CODE 设备签名，
  //                              即便 privilege=0 无版权限制也不下发 play_url）
  //   trackercdn.kugou.com     → Bad key（签名算法已变）
  //   三个接口全废，留着只会让用户看到一屏"受限"。代码保留，需要时改回：
  //   { key: 'kugou', name: '酷狗', search: searchKugou, resolve: resolveKugou },
  // VIP 兜底：上面全部受限时才启用（--no-vip 可关）
  { key: 'vip', name: 'VIP兜底', search: searchVip, resolve: resolveVip, vip: true },
];

/**
 * 并行搜索各平台，任何一家挂了不影响其他。
 *
 * VIP 源不在这里搜：它是第三方聚合服务，慢且常 503，
 * 无条件并进首轮会让每次搜索都白等几秒。由 searchVipFallback
 * 按需触发（官方源全受限时）。opts.searchVip=true 可强制包含。
 */
async function searchAll(keyword, limit, opts = {}) {
  const active = PLATFORMS.filter((p) => !p.vip || opts.searchVip);
  const jobs = active.map(async (p) => {
    try {
      const songs = await p.search(keyword, limit);
      return { platform: p.key, name: p.name, ok: true, songs };
    } catch (e) {
      return { platform: p.key, name: p.name, ok: false, error: e.message, songs: [] };
    }
  });
  return Promise.all(jobs);
}

/**
 * VIP 兜底：仅在"官方源全部受限"时补一轮。
 *
 * 为什么不干脆并进 searchAll 一起搜：
 *   每多一个源就多一轮网络请求，日常搜歌 4 家官方源已经够用；
 *   VIP 源是第三方聚合服务，响应慢且会 503，无条件并进来会让
 *   每次搜索都白等几秒。按需触发才是对的。
 *
 * 性能要点（踩过）：
 *   起初是 for...await 串行查每首歌，每首又试 2 个源（每个源 3 次重试 ×
 *   退避 400/800ms）。搜"yankee doodle"这类冷门词时被拦 10+ 条，
 *   实测拖到 107 秒，UI 上看着就像卡死。
 *   现在：并发查 + 最多查 4 首 + 单首只试 2 次，把最坏情况压到 ~8 秒。
 */
async function searchVipFallback(keyword, limit, alreadyFound) {
  // 已经能下的歌就不再重复找，只补"全平台受限"的那些
  const haveTitles = new Set(
    alreadyFound.filter((s) => s.ok).map((s) => normTitle(s.title) + '|' + normTitle(String(s.artist).split('/')[0]))
  );
  const want = alreadyFound
    .filter((s) => !s.ok)
    .slice(0, 4)                       // 最多补 4 首，剩下的交给用户重搜
    .map((s) => `${s.title} ${String(s.artist).split('/')[0]}`);
  const queries = [...new Set(want)];
  if (!queries.length) return [];

  // 并发查：原来串行，10 首 = 10 轮 RTT
  const lists = await Promise.all(queries.map((q) => searchVip(q, 2).catch(() => [])));

  const out = [];
  for (let qi = 0; qi < lists.length; qi++) {
    const qTitle = normTitle(String(queries[qi]).split(' ')[0]);  // 查询串第一个词是歌名
    for (const s of lists[qi]) {
      // ⚠ 聚合接口的模糊匹配很松：搜「夜曲」会返回「月半小夜曲」「默」。
      //   不校验就直接并进列表，用户看到一堆不相干的歌，
      //   比「没有结果」更糟 —— 和交接文档里酷狗歌词那个坑同一个道理。
      //   规则：返回的歌名与查询词必须互相包含，或前缀匹配（允许 (Live)/(伴奏) 后缀）。
      const got = normTitle(s.title);
      if (!got) continue;
      const matched = got.includes(qTitle) || qTitle.includes(got)
        || got.startsWith(qTitle) || qTitle.startsWith(got);
      if (!matched) continue;

      const k = normTitle(s.title) + '|' + normTitle(String(s.artist).split('/')[0]);
      if (haveTitles.has(k)) continue;   // 官方源已能给，不重复
      haveTitles.add(k);
      out.push(s);
    }
  }
  return out;
}

function resolvePlatformKey(platform) {
  // vip:netease / vip:joox 是子源，统一映射到 'vip'
  return platform.startsWith('vip:') ? 'vip' : platform;
}

/** 对候选歌曲解析直链 + 探测大小（并行，失败标记不可用） */
async function resolveAll(songs, jar) {
  const pMap = Object.fromEntries(PLATFORMS.map((p) => [p.key, p]));
  return Promise.all(
    songs.map(async (s) => {
      const p = pMap[resolvePlatformKey(s.platform)];
      if (!p) return { ...s, ok: false, error: `未知平台 ${s.platform}` };
      try {
        const r = await p.resolve(s, jar);
        return { ...s, ok: true, ...r };
      } catch (e) {
        return { ...s, ok: false, error: e.message };
      }
    })
  );
}

// ───────────────────────── 对比展示 ─────────────────────────
function padW(str, width) {
  // 中文字符占两格
  let w = 0;
  for (const ch of str) w += /[\u4e00-\u9fa5\uff00-\uffef]/.test(ch) ? 2 : 1;
  const pad = Math.max(0, width - w);
  return str + ' '.repeat(pad);
}

function printCompare(groups) {
  const W = [8, 30, 22, 8, 10, 8];   // 平台 歌名 歌手 状态 大小 格式
  const bar = '─';
  const headLine = [
    padW('平台', W[0]), padW('歌名', W[1]), padW('歌手', W[2]),
    padW('状态', W[3]), padW('大小', W[4]), padW('格式', W[5]), '推荐',
  ].join('│ ');
  const sep = W.map((w) => bar.repeat(w + 1)).join('┼') + '┼' + bar.repeat(6);

  log(headLine);
  log(sep);

  for (const g of groups) {
    const multi = g.songs.length > 1;
    const tag = multi ? `【${g.songs[0].title}】${g.songs[0].artist}  跨 ${g.songs.length} 源对比` : '';
    if (tag) log(`▸ ${tag}`);
    for (const r of g.songs) {
      log([
        padW(r.platformName || '', W[0]),
        padW((r.title || '').slice(0, 28), W[1]),
        padW((r.artist || '').slice(0, 20), W[2]),
        padW(r.ok ? '可用' : '受限', W[3]),
        padW(r.ok ? fmtSize(r.size) : '-', W[4]),
        padW(r.ok ? (r.ext || '').toUpperCase() : '-', W[5]),
        r.best ? '★ 最优' : '',
      ].join('│ '));
    }
  }
  log(sep);
}

/**
 * 算实际码率（kbps）。
 *
 * 平台给的 size 是字节、duration 是 "3:52" 这种，两者相除才有意义。
 * 没时长的就用平台声明的码率（如果有）。
 */
function estimateKbps(item) {
  const size = Number(item.size) || 0;
  if (!size) return 0;
  let sec = 0;
  const d = String(item.duration || '');
  const m = d.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    sec = m[3] ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
               : Number(m[1]) * 60 + Number(m[2]);
  }
  if (!sec) return 0;
  // size(bytes)*8 = bits；/1000 = kbit；/sec
  return Math.round((size * 8) / 1000 / sec);
}

/**
 * 按用户指定的条件过滤。
 *
 * 设计要点：过滤发生在"解析出直链并探到大小之后"，
 * 因为格式和大小都要等 resolve 完才知道。过滤掉的不删，
 * 标成 filtered 并记录原因，这样对比表里还能看到"为什么被筛掉"。
 */
function applyFilters(rows, opts) {
  const fmts = opts.formats;
  const minKbps = opts.minKbps || 0;
  const minSizeKB = opts.minSizeKB || 0;

  const hasCond = !!(fmts || minKbps > 0 || minSizeKB > 0);

  for (const r of rows) {
    const ext = String(r.ext || '').toLowerCase().replace(/^\./, '');
    const kbps = estimateKbps(r);
    const sizeKB = Math.round((Number(r.size) || 0) / 1024);
    // 无论有没有过滤条件都算，UI 要拿来显示
    r.kbps = kbps;
    r.sizeKB = sizeKB;

    if (!hasCond) continue;

    const why = [];
    // 受限条目（不可下载）没有 ext，指定了格式要求时一并筛掉：
    // 留着它们只会让用户以为"过滤后还有一堆可选"，实际点下去都是受限。
    if (fmts && (!ext || !fmts.has(ext))) {
      why.push(`格式 ${ext || '未知/受限'} 不在 ${[...fmts].join('/')}`);
    }
    if (minKbps > 0 && (kbps === 0 || kbps < minKbps)) {
      why.push(`码率 ${kbps || '?'}kbps < ${minKbps}`);
    }
    if (minSizeKB > 0 && sizeKB < minSizeKB) why.push(`体积 ${sizeKB}KB < ${minSizeKB}KB`);

    if (why.length) {
      r.filtered = true;
      r.filterReason = why.join('；');
    }
  }
  return rows;
}

/**
 * 跨平台分组：同一首歌（标题+主歌手相同）聚成一组，组内按文件大小降序。
 * 每组第一个标 best —— 这就是"货比三家"的结论。
 */
function groupSongs(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = normTitle(r.title) + '|' + normTitle(String(r.artist).split('/')[0]);
    if (!map.has(key)) map.set(key, { key, songs: [] });
    map.get(key).songs.push(r);
  }
  const groups = [...map.values()];
  for (const g of groups) {
    // 可用的排前面，同状态按大小降序
    g.songs.sort((a, b) => {
      if (a.ok !== b.ok) return a.ok ? -1 : 1;
      return (b.size || 0) - (a.size || 0);
    });
    const firstOk = g.songs.find((s) => s.ok);
    if (firstOk) firstOk.best = true;
    g.best = firstOk || null;
  }
  // 多源可对比的组排前面，其次按组内最大体积排
  groups.sort((a, b) => {
    const am = a.songs.filter((s) => s.ok).length;
    const bm = b.songs.filter((s) => s.ok).length;
    if (am !== bm) return bm - am;
    return (b.best ? b.best.size : 0) - (a.best ? a.best.size : 0);
  });
  return groups;
}

// ───────────────────────── 下载 ─────────────────────────
async function downloadFile(url, dest, referer) {
  // 走共享实现（带空闲检测 + 断点续传），见 dev/dl.mjs。
  // ⚠ 返回 { bytes, resumed } 对象 —— 调用方是 `const { bytes } = await ...`
  //   返回裸数字会得到 bytes=undefined，日志里显示 "(-)"，不报错但很难查。
  return await dlDownload(url, dest, { referer });
}

// ───────────────────────── 命令 ─────────────────────────
async function cmdSearch(keyword, opts) {
  if (!opts.quiet) log(`\n搜索: ${keyword}  （三平台并行）\n`);
  const results = await searchAll(keyword, opts.limit, opts);

  for (const r of results) {
    if (!r.ok) warn(`  ${r.name} 搜索失败: ${r.error}`);
  }

  const all = [];
  for (const r of results) for (const s of r.songs) all.push(s);
  if (!all.length) {
    if (!opts.quiet) log('没有搜到任何结果');
    return { resolved: [], groups: [] };
  }

  if (!opts.quiet) log(`共 ${all.length} 条候选，正在解析直链并探测大小...\n`);
  const jar = new Jar();
  let resolved = await resolveAll(all, jar);

  // ── VIP 兜底：官方源全挂的曲目，用聚合源补一轮 ──
  // --no-vip 可关闭（离线/纯净模式）；歌单批量场景也可关掉省时间
  if (!opts.noVip) {
    const blocked = resolved.filter((r) => !r.ok);
    if (blocked.length && !opts.quiet) {
      log(`  ${blocked.length} 条被官方源拦截，尝试 VIP 兜底源...`);
    }
    if (blocked.length) {
      try {
        const extra = await searchVipFallback(keyword, opts.limit, resolved);
        if (extra.length) {
          if (!opts.quiet) log(`  VIP 兜底找到 ${extra.length} 条候选，解析中...`);
          const extraResolved = await resolveAll(extra, jar);
          resolved = resolved.concat(extraResolved);
        } else if (!opts.quiet) {
          log('  VIP 兜底源未找到替代（可能服务不可用或确实无版权）');
        }
      } catch (e) {
        if (!opts.quiet) warn(`  VIP 兜底失败: ${e.message}`);
      }
    }
  }

  // 先过滤，再分组：被筛掉的仍保留在 resolved 里（带 filtered 标记），
  // 但不参与"最优"评选，这样用户能看懂为什么某条不可选。
  applyFilters(resolved, opts);
  const usable = resolved.filter(r => !r.filtered);
  const dropped = resolved.length - usable.length;
  if (dropped > 0 && !opts.quiet) {
    warn(`  过滤掉 ${dropped} 条（格式/码率/体积不符合条件）`);
  }

  const groups = groupSongs(usable);

  if (opts.jsonOnly) {
    // 纯 JSON 模式：不打印表格，只给机器读
    console.log(JSON.stringify({ keyword, groups, resolved }, null, 2));
    return { resolved, groups };
  }

  printCompare(groups);

  const okCount = usable.filter((r) => r.ok).length;
  const multiSrc = groups.filter((g) => g.songs.length > 1).length;
  const multiOk = groups.filter((g) => g.songs.filter((s) => s.ok).length > 1).length;
  log(
    `\n可用 ${okCount}/${resolved.length} 条  ·  共 ${groups.length} 首歌  ·  ` +
    `${multiSrc} 首跨平台命中（其中 ${multiOk} 首有 2 个以上可下载源）`
  );

  return { resolved, groups };
}

async function cmdGet(keyword, opts) {
  const { resolved, groups } = await cmdSearch(keyword, { ...opts, jsonOnly: false });

  let target = null;
  if (opts.platform) {
    // 指定平台：全库该平台可用结果，按体积降序，取第 pick 个
    // 必须排除 filtered —— 否则 `--format m4a` 会挑到一条 MP3，
    // 用户明明设了格式限制却拿到别的格式（过滤等于失效）。
    //
    // -p vip 是"所有 VIP 子源"的合集：VIP 条目 platform 记的是 vip:netease /
    // vip:joox，直接 === 'vip' 会一条都匹配不上（踩过，报"没有可用结果"）。
    const hit = (r) => {
      if (opts.platform === 'vip') return String(r.platform).startsWith('vip:');
      return r.platform === opts.platform;
    };
    const pool = resolved
      .filter((r) => r.ok && !r.filtered && hit(r))
      .sort((a, b) => b.size - a.size);
    if (!pool.length) {
      const anyFiltered = resolved.some((r) => r.ok && r.filtered && hit(r));
      throw new Error(
        anyFiltered
          ? `${opts.platform} 的结果都不符合当前格式/码率条件（放宽 -f / --min-kbps 后重试）`
          : `${opts.platform} 没有可用结果`
      );
    }
    target = pool[Math.max(0, (opts.pick || 1) - 1)];
  } else {
    // 默认：第 pick 首歌的最优源
    const g = groups[Math.max(0, (opts.pick || 1) - 1)] || groups[0];
    target = g && g.best;
  }
  if (!target) throw new Error('没有可下载的结果');

  // --meta-only：只要歌词/封面/专辑，不下音频。
  // 剪辑时常常先要歌词打时间轴、要封面做转场，音频晚点再下。
  if (opts.meta === 'only') {
    log(`\n元数据: ${target.title} - ${target.artist}  [${target.platformName}]`);
    const name = safeName(`${target.title} - ${target.artist}`, 70);
    const r = await fetchMusicMeta(
      { platform: target.platform, id: target.id, title: target.title, artist: target.artist, album: target.album },
      opts.out,
      { baseName: name, quiet: opts.quiet }
    );
    if (r.skipped) throw new Error(`元数据获取失败: ${r.skipped}`);
    for (const k of ['lrc', 'lrcTrans', 'cover', 'meta']) {
      if (r[k]) log(`  ✓ ${path.basename(r[k])}`);
    }
    return r;
  }

  log(`\n下载: ${target.title} - ${target.artist}  [${target.platformName} ${fmtSize(target.size)}]`);
  const name = safeName(`${target.title} - ${target.artist}`, 70);
  const dest = path.join(opts.out, `${name}.${target.ext}`);
  const { bytes } = await downloadFile(target.url, dest, target.referer);
  log(`  ✓ ${path.basename(dest)} (${fmtSize(bytes)})`);

  // --meta：下载完顺带抓歌词/封面。
  // 失败**不影响音频** —— 音频已经下好了，元数据只是锦上添花，
  // 不能因为 QQ 的歌词接口抽风就把整单判失败。
  if (opts.meta) {
    try {
      const r = await fetchMusicMeta(
        { platform: target.platform, id: target.id, title: target.title, artist: target.artist, album: target.album },
        opts.out,
        { baseName: name, quiet: opts.quiet }
      );
      if (r.skipped) warn(`  元数据跳过: ${r.skipped}`);
      else for (const k of ['lrc', 'cover']) if (r[k]) log(`  ✓ ${path.basename(r[k])}`);
    } catch (e) {
      warn(`  元数据获取失败（音频已保存，不受影响）: ${e.message}`);
    }
  }

  log(`  保存到: ${dest}`);
  return dest;
}

/** 试听：把片段下到临时目录（默认 30 秒，酷我是真片段，其他平台取前 30 秒） */
async function cmdPreview(keyword, opts) {
  const { resolved, groups } = await cmdSearch(keyword, { ...opts, jsonOnly: false });

  let target = null;
  if (opts.platform) {
    const hit = (r) => (opts.platform === 'vip'
      ? String(r.platform).startsWith('vip:')
      : r.platform === opts.platform);
    const pool = resolved
      .filter((r) => r.ok && !r.filtered && hit(r))
      .sort((a, b) => b.size - a.size);
    if (!pool.length) throw new Error(`${opts.platform} 没有可试听的结果（或都被格式/码率条件筛掉了）`);
    target = pool[Math.max(0, (opts.pick || 1) - 1)];
  } else {
    const g = groups[Math.max(0, (opts.pick || 1) - 1)] || groups[0];
    target = g && g.best;
  }
  if (!target) throw new Error('没有可试听的结果');

  const pUrl = target.previewUrl || target.url;
  const pExt = target.previewExt || target.ext;
  // 真片段判定：时长 < 60 秒 才算平台给的试听片段
  const isRealClip = target.previewDur > 0 && target.previewDur < 60;

  log(`\n试听: ${target.title} - ${target.artist}  [${target.platformName}]`);
  if (isRealClip) {
    log(`  片段: ${fmtSize(target.previewSize)}，时长 ${target.previewDur.toFixed(1)} 秒`);
  } else if (target.previewDur > 0) {
    log(`  平台未提供片段，返回完整音源 ${target.previewDur.toFixed(0)} 秒 / ${fmtSize(target.previewSize)}`);
    log(`  → 下载后由播放器限制前 30 秒`);
  } else {
    log(`  片段信息未知，按完整音源下载`);
  }

  const dir = opts.previewOut || path.join(os.tmpdir(), 'music-preview');
  await fsp.mkdir(dir, { recursive: true });
  const name = safeName(`${target.title} - ${target.artist}`, 60);
  const dest = path.join(dir, `${name}_preview.${pExt}`);

  const { bytes } = await downloadFile(pUrl, dest, target.referer);
  log(`  ✓ ${path.basename(dest)} (${fmtSize(bytes)})`);
  log(`  路径: ${dest}`);
  return { dest, size: bytes, isRealClip, duration: target.previewDur, target };
}

// ───────────────────────── CLI ─────────────────────────
function printHelp() {
  console.log(`
网络音乐聚合下载器 · 货比三家

用法:
  node music-dl.mjs search  <关键词> [选项]
  node music-dl.mjs get     <关键词> [选项]
  node music-dl.mjs preview <关键词> [选项]

命令:
  search    三平台对比搜索，打印对比表
  get       下载最优（或指定平台/序号）
  preview   下载试听片段到临时目录并提示播放

选项:
  -n, --limit <n>       每平台取几条 (默认 5)
  -o, --out <dir>       保存目录 (默认 ~/Downloads/Music)
  -p, --platform <k>    指定平台: kuwo | qq | netease
      --pick <n>        选第 n 首 (默认 1)
      --preview-out <d> 试听片段目录 (默认 %TEMP%\\music-preview)
      --best            自动选最优（默认行为）
      --json            额外输出 JSON
      --jsononly        只输出 JSON（UI 用）
  -f, --format <list>   只要这些格式: mp3,m4a,flac（逗号分隔，可重复）
      --min-kbps <n>    只要码率不低于 n kbps（如 128、320）
      --min-size <n>    只要体积不小于 n KB
      --no-vip          关闭 VIP 兜底源（只查官方四家）
      --vip             歌单批量时也启用 VIP 兜底（默认关，省时间）
  -h, --help            帮助

VIP 兜底:
  官方四家（酷我/QQ/网易云/酷狗）都拿不到时，自动走第三方聚合源补一轮，
  目标曲目如果是会员专享，这里通常能拿到完整音源（含 999 无损档）。
  聚合源是第三方服务，会 503，失败只影响那一首，不影响整单。
  --no-vip 可完全关闭。

过滤说明:
  码率 = 文件体积 ÷ 时长，是估算值。平台不提供时长时该条码率记为 0，
  若同时指定了 --min-kbps 会被筛掉（避免把"算不出"当成"高码率"）。
  被筛掉的条目不会消失，会在 JSON 里标记 filtered + filterReason，
  便于排查"为什么搜到了却选不了"。

平台: 酷我 / QQ音乐 / 网易云 / 酷狗 / VIP兜底(网易云·JOOX)

示例:
  node music-dl.mjs search "雨爱"
  node music-dl.mjs get "雨爱"
  node music-dl.mjs preview "雨爱"
  node music-dl.mjs preview "雨爱" --platform kuwo
  node music-dl.mjs get "雨爱" --pick 2 -o D:\\\\music
`);
}

function parseArgs(argv) {
  const opts = {
    limit: 5, out: OUT_DEFAULT, jsonOnly: false, pick: 1,
    // 过滤条件
    formats: null,       // 允许的扩展名集合，如 new Set(['mp3','m4a'])
    minKbps: 0,          // 最低码率阈值（kbps），0 = 不过滤
    minSizeKB: 0,        // 最低体积阈值（KB），0 = 不过滤
    // 元数据（剪辑线用）：歌词 / 封面 / 专辑
    meta: false,         // true = 下载时顺带抓；'only' = 只抓元数据不下音频
  };
  const pos = [];
  let cmd = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'search' || a === 'get' || a === 'preview') { cmd = a; continue; }
    switch (a) {
      case '-n': case '--limit': opts.limit = Number(argv[++i]) || 5; break;
      case '-o': case '--out': opts.out = argv[++i]; break;
      case '-p': case '--platform': opts.platform = argv[++i]; break;
      case '--pick': opts.pick = Number(argv[++i]) || 1; break;
      case '--preview-out': opts.previewOut = argv[++i]; break;
      case '--best': opts.best = true; break;
      case '--json': opts.jsonOnly = true; break;
      case '--jsononly': opts.jsonOnly = true; opts.quiet = true; break;
      case '-f': case '--format': {
        // 支持 --format mp3,m4a 或重复 --format mp3
        const v = String(argv[++i] || '').toLowerCase();
        if (!opts.formats) opts.formats = new Set();
        for (const x of v.split(/[,\s]+/)) if (x) opts.formats.add(x.replace(/^\./,''));
        break;
      }
      case '--min-kbps': opts.minKbps = Number(argv[++i]) || 0; break;
      case '--min-size': opts.minSizeKB = Number(argv[++i]) || 0; break;
      case '--meta': opts.meta = true; break;
      case '--meta-only': opts.meta = 'only'; break;
      case '--no-vip': opts.noVip = true; break;
      case '--vip': opts.vip = true; break;
      case '-h': case '--help': opts.help = true; break;
      default:
        if (a.startsWith('-')) warn(`未知参数: ${a}`);
        else pos.push(a);
    }
  }
  return { cmd, opts, keyword: pos.join(' ').trim() };
}

async function main() {
  const { cmd, opts, keyword } = parseArgs(process.argv.slice(2));
  if (opts.help || !cmd || !keyword) { printHelp(); process.exit(opts.help ? 0 : 1); }

  if (cmd === 'search') await cmdSearch(keyword, opts);
  else if (cmd === 'get') await cmdGet(keyword, opts);
  else if (cmd === 'preview') await cmdPreview(keyword, opts);
}

// ───────────────────── 供 playlist.mjs 调用 ─────────────────────

/**
 * 「给一个歌名+歌手，下一首回来」的静默接口。
 *
 * 为什么不复用 cmdSearch：那个函数会打印三平台对比表、过滤统计、
 * 汇总行 —— 歌单批量下 200 首时会刷出几万行，完全没法看。
 *
 * 返回：
 *   { ok:true, dest, title, artist, bytes }
 *   { ok:false, skipped:'原因' }    ← 没有可用源时不算失败
 */
export async function searchAndResolve(keyword, opts = {}) {
  const limit = Math.max(1, Number(opts.limit) || 3);

  let results;
  try {
    results = await searchAll(keyword, limit, opts);
  } catch (e) {
    throw new Error(`搜索失败: ${e.message}`);
  }

  const all = [];
  for (const r of results) for (const s of r.songs) all.push(s);
  if (!all.length) return { ok: false, skipped: '搜不到这首歌' };

  const jar = new Jar();
  let resolved = await resolveAll(all, jar);

  // 歌单批量场景：一次要给几十上百首找源，VIP 兜底会把耗时翻倍，
  // 且歌单里通常没被拦的歌占多数 —— 默认只在显式要求时开。
  if (opts.vip) {
    const blocked = resolved.filter((r) => !r.ok);
    if (blocked.length) {
      try {
        const extra = await searchVipFallback(keyword, limit, resolved);
        if (extra.length) {
          const extraResolved = await resolveAll(extra, jar);
          resolved = resolved.concat(extraResolved);
        }
      } catch {}
    }
  }

  // 歌单场景默认就要"能下的，体积最大"的那条（音质最好）
  applyFilters(resolved, { formats: null, minKbps: 0, minSizeKB: 0 });
  const usable = resolved.filter((r) => r.ok && !r.filtered && r.size > 0);
  if (!usable.length) return { ok: false, skipped: '没有可用音源' };

  const target = usable.sort((a, b) => b.size - a.size)[0];

  const name = safeName(`${target.title} - ${target.artist}`, 70);
  const dest = path.join(opts.out, `${name}.${target.ext}`);

  // 已存在就当跳过（playlist 层也会查，这里双保险）
  try {
    if (fs.existsSync(dest) && !opts.force) {
      return { ok: false, skipped: '文件已存在' };
    }
  } catch {}

  const { bytes } = await downloadFile(target.url, dest, target.referer);

  // 元数据（VIP 源没有独立歌词接口，用官方网易云的 ID 兜一下）
  if (opts.meta) {
    try {
      const metaPlatform = target.vipSource || target.platform;
      const r = await fetchMusicMeta(
        { platform: metaPlatform, id: target.id, title: target.title, artist: target.artist, album: target.album },
        opts.out,
        { baseName: name, quiet: true }
      );
      if (r.lrc) log(`      + 歌词`);
      if (r.cover) log(`      + 封面`);
    } catch {}
  }

  return {
    ok: true,
    dest,
    title: target.title,
    artist: target.artist,
    bytes,
    platform: target.platformName,
    size: fmtSize(bytes),
  };
}

// ─────────────────────────── 入口 ───────────────────────────
export async function run() {
  // 功能闸门：**每个引擎自己验**，不信任上游 cli 的那一个 if。
  // 改 cli.mjs 里的 if (!activated) 只能骗过 cli，到这里照样被拦。
  assertFeature('music');
  await main();
}

function isDirectRun() {
  try {
    const entry = process.argv[1] || '';
    return /music-dl(\.mjs)?$/i.test(entry) || entry === '';
  } catch { return false; }
}

if (isDirectRun()) {
  main().catch((e) => {
    console.error('\n[致命]', e.message);
    process.exit(1);
  });
}
