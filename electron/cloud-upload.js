'use strict';
/**
 * 把本地音频文件上传到网易云「音乐云盘」。
 *
 * 这一套流程与刚哥那边（NeteaseCloudMusicApi）的 `module/cloud.js` 一致，
 * 五步都是 /weapi/ 加密接口 + 一次 NOS 直传：
 *
 *   1. POST /weapi/cloud/upload/check   —— 报 md5 与字节数，换来 songId 与 needUpload
 *   2. POST /weapi/nos/token/alloc      —— 换 objectKey / token / resourceId
 *   3. GET  https://wanproxy.127.net/lbs —— 问上传节点（按 bucket 分配）
 *   4. POST <节点>/<bucket>/<key>?offset=0&complete=true&version=1.0
 *                                       —— 文件本体整块 PUT，头里带 x-nos-token 与 Content-MD5
 *   5. POST /weapi/upload/cloud/info/v2 —— 登记元信息（歌名/歌手/专辑/resourceId）
 *      POST /weapi/cloud/pub/v2         —— 发布，发布完列表里才有这首
 *
 * 注意：文件本体是整块发出去的（不切片），和参考实现一样 —— 云盘单曲有大小上限
 * （普通账号 200MB 上下），切片反而更容易被 NOS 判成「未 complete」。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readTags } = require('./tags.js');

const BUCKET = 'jd-musicrep-privatecloud-audio-public';
const LBS = 'https://wanproxy.127.net/lbs?version=1.0&bucketname=' + BUCKET;

/** 扩展名 -> Content-Type。NOS 只看头里的类型，写错官方客户端会当成非音频。 */
const CONTENT_TYPE = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
};

/** 允许上传的扩展名（对话框里也用这一份）。 */
const CLOUD_EXT = Object.keys(CONTENT_TYPE);

function md5Of(buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}

function baseWithoutExt(name) {
  return name.replace(/\.[^.]+$/, '');
}

/**
 * 传一个文件。
 *
 * @param {object} client  Netease 客户端（main.js 里的 `ne`）
 * @param {string} file    绝对路径
 * @param {(p:{stage:string,sent?:number,total?:number,name?:string})=>void} [onProgress]
 * @returns {Promise<{ok:boolean, songId:number, name:string}>}
 */
async function uploadOne(client, file, onProgress) {
  const name = path.basename(file);
  const buf = fs.readFileSync(file);
  const size = buf.length;
  if (!size) throw new Error('空文件');

  const md5 = md5Of(buf);
  const ext = (name.match(/\.[^.]+$/) || ['.mp3'])[0].toLowerCase();
  const type = CONTENT_TYPE[ext] || 'audio/mpeg';

  // 有标签就用标签，没有就拿文件名顶上 —— 云盘列表里显示的就是这里给的 song。
  const tags = readTags(file) || {};
  const song = tags.title || baseWithoutExt(name);
  const artist = tags.artist || '未知艺术家';
  const album = tags.album || '未知专辑';

  onProgress && onProgress({ stage: 'check', name });
  const check = await client.post('/cloud/upload/check', {
    bitrate: '999000',
    ext: '',
    length: size,
    md5,
    songId: '0',
    version: 1,
  });

  // 服务端已经有同 md5 的文件时 needUpload 为 false，省掉那次上传。
  const needUpload = check.needUpload !== false;
  const songId = check.songId || 0;

  onProgress && onProgress({ stage: 'token', name });
  const tokenRes = await client.post('/nos/token/alloc', {
    bucket: BUCKET,
    ext: ext.replace('.', ''),
    // 参考实现把文件名里的空格和点都换掉，NOS 那边会踩坑。
    filename: name.replace(/\s/g, '').replace(/\./g, '_'),
    local: false,
    nos_product: 3,
    type: 'audio',
    md5,
  });
  const token = (tokenRes && tokenRes.result) || {};
  const resourceId = token.resourceId || '';
  const objectKey = String(token.objectKey || '').replace('/', '%2F');

  if (needUpload) {
    onProgress && onProgress({ stage: 'upload', name, sent: 0, total: size });
    const lbs = await (await fetch(LBS)).json();
    const host = (lbs && lbs.upload && lbs.upload[0]) || '';
    if (!host) throw new Error('拿不到上传节点（lbs 返回空）');

    const url = `${host}/${BUCKET}/${objectKey}?offset=0&complete=true&version=1.0`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-nos-token': token.token || '',
        'Content-MD5': md5,
        'Content-Type': type,
        'Content-Length': String(size),
      },
      body: buf,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`上传失败 HTTP ${res.status}${text ? '：' + text.slice(0, 80) : ''}`);
    }
    onProgress && onProgress({ stage: 'upload', name, sent: size, total: size });
  }

  onProgress && onProgress({ stage: 'finalize', name });
  const info = await client.post('/upload/cloud/info/v2', {
    md5,
    songid: songId,
    filename: name,
    song,
    album,
    artist,
    bitrate: '999000',
    resourceId,
  });
  const newId = info.songId || songId;

  // 发布失败不算上传失败：文件已经入库，只是暂时没出现在列表里。
  if (newId) {
    try {
      await client.post('/cloud/pub/v2', { songid: newId });
    } catch {
      /* 忽略 */
    }
  }
  return { ok: true, songId: newId, name: song || name };
}

