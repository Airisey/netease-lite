'use strict';

/**
 * 读音频文件自己的标签（用户 m15635 第③点）。
 *
 * 为什么不再靠文件名匹配：文件名是**用户/工具起的**，跟歌本身没有约束关系。
 * `Rain.mp3` 可能是《Rain》，也可能是《Rainy Days》；反过来同一首歌在别人机器上
 * 叫 `01.mp3`、`track01.mp3`。标签才是歌自己带的身份 —— `TIT2` / `TPE1` / `TALB`
 * 里写的就是这首歌的歌名、歌手、专辑，拿它去跟接口返回的 `song.name` /
 * `artists` / `albumName` 精确比对，比猜文件名可靠得多。
 *
 * 只读需要的三个文本帧，`APIC`（封面，动辄几百 KB）直接跳过 —— 一个几千首的
 * 目录要是一个个把封面读出来，扫描会从「几秒」变成「几分钟」。
 *
 * 支持：
 *  - MP3 / ID3v2.2 / v2.3 / v2.4（`TT2`|`TIT2`、`TP1`|`TPE1`、`TAL`|`TALB`）
 *  - FLAC 的 VORBIS_COMMENT 块（`TITLE` / `ARTIST` / `ALBUM`）
 * 其它格式（m4a/wav/ogg…）返回 null，调用方退回文件名匹配。
 */

const fs = require('fs');

/** 标签区最多读这么多：正常 MP3 的文本帧几百字节，1MB 足够兜住大封面。 */
const MAX_TAG_BYTES = 1024 * 1024;

/** ID3v2 文本帧的四种编码。 */
function decodeText(buf, enc) {
  if (enc === 0) return buf.toString('latin1');
  if (enc === 3) return buf.toString('utf8');
  if (enc === 2) return buf.toString('utf16le').swap16 ? swapUtf16be(buf) : buf.toString('utf16le');
  // enc === 1：带 BOM 的 UTF-16，BOM 在正文最前面
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.slice(2).toString('utf16le');
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return swapUtf16be(buf.slice(2));
  }
  return buf.toString('utf16le');
}

/** UTF-16BE → UTF-16LE（node 只认小端）。 */
function swapUtf16be(buf) {
  const out = Buffer.from(buf);
  for (let i = 0; i + 1 < out.length; i += 2) {
    const b = out[i];
    out[i] = out[i + 1];
    out[i + 1] = b;
  }
  return out.toString('utf16le');
}

/** 去掉 NUL 结尾和首尾空白。 */
function clean(s) {
  return String(s == null ? '' : s).replace(/\u0000+$/g, '').replace(/\u0000/g, ' ').trim();
}

/** syncsafe 整数（ID3v2.4 的帧长与整个标签的长度都用它）。 */
function syncsafe(buf, at) {
  return ((buf[at] & 0x7f) << 21) | ((buf[at + 1] & 0x7f) << 14) | ((buf[at + 2] & 0x7f) << 7) | (buf[at + 3] & 0x7f);
}

/**
 * 解析 ID3v2 主体，只挑出歌名/歌手/专辑。
 *
 * 帧头 v2.3 是 `4 字节 id + 4 字节长度 + 2 字节标志`，v2.4 长度是 syncsafe，
 * v2.2 则是 `3 + 3`，且 id 只有三位（`TT2`/`TP1`/`TAL`）。
 */
