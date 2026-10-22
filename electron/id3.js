'use strict';

/**
 * 给下载下来的 MP3 写 ID3v2.3 标签（用户 m07048 第④点）。
 *
 * 起因：把「我们自己下的」和「官方 app 下的」同一首歌放在一起比，**音频载荷
 * 逐字节相同**（同为 Lavf57.71.100 转码的那一份），差的只有文件头的 ID3 标签：
 *
 * |        | 我们    | 官方                                                     |
 * | ------ | ------- | -------------------------------------------------------- |
 * | 标签大小 | 35 字节 | 54149 字节                                               |
 * | 帧     | `TSSE`  | `TSSE` `APIC` `COMM` `TALB` `TIT2` `TPE1` `TPE2` `TPOS` `TRCK` |
 *
 * 于是我们的文件拷进别的播放器（车机、随身听、Windows 资源管理器）就成了
 * 「未知歌手 / 未知专辑 / 没有封面」，而官方那份什么都对。差的不是音质，是标签。
 *
 * ## 官方 app 为什么「不认」我们的文件（用户 m11461 第①点）
 *
 * 用户把两份文件放进官方 app 的本地音乐里，官方那份显示正常，我们那份带个感叹号。
 * 根因就在 `COMM` 帧：官方写的是
 *
 * ```
 * COMM (enc=0, lang="XXX", desc="") = "163 key(Don't modify):" + base64(AES-128-ECB(json))
 * ```
 *
 * 把那段密文解出来是 **`music:{…}` 一整段元数据 JSON**（`musicId` / `musicName` /
 * `artist` 的 id 数组 / `album` / `albumPicDocId` / `bitrate` / `duration` / `gain` /
 * `alias` …）。官方 app 认「这是我自己下的文件」靠的就是这一段 —— 没有它，标签里的
 * 歌名歌手再对也没用，它只当成一个外来文件，退化成按名字模糊匹配，于是界面上显示
 * 「原 / 新」两串对不上。
 *
 * 密钥是 `#14ljk_!\]&0U<'(`（16 个 ASCII 字符，ncmdump 里用的那串）。安卓版那边
 * 曾经把它写错一个字符（`<'(` 写成 `<9(`），解出来全是随机字节，连续几轮都判定成
 * 「私有算法、破不开」—— 教训是：**换密钥之前先确认密钥本身没打错**。
 *
 * ## 为什么在下载**之前**写
 *
 * 标签必须落在文件最前面。等下完再补就得把整个文件读出来、在内存里拼一遍再写回，
 * 一首 30MB 的歌白折腾一次 IO。而标签要的信息在入队时就全有了，封面也能先单独
 * 取一张（几十 KB），所以直接**先写标签、再把音频接在后面**，一次成型。
 */

const fs = require('node:fs');
const crypto = require('node:crypto');

/**
 * 封面超过这个尺寸就不要了 —— 标签里塞一张几 MB 的图会让整首歌的打开变慢。
 *
 * 2MB 是给 1080×1080 留的余量：JPEG 那张（用户 m08537 第①点对齐官方）是
 * 155,602 B，但**有些封面源图本身是 PNG**，同尺寸能到 1MB 出头（实测
 * 《バイバイ。》那张 1080×1080 的 PNG 是 1,036,379 B）。原来卡 1MB 会把这类
 * 封面整个丢掉，症状是「大部分歌有封面，个别歌没有」。
 */
const MAX_COVER_BYTES = 2 * 1024 * 1024;

/** 官方客户端那份文件里写的编码器串，照写（原来是 Lavf57.71.100，官方是 58）。 */
const ENCODER = 'Lavf58.76.100';

/**
 * `COMM` 帧里那段密文的 AES 密钥（用户 m11461 第①点）。
 *
 * 16 个字节，全部 ASCII：`#14ljk_!\]&0U<'(`。注意里面有一个**反斜杠**和一个
 * **单引号**，在 JS 字符串里要写成 `\\` 才是真的反斜杠 —— 安卓那边第一次就是漏了
 * 这一层转义，密钥变成 15 字节、AES 直接抛错，被 catch 当成「解不出」，于是连续
 * 几轮都判定成「私有算法、破不开」。
 */
const COMM_KEY = Buffer.from("#14ljk_!\\]&0U<'(", 'latin1');

/** `COMM` 里密文的固定前缀，官方原样保留，包括那句「别改」。 */
const COMM_PREFIX = "163 key(Don't modify):";