/**
 * 云盘去重用的归一化：只留「能分辨是不是同一首」的信息。
 *
 * 之所以标题和歌手都要在，是因为用户要的规则（m05942 第②点）是：
 * 标题 + 歌手**都**一样才算重复 —— 同名不同歌手（翻唱）、同歌手不同歌
 * 都必须照常传上去。所以 key 是两段拼起来的，少一段就对不上。
 */
function normKey(s) {
  return String(s == null ? '' : s)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[._\-–—~～!！?？@#$%^&*()+=[\]{};:'",<>/\\|`]/g, '');
}

/**
 * 文件名兜底解析：`歌手 - 歌名` → { artist, title }。
 *
 * 故意**不**剥掉 `(Live)` / `(feat. X)` 这类括号：用户的规则是「标题不同就要传」，
 * 把后缀抹掉会让现场版被当成录音室版直接跳过。
 */
function splitBase(base) {
  const s = String(base || '').trim();
  const i = s.indexOf(' - ');
  if (i > 0) return { artist: s.slice(0, i).trim(), title: s.slice(i + 3).trim() };
  return { artist: '', title: s };
}

/** 一个云盘条目 / 一个本地文件的去重 key。 */
function dedupeKey(artist, title) {
  return `${normKey(title)}||${normKey(artist)}`;
}

/** 本地文件 → key：优先读标签（上传时用的也是标签），读不到再退回文件名。 */
function fileKey(file) {
  const base = baseWithoutExt(path.basename(file));
  let tags = null;
  try {
    tags = readTags(file);
  } catch {
    tags = null;
  }
  if (tags && tags.title) return dedupeKey(tags.artist, tags.title);
  const p = splitBase(base);
  return dedupeKey(p.artist, p.title);
}

/**
 * 把云盘里所有歌的 key 取回来（分页拉全，最多 5000 条兜底）。
 *
 * 云盘列表一次最多 100 条，而「防重复上传」必须看全量，所以这里一直翻到
 * `hasMore` 为假或者拿到的条数追平 `count` 为止。
 */
async function cloudKeys(client, max = 5000) {
  const keys = new Set();
  let offset = 0;
  for (let guard = 0; guard < 60 && offset < max; guard++) {
    const d = await client.cloudSongs(100, offset);
    const list = (d && d.songs) || [];
    for (const s of list) {
      const artist = (s.artists || []).map((a) => a && a.name).filter(Boolean).join(' / ');
      keys.add(dedupeKey(artist, s.name));
    }
    offset += list.length;
    if (!list.length || !(d && d.more) || offset >= (d.count || 0)) break;
  }
  return keys;
}

/**
 * 串行传多个文件（并发上传会被 NOS 按账号限速，反而更慢）。
 *
 * @returns {Promise<{added:Array, failed:Array}>}
 */
async function uploadFiles(client, files, onProgress) {
  const added = [];
  const failed = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    try {
      const r = await uploadOne(client, file, (p) => onProgress && onProgress({ ...p, index: i, count: files.length }));
      added.push(r);
    } catch (e) {
      failed.push({ name: path.basename(file), message: (e && e.message) || String(e) });
    }
  }
  return { added, failed };
}

/**
 * 先把「云盘里已经有同一首（标题 + 歌手都一样）」的文件挑掉，再传剩下的。
 *
 * @returns {Promise<{added:Array, failed:Array, skipped:Array}>}
 */
async function uploadFilesSkippingDupes(client, files, onProgress) {
  let keys = new Set();
  try {
    keys = await cloudKeys(client);
  } catch {
    // 取不到云盘列表就照旧全传：宁可重复一条，也不要因为网络抖动一首都传不上去
    keys = new Set();
  }
  const keep = [];
  const skipped = [];
  for (const f of files) {
    let k = '';
    try {
      k = fileKey(f);
    } catch {
      k = '';
    }
    if (k && keys.has(k)) skipped.push(path.basename(f));
    else keep.push(f);
  }
  const out = await uploadFiles(client, keep, onProgress);
  return { ...out, skipped };
}

module.exports = { uploadOne, uploadFiles, uploadFilesSkippingDupes, cloudKeys, dedupeKey, CLOUD_EXT, CONTENT_TYPE };