function parseId3Body(buf, ver) {
  const out = { title: '', artist: '', album: '' };
  const want = ver === 2
    ? { TT2: 'title', TP1: 'artist', TAL: 'album' }
    : { TIT2: 'title', TPE1: 'artist', TALB: 'album' };
  const idLen = ver === 2 ? 3 : 4;
  const sizeLen = ver === 2 ? 3 : 4;
  const headLen = idLen + sizeLen + 2;

  let p = 0;
  while (p + headLen <= buf.length) {
    const id = buf.toString('latin1', p, p + idLen);
    // 遇到全零就是补白区，后面不会再有帧
    if (!id || id.charCodeAt(0) === 0) break;
    let size;
    if (ver === 2) {
      size = (buf[p + 3] << 16) | (buf[p + 4] << 8) | buf[p + 5];
    } else if (ver >= 4) {
      size = syncsafe(buf, p + 4);
    } else {
      size = buf.readUInt32BE(p + 4);
    }
    const bodyAt = p + headLen;
    if (size <= 0 || bodyAt + size > buf.length) break;

    const field = want[id];
    if (field) {
      const body = buf.slice(bodyAt, bodyAt + size);
      const text = clean(decodeText(body.slice(1), body[0]));
      if (text) out[field] = text;
    }
    p = bodyAt + size;
    if (out.title && out.artist && out.album) break;
  }
  return out;
}

/** MP3：读开头的 ID3v2 标签。没有就返回 null。 */
function readMp3(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(10);
    if (fs.readSync(fd, head, 0, 10, 0) < 10) return null;
    if (head.toString('latin1', 0, 3) !== 'ID3') return null;
    const ver = head[3];
    if (ver < 2 || ver > 4) return null;
    const size = syncsafe(head, 6);
    if (size <= 0) return null;
    const body = Buffer.alloc(Math.min(size, MAX_TAG_BYTES));
    fs.readSync(fd, body, 0, body.length, 10);
    return parseId3Body(body, ver);
  } finally {
    fs.closeSync(fd);
  }
}

/** FLAC：`fLaC` 之后的元数据块里找 VORBIS_COMMENT（type 4）。 */
function readFlac(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(4);
    if (fs.readSync(fd, head, 0, 4, 0) < 4) return null;
    if (head.toString('latin1') !== 'fLaC') return null;
    let at = 4;
    const blockHead = Buffer.alloc(4);
    for (let guard = 0; guard < 64; guard++) {
      if (fs.readSync(fd, blockHead, 0, 4, at) < 4) return null;
      const last = (blockHead[0] & 0x80) !== 0;
      const type = blockHead[0] & 0x7f;
      const len = (blockHead[1] << 16) | (blockHead[2] << 8) | blockHead[3];
      at += 4;
      if (type === 4) {
        const body = Buffer.alloc(Math.min(len, MAX_TAG_BYTES));
        fs.readSync(fd, body, 0, body.length, at);
        return parseVorbis(body);
      }
      at += len;
      if (last) return null;
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** VORBIS_COMMENT：`vendor_len + vendor + count + (len + "KEY=value")*`，全小端。 */
function parseVorbis(buf) {
  const out = { title: '', artist: '', album: '' };
  try {
    let p = 0;
    const vlen = buf.readUInt32LE(p); p += 4 + vlen;
    const count = buf.readUInt32LE(p); p += 4;
    for (let i = 0; i < count && p + 4 <= buf.length; i++) {
      const len = buf.readUInt32LE(p); p += 4;
      if (p + len > buf.length) break;
      const kv = buf.toString('utf8', p, p + len);
      p += len;
      const eq = kv.indexOf('=');
      if (eq <= 0) continue;
      const k = kv.slice(0, eq).toUpperCase();
      const v = clean(kv.slice(eq + 1));
      if (!v) continue;
      if (k === 'TITLE') out.title = v;
      else if (k === 'ARTIST') out.artist = v;
      else if (k === 'ALBUM') out.album = v;
    }
  } catch {
    return out;
  }
  return out;
}

/**
 * 读一个音频文件的标签。
 *
 * @returns {{title:string, artist:string, album:string}|null}
 *   `null` = 这个格式不支持或文件里根本没有标签，调用方应退回文件名匹配。
 */
function readTags(file) {
  const ext = String(file).toLowerCase().replace(/^.*(\.[^./\\]+)$/, '$1');
  try {
    if (ext === '.mp3') return readMp3(file);
    if (ext === '.flac') return readFlac(file);
  } catch {
    return null;
  }
  return null;
}

module.exports = { readTags };