/** 写一个帧：10 字节帧头 + 正文。 */
function frame(id, body) {
  const head = Buffer.alloc(10);
  head.write(id, 0, 4, 'latin1');
  // v2.3 的帧长度是**普通** 32 位大端整数，和标签头的 syncsafe 不一样
  // （v2.4 才统一成 syncsafe）。这里按 v2.3 写。
  head.writeUInt32BE(body.length, 4);
  head[8] = 0;  // 标志位高字节
  head[9] = 0;  // 标志位低字节
  return Buffer.concat([head, body]);
}

/**
 * 文本帧。
 *
 * ID3v2.3 的编码字节 0x01 = UTF-16 with BOM，日文/中文歌名必须走这个 ——
 * 0x00（ISO-8859-1）会把「桜海岸」写成问号。
 *
 * **结尾不补 0x00 0x00**（用户 m11461 第①点）：官方那份每个文本帧都比我们短
 * 2 字节，就是差在这里。原来写的注释是「某些车机靠它判断字符串结束」，实际对照
 * 下来官方不写、各家播放器也都读得对 —— 帧长度本来就在帧头里写着，不需要第二个
 * 结束符。
 */
function textFrame(id, value) {
  if (!value) return null;
  const body = Buffer.concat([
    Buffer.from([0x01, 0xff, 0xfe]),  // 编码 + UTF-16LE BOM
    Buffer.from(String(value), 'utf16le'),
  ]);
  return frame(id, body);
}

/**
 * 按文件头魔数判断封面格式。
 *
 * 封面统一用 `type=jpg` 从 CDN 取（见 {@link fetchCover}），所以实际几乎总是 JPEG；
 * 留 PNG/GIF/WebP 分支是为了「CDN 没按参数出图」时标签不至于说谎。
 */
function mimeOf(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  // 官方那份写 `image/jpg`（少个 e），这里跟它走 —— 用户是逐字节比的，
  // 而 `image/jpg` 虽然不在 IANA 表里，各家播放器都认。
  return 'image/jpg';
}

/** 封面帧。`cover` 是图片的原始字节，取不到就不写这一帧。 */
function coverFrame(cover) {
  if (!cover || !cover.length || cover.length > MAX_COVER_BYTES) return null;
  const body = Buffer.concat([
    Buffer.from([0x00]),                              // 编码：描述串用 ISO-8859-1
    Buffer.from(mimeOf(cover), 'latin1'),
    Buffer.from([0x00]),                              // MIME 结束
    Buffer.from([0x00]),                              // 图片类型 0 = 其他
                                                      // （官方写 0。原来我们写 3
                                                      // 「封面正面」，语义上更准，
                                                      // 但要对齐官方就得写 0）
    Buffer.from([0x00]),                              // 描述串为空，直接结束
    cover,
  ]);
  return frame('APIC', body);
}

/**
 * `COMM` 帧的内容（用户 m11461 第①点）。
 *
 * 明文是 `music:` + 一段 JSON，字段名与接口返回的一致，但**值是官方自己算的**：
 * `musicId` 是曲目 id、`artist` 是 `[[名字, id], …]` 的数组、`bitrate` 是实际码率
 * （320002 而不是 320000，差在帧头开销）、`duration` 是毫秒、`gain` 是音量增益。
 *
 * 明文末尾按 PKCS#7 补齐到 16 的倍数。密文用 AES-128-ECB 加密后 base64，再挂到
 * `163 key(Don't modify):` 后面 —— 与官方那份**逐字节相同**（同一首歌验过往返）。
 *
 * @param {object} info
 * @param {number} info.musicId
 * @param {string} info.musicName
 * @param {Array<[string, number]>} info.artists
 * @param {string} info.album
 * @param {number} info.albumId
 * @param {number} info.albumPicDocId 封面 URL 末尾那个数字，不是专辑 id
 * @param {string} info.albumPic      **http**、不带查询参数的封面地址（官方就这么写）
 * @param {number} info.mvid
 * @param {number} info.bitrate
 * @param {number} info.durationMs
 * @param {number} info.gain          接口里恒为 0，官方是它自己算的差分增益
 * @param {string[]} info.alias
 * @param {string[]} info.transNames
 * @returns {Buffer} 完整的 COMM 帧
 */
function commFrame(info) {
  const plain = Buffer.from(commJson(info), 'utf8');
  const pad = 16 - (plain.length % 16);
  const buf = Buffer.alloc(plain.length + pad, pad);
  plain.copy(buf);
  const cipher = crypto.createCipheriv('aes-128-ecb', COMM_KEY, null);
  cipher.setAutoPadding(false);
  const enc = Buffer.concat([cipher.update(buf), cipher.final()]);
  const body = Buffer.concat([
    Buffer.from([0x00]),                        // 编码 0
    Buffer.from('XXX', 'latin1'),               // 语言，官方写 XXX
    Buffer.from([0x00]),                        // 描述串为空
    Buffer.from(COMM_PREFIX, 'latin1'),
    Buffer.from(enc.toString('base64'), 'latin1'),
  ]);
  return frame('COMM', body);
}

/**
 * 拼 `COMM` 的明文 JSON。
 *
 * 手拼而不是 `JSON.stringify`：官方那份的键顺序是固定的（`format` `musicId`
 * `musicName` `artist` `album` `albumId` `albumPicDocId` `albumPic` `mvId` `flag`
 * `bitrate` `duration` `gain` `alias` `transNames`），而且**斜杠要转义成 `\/`**
 * （Java 系 JSON 库的 `escapeForwardSlash`）—— `JSON.stringify` 不转斜杠，
 * 明文长度一不同密文就完不一样了。
 */
function commJson(info) {
  const q = (s) => JSON.stringify(String(s == null ? '' : s)).replace(/\//g, '\\/');
  const arr = (list) => '[' + (list || []).map(q).join(',') + ']';
  const artists = (info.artists || []).map(([n, id]) => `[${q(n)},${id}]`).join(',');
  return 'music:{'
    + '"format":"mp3"'
    + `,"musicId":${info.musicId}`
    + `,"musicName":${q(info.musicName)}`
    + `,"artist":[${artists}]`
    + `,"album":${q(info.album)}`
    + `,"albumId":${info.albumId || 0}`
    + `,"albumPicDocId":${info.albumPicDocId || 0}`
    + `,"albumPic":${q(info.albumPic)}`
    + `,"mvId":${info.mvid || 0}`
    + ',"flag":0'
    + `,"bitrate":${info.bitrate || 0}`
    + `,"duration":${info.durationMs || 0}`
    + `,"gain":${info.gain || 0}`
    + `,"alias":${arr(info.alias)}`
    + `,"transNames":${arr(info.transNames)}`
    + '}';
}

/**
 * 生成一整段 ID3v2.3 标签。
 *
 * 帧顺序照官方的来：`TSSE` `APIC` `COMM` `TALB` `TIT2` `TPE1` `TPE2` `TPOS` `TRCK`。
 * 顺序本身不影响解析，但用户是**逐字节**跟官方比的，顺序不同会让两边的十六进制
 * 从第 40 个字节就开始分叉，看不出「到底还剩几处不一样」。
 *
 * @param {object} info
 * @param {string} info.title       歌名
 * @param {string} info.artist      歌手（多歌手用 ` / ` 分隔的整串）
 * @param {string} info.album       专辑名
 * @param {number} info.trackNo     音轨号，0 表示未知（不写帧 —— 写个 0 比不写更糟，
 *                                  播放器会显示「第 0 首」）
 * @param {number} info.discNo      碟号，0 表示未知
 * @param {Buffer|null} info.cover  封面 JPEG 字节
 * @param {object|null} info.comm   `COMM` 帧用的字段，见 {@link commFrame}；空则整帧不写
 * @param {number} [info.padding]   帧区之后补的 0，官方会补几十到两百多字节
 * @returns {Buffer}
 */
function buildTag(info) {
  // 多歌手用 `/` 直接相连、不带空格 —— 与官方客户端那份文件逐字节对齐
  // （用户 m08537 第①点：官方写 `Sihan/三Z-STUDIO/HOYO-MiX`，我们原来写
  // `Sihan / 三Z-STUDIO / HOYO-MiX`）。只影响标签，文件名模板里的 `{歌手名}`
  // 仍按 m0357 第②点用空格分隔。
  const tight = (v) => String(v == null ? '' : v).replace(/ \/ /g, '/');
  const frames = [
    textFrame('TSSE', ENCODER),
    coverFrame(info.cover),
    info.comm ? commFrame(info.comm) : null,
    // 官方把 TALB 放在 TIT2 前面，这里也照这个顺序。
    textFrame('TALB', info.album),
    textFrame('TIT2', info.title),
    textFrame('TPE1', tight(info.artist)),
    // TPE2 是「专辑艺术家」。官方那份把它写成和 TPE1 一样，多歌手时也是整串。
    textFrame('TPE2', tight(info.albumArtist || info.artist)),
    // 碟号补两位：官方写 `01` 而不是 `1`（同一份对照文件里 TRCK 是 `1`、
    // TPOS 是 `01`，它俩的补零规则本来就不一样，照抄即可）。
    //
    // 多碟合集里官方写的是**碟名原文** `disc1 万籁拂旧尘`（用户 m15041 那轮补的）：
    // 那段文字在 `/v3/song/detail` 的 `cd` 字段里就有，原样搬过来即可。
    // 判据不能只看 `discNo > 0` —— 万一碟号解析失败但碟名拿到了，照样要写这一帧，
    // 否则官方 app 下的文件在资源管理器「详细信息」里会多我们一行「集的一部分」。
    info.discNo > 0 || (info.comm && info.comm.discText)
      ? textFrame('TPOS', (info.comm && info.comm.discText) || String(info.discNo).padStart(2, '0'))
      : null,
    // TRCK / TPOS 是「当前/总数」格式，我们只知道当前值。
    info.trackNo > 0 ? textFrame('TRCK', String(info.trackNo)) : null,
  ].filter(Boolean);

  const body = Buffer.concat(frames);
  // 帧区之后补一段 0：官方两份实测 147 / 211 字节，作用是给后续修改留白。
  // 不补也能播，但逐字节比对会一直差这一段；补多少无所谓，照官方量级给 128。
  const pad = Math.min(Math.max(Number(info.padding) || 0, 0), 4096);
  const padded = pad > 0 ? Buffer.concat([body, Buffer.alloc(pad)]) : body;
  const head = Buffer.alloc(10);
  head.write('ID3', 0, 3, 'latin1');
  head[3] = 0x03;  // 主版本 3 = ID3v2.3
  head[4] = 0x00;  // 修订号
  head[5] = 0x00;  // 标志位：无扩展头、无实验位
  // 标签长度用 syncsafe 整数（每字节只放 7 位，最高位恒 0）。
  // 这是 ID3v2 的硬性规定：直接写 32 位整数的话，长度字节一旦 ≥ 0x80
  // 播放器会把它当成「非法标签」整个跳过 —— 症状是标签明明写了却读不出来。
  head[6] = (padded.length >> 21) & 0x7f;
  head[7] = (padded.length >> 14) & 0x7f;
  head[8] = (padded.length >> 7) & 0x7f;
  head[9] = padded.length & 0x7f;
  return Buffer.concat([head, padded]);
}

/**
 * 封面地址：**必须带 `type=jpg`**（用户 m11461 第①点）。
 *
 * 原来只写 `?param=1080y1080&quality=80`。对 JPEG 源图没问题（DAMIDAMI 那张
 * 与官方 `APIC` 逐字节相同），但对 **PNG 源图**就出事了：CDN 会原样给 PNG，
 * 1080×1080 能到 1.7MB，而官方那份是 168KB 的 JPEG ——
 * 玄翎谣：我们 12,894,461 B / 官方 11,299,116 B，1.6MB 全差在封面上。
 *
 * `?imageView&thumbnail=…&quality=…&type=jpg` 是又一层「强制出图格式」的参数，
 * 加上之后 PNG 源图也回 JPEG，且与官方 `APIC` **逐字节相同**（两首歌都验过）。
 * 尺寸取官方那个：1080 的框，源图小就按源图尺寸出（玄翎谣源图 1000×1000，
 * 出来的就是 1000×1000，官方也是）。
 */
function coverUrl(url) {
  if (!url) return url;
  return String(url).replace(/\?.*$/, '') + '?imageView&thumbnail=1080y1080&quality=80&type=jpg';
}

/**
 * 取封面原图，塞进 ID3 的 `APIC` 帧。
 *
 * 尺寸与质量不是拍脑袋的：用户 m08537 第①点把「我们下的」和「官方 app 下的」
 * 同一首歌逐字节比了一遍 —— 音频载荷完全相同（`sha256` 一致），差的字节几乎全在
 * 封面上：官方是 1080×1080 的 155,602 B，我们 500×500 只有 42,270 B。
 * 用户 m09508 第③点又说「官方还是更大」，于是把 CDN 的 `quality` 从 74 逐档扫到
 * 90：不带 `quality` 时 CDN 按 75 出图（135,656 B），官方那份是 **quality=80**
 * （155,602 B）—— 与官方 `APIC` 里的 JPEG 逐字节相同。
 *
 * 取不到（离线、CDN 404、图太大）就返回 `null`，只写文本帧 —— 标签少一张图远好过
 * 整个下载因为封面失败而报错。
 */
async function fetchCover(url) {
  if (!url) return null;
  // 延迟 require：`electron` 在纯 node 下（跑单测、脚本）是拿不到的，
  // 而这个模块的标签拼装部分是纯 Buffer 运算，应该能在 node 里单独验。
  const { net } = require('electron');
  try {
    const big = coverUrl(url);
    const res = await net.fetch(big.replace(/^http:\/\//i, 'https://'), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: 'https://music.163.com/',
      },
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > MAX_COVER_BYTES ? null : buf;
  } catch {
    return null;
  }
}

/**
 * 把标签写到 `file` 的最前面。
 *
 * 用 `fs.openSync(file, 'w')` + `writeSync` 自己控制偏移，而不是 `writeFileSync`：
 * 调用方紧接着会 `createWriteStream(file, { flags: 'a' })` 把音频接在后面，
 * 这里只要保证标签真的先落盘就行。
 *
 * 任何一步失败都**不抛**：标签是锦上添花，为了它把一首歌的下载判死不合理。
 * 失败时把已经写了一半的文件删掉，免得留下一个「只有标签没有音频」的残骸。
 */
async function writeTag(file, info) {
  try {
    const cover = await fetchCover(info.cover);
    const tag = buildTag({ ...info, cover });
    const fd = fs.openSync(file, 'w');
    try {
      fs.writeSync(fd, tag, 0, tag.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch {
    try { fs.unlinkSync(file); } catch { /* 可能还没建出来 */ }
    return false;
  }
}

/**
 * 把源流开头那段 ID3 标签吞掉，只留纯音频帧（用户 m07698 第③点）。
 *
 * CDN 返回的音频**自己就带着**一段 ID3v2.4 标签。实测两个例子都是 45 字节、
 * 里面只有一条 `TSSE Lavf58.76.100`（转码器签名），没有任何歌曲信息。
 * 我们刚往文件头写了自己的 ID3v2.3，再把它原样接上，文件里就有了两个 ID3：
 *
 * ```
 * [我们的 ID3v2.3] [CDN 的 ID3v2.4] [MP3 帧…]
 *                  ↑ 播放器读到第一个标签就停，这一段成了夹在中间的垃圾
 * ```
 *
 * 更糟的是官方客户端下的同一首歌只有一个标签，两边的文件因此永远差这几十字节 ——
 * 逐字节比对永远对不上。所以下载时把源流这一段跳过。
 *
 * 用 Transform 而不是「先读一段再拼」：源流是 `Readable.fromWeb(res.body)`，
 * 拿不到可回退的游标，只能边流边判。
 */
function makeStripper(onSkip) {
  const { Transform } = require('node:stream');
  let pending = [];
  let pendingLen = 0;
  let skip = -1;  // -1 = 还没判定；> 0 = 还要丢掉这么多字节；0 = 判定完，原样透传

  function headSize(head) {
    return ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
  }

  return new Transform({
    transform(chunk, _enc, cb) {
      if (skip === 0) return cb(null, chunk);
      if (skip > 0) {
        if (chunk.length <= skip) { skip -= chunk.length; return cb(); }
        const rest = chunk.subarray(skip);
        skip = 0;
        return cb(null, rest);
      }
      // 判定阶段：先攒够 10 字节的标签头
      pending.push(chunk);
      pendingLen += chunk.length;
      if (pendingLen < 10) return cb();

      const buf = Buffer.concat(pending);
      pending = [];
      pendingLen = 0;
      const head = buf.subarray(0, 10);
      const isId3 = head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33 && head[3] >= 2 && head[3] <= 4;
      if (!isId3) {
        skip = 0;
        if (onSkip) onSkip(0);
        return cb(null, buf);
      }

      const hasFooter = head[3] === 4 && (head[5] & 0x10) !== 0;
      const total = 10 + headSize(head) + (hasFooter ? 10 : 0);
      // 把跳过的长度立刻告诉调用方：断点续传要靠它把「已写音频长度」换算成
      // 远端字节偏移，晚一步（等流结束）进程被杀就接不上了。
      if (onSkip) onSkip(total);
      if (buf.length >= total) {
        skip = 0;
        return cb(null, buf.subarray(total));
      }
      skip = total - buf.length;
      return cb();
    },
    flush(cb) {
      if (pending.length) return cb(null, Buffer.concat(pending));
      cb();
    },
  });
}

module.exports = { buildTag, commJson, commFrame, coverUrl, writeTag, fetchCover, makeStripper };
