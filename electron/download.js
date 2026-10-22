'use strict';
/**
 * 歌曲下载（第 5 点）。
 *
 * 为什么整件事放在主进程：
 *   1. 渲染层是沙箱化的（contextIsolation，没有 Node），拿不到 fs；
 *   2. 网易云的直链带时效签名，而且 CDN 会校验 Referer —— 交给 Chromium 的
 *      下载管理器去拿会吃 403。这里用 Electron 的 `net`（自带 session、代理和
 *      证书设置）在主进程请求，自己写盘，顺便能算进度。
 *
 * 为什么落盘的只可能是标准 MP3 或 FLAC：
 *   网易云那套私有格式是 `.ncm`，只在他们自己的客户端里做加密缓存，走
 *   `/api/song/enhance/player/url/v1` 这个接口是拿不到的。
 *
 *   ⚠️ m35069 第 3 点实测：**服务端基本忽略 `encodeType`，容器由 `level`
 *   决定** —— `level=lossless` 时不管 encodeType 传什么都回 FLAC，
 *   只有 `level<=exhigh` 才回 MP3。`hires` 和 `lossless` 回的是同一个 FLAC，
 *   所以用户 m36690 第④点之后 `hires` 这一档已经删掉。
 *
 *   所以「要什么格式」在这套接口里就是「选哪一档」，用户 m36467 更正过口径：
 *   MP3 或 FLAC 都行，只要不是私有格式。这里因此不封顶档位，改成按
 *   `info.type` 做白名单（`OPEN_TYPES`）—— 真拿到私有容器就往下退一档。
 *
 * 队列是串行的：一次只下一首。并行下三首既容易被风控盯上，也会把带宽切成三份
 * 让每首都变慢，进度条还互相打架。
 */
const path = require('node:path');
const fs = require('node:fs');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { net } = require('electron');
const { writeTag, makeStripper } = require('./id3');

/**
 * 文件名净化。
 *
 * 用户 m15635 第④点：**不要用下划线顶替**。以前把 `/ \ : * ? " < > |`
 * 一律换成 `_`，于是多歌手的 `A/B/C` 落成 `A_B_C`、《DAMIDAMI: Reprise》
 * 落成 `DAMIDAMI_ Reprise` —— 名字被改得认不出来。
 *
 * 现在换成**长得一样的全角字符**（`：` `？` `／` …）：文件系统认它们是合法
 * 字符，肉眼看还是原来那个名字。控制字符（`\u0000`–`\u001F`）没法这样处理，
 * 直接丢掉。结尾的点 / 空格仍要去掉 —— Windows 不允许。
 */
const FULLWIDTH = {
  '/': '／', '\\': '＼', ':': '：', '*': '＊', '?': '？',
  '"': '＂', '<': '＜', '>': '＞', '|': '｜',
};

function sanitize(name) {
  return String(name == null ? '' : name)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, (ch) => FULLWIDTH[ch] || ch)
    .replace(/[. ]+$/, '')
    .trim();
}

/**
 * 把文件名模板套成实际文件名。
 *
 * 支持的占位符（中文花括号，和用户在设置里看到的一模一样）：
 *   {歌曲名} / {歌名}      歌名
 *   {首歌手名} / {歌手}    第一位歌手
 *   {歌手名}               全部歌手，用 `/` 紧贴（"A/B/C"，落盘时 `/` → 全角 `／`）
 *   {专辑名} / {专辑}      专辑名
 *   {音质}                 极高 / 无损 这种标签
 * 认不出来的占位符原样留着 —— 与其猜，不如让用户一眼看见自己写错了。
 */
function applyTemplate(tpl, song, qualityLabel) {
  const artists = song.artists || [];
  // 用户 m15635 第④点：名字要原封不动。多歌手沿用界面上的「A/B/C」紧贴写法，
  // `/` 由 sanitize 换成全角 `／` —— 肉眼看还是一条斜杠，文件系统也接受。
  const allNames = artists.map((a) => (a && a.name) || '').filter(Boolean).join('/');
  const first = firstOf(song.artistText);
  /** 老格式的「A / B」和新格式的「A/B」都要能取到第一位歌手。 */
  function firstOf(text) {
    return String(text || '').split('/')[0].trim();
  }
  const map = {
    '{歌曲名}': song.name || '未知歌曲',
    '{歌名}': song.name || '未知歌曲',
    '{首歌手名}': (artists[0] && artists[0].name) || first || '未知歌手',
    '{歌手}': (artists[0] && artists[0].name) || first || '未知歌手',
    '{歌手名}': allNames || song.artistText || '未知歌手',
    '{专辑名}': (song.album && song.album.name) || '未知专辑',
    '{专辑}': (song.album && song.album.name) || '未知专辑',
    '{音质}': qualityLabel || '',
  };
  let out = String(tpl || '');
  for (const [k, v] of Object.entries(map)) out = out.split(k).join(v);
  out = sanitize(out);
  // 模板整条被清空（比如用户只写了 "{歌名}" 而歌名是空的）时兜底，别写出个空文件名
  return out || sanitize(song.name || '未命名') || '未命名';
}

/** 同名文件已存在时依次试 `名称 (2).mp3`、`名称 (3).mp3`… */
function uniquePath(dir, base, ext) {
  let p = path.join(dir, base + ext);
  for (let i = 2; fs.existsSync(p); i++) {
    p = path.join(dir, `${base} (${i})${ext}`);
  }
  return p;
}

const QUALITY_LABEL = {
  standard: '标准', higher: '较高', exhigh: '极高', lossless: '无损',
};

/**
 * 下载可用的全部音质档位，从低到高。
 *
 * 「要什么格式」在网易这套接口里等于「选哪一档」：encodeType 是摆设，容器只由
 * level 决定 —— 前三档回 MP3，lossless 回 FLAC（见文件头与 endpoints.js:323 的说明）。
 *
 * 没有 hires：用户 m36690 第④点指出它与 lossless 实为同一音质，实测服务端对两者
 * 返回的 FLAC 完全一样，留着就是一个骗人的档位。
 */
const TIERS = ['standard', 'higher', 'exhigh', 'lossless'];

/**
 * 能接受的开源容器。m35069 第 3 点的口径是「下载成 MP3 或 FLAC，不是网易云
 * 私有格式就行」，所以只认这两个；拿到别的（比如私有容器）就往下退一档。
 */
const OPEN_TYPES = ['mp3', 'flac'];

/**
 * 把用户设置的音质翻译成一串「依次尝试」的档位：从他选的那一档开始往下退，
 * 最差退到 standard。
 *
 * 为什么要回退链而不是只试一档：m35069 第 3 点的要求是「只要能播放的歌曲
 * 都能下载」。有些歌在极高（320k）没有源、在标准（128k）却有 —— 只试一档
 * 就会白白失败。所以从目标档位往下逐级退。
 *
 * 这里**不向上封顶**：用户设了无损就该下到 FLAC。第 3 点只排斥私有格式，
 * MP3 和 FLAC 都算合格，真正的容器判定交给 _run() 按 info.type 做。
 */
function levelsFor(quality) {
  const q = String(quality || '');
  const i = TIERS.indexOf(q);
  const from = i >= 0 ? i : TIERS.indexOf('exhigh');
  return TIERS.slice(0, from + 1).reverse();
}

/**
 * 档位排序（越大越好），用来回答「本机这份够不够这次要的」。
 *
 * 认不出的档位（老记录里没写、手改过配置）一律当 `exhigh` —— 和 `levelsFor()`
 * 的兜底口径一致：默认档就是极高，拿它比，既不会把老记录当成「无损」而错误
 * 跳过无损下载，也不会因为认不出来就无脑重下一遍。
 */
function tierRank(quality) {
  const i = TIERS.indexOf(String(quality || ''));
  return i >= 0 ? i : TIERS.indexOf('exhigh');
}

/**
 * 下载队列。
 *
 * 依赖由外部注入（配置读写、取直链的函数、给渲染层发事件的函数），这样这个
 * 文件不直接碰 main.js 里的全局状态，单独测也容易。
 */
class Downloader {
  constructor({ getConfig, saveConfig, songUrl, songDetail, emit, onTaskDone, historyPath, isLocal }) {
    this.getConfig = getConfig;
    this.saveConfig = saveConfig;
    this.songUrl = songUrl;
    // 补音轨号 / 碟号用。每日推荐、搜索这些接口回的 JSON 里没有 `no` / `cd`，
    // 只有 `/v3/song/detail` 有 —— 少了它，从每日推荐下的歌写不出 TRCK / TPOS，
    // 而官方客户端下的同名文件是带的（用户 m08537 第①点）。
    this.songDetail = songDetail || null;
    this.emit = emit;
    this.onTaskDone = onTaskDone || (() => {});
    /**
     * 「这首歌本机已经有了吗」（m02599 第①点）。
     *
     * 判断权在 main.js 手里 —— 只有它同时看得见本地索引（`LocalIndex`）。这里
     * 只要一个谓词，不必知道索引长什么样，单独测这个类时传个 stub 就行。
     * 缺省恒 false：注入的人没给，就老老实实全下。
     */
    this.isLocal = typeof isLocal === 'function' ? isLocal : () => false;
    // 历史记录文件（<userData>/download-history.json）。
    //
    // 队列本身是纯内存态：重启后正在下的东西没法续传，但「下过什么、成功没有」
    // 必须留住 —— 否则侧栏的「已下载音乐」页每次开机都是空的，那一栏就没有意义。
    // 所以只把「已结束」的任务写盘，进行中的不写（写了也续不上，反而会让用户
    // 以为还能继续）。
    this.historyPath = historyPath || '';
    /**
     * 断点续传的账本（<userData>/download-parts.json）。
     *
     * 为什么不能只靠「文件有多大」：MP3 前面还压着一段我们自己写的 ID3 标签，
     * 而源流开头可能又有一段 CDN 写的 ID3。要算出 `Range: bytes=` 的起点，
     * 必须同时知道「我们写了多少标签」和「源流被跳过了多少」。
     *
     * 键是 `.part` 文件的绝对路径 —— 模板没改时同一首歌算出来的路径是稳定的，
     * 换模板 / 换音质会落到新路径，各续各的，不会把两首歌拼进一个文件。
     */
    this.partsPath = historyPath ? path.join(path.dirname(historyPath), 'download-parts.json') : '';
    this._parts = this._loadParts();
    /** @type {Array<object>} 排队中 + 正在下载 + 刚完成的，渲染层直接照着画列表 */
    this.tasks = this._loadHistory();
    this._running = false;
    /** 每次 `_run` 递增的序号，用来识别「已经被后来那次顶掉」的旧 run。 */
    this._runSeq = 0;
    // key 必须接着历史里的最大值往下发：渲染层按 key 找节点、取消也按 key 定位，
    // 从 1 重新数就会跟旧记录撞上，操作打到错的那一条。
    this._seq = this.tasks.reduce((m, t) => Math.max(m, Number(t.key) || 0), 0);
  }

  /** 读回断点续传账本。没有 / 坏了都当空的，绝不拦启动。 */
  _loadParts() {
    if (!this.partsPath) return {};
    try {
      const j = JSON.parse(fs.readFileSync(this.partsPath, 'utf8'));
      return j && typeof j === 'object' ? j : {};
    } catch { return {}; }
  }

  /** 写账本。同样吞异常 —— 记不住断点最多退化成重下一遍，不该让下载失败。 */
  _saveParts() {
    if (!this.partsPath) return;
    try {
      fs.mkdirSync(path.dirname(this.partsPath), { recursive: true });
      fs.writeFileSync(this.partsPath, JSON.stringify(this._parts), 'utf8');
    } catch { /* 忽略 */ }
  }

  /** 删掉一条续传记录（完成 / 取消 / 文件不在了都要清）。 */
  _dropPart(partPath) {
    if (!partPath) return;
    delete this._parts[partPath];
    this._saveParts();
  }

  /** 读回上次的下载记录。文件不存在或坏了都当作「没有历史」，绝不拦启动。 */
  _loadHistory() {
    if (!this.historyPath) return [];
    try {
      const arr = JSON.parse(fs.readFileSync(this.historyPath, 'utf8'));
      if (!Array.isArray(arr)) return [];
      return arr.filter((t) => t && t.key).map((t) => {
        // 上次进程没退干净时留下的 queued / running 现在**可以续传**了：
        // 落成「已暂停」并留一句话，用户点「继续」就从断点接着下（m00001 第①点）。
        // 没有 .part 的（比如还没开始就退了）也照样显示已暂停，继续时从头下，
        // 但文件路径与模板一致，不会在磁盘上多出一个「(2)」。
        const stale = t.state === 'queued' || t.state === 'running';
        const state = stale ? 'paused' : t.state;
        return {
          ...t,
          state,
          error: stale ? (t.error || '上次退出时未完成，点「继续」可从断点接着下') : (t.error || ''),
          received: state === 'done' ? (t.received || t.total || 0) : (t.received || 0),
        };
      });
    } catch { return []; }
  }

  /** 把「已结束」的任务写盘。写失败不该影响下载本身，所以异常一律吞掉。 */
  _saveHistory() {
    if (!this.historyPath) return;
    try {
      const done = this.tasks.filter((t) => t.state !== 'queued' && t.state !== 'running');
      // 只留最近 500 条：历史太长既占内存，也会拖慢每次启动的读取
      const keep = done.slice(-500).map(({ _song, ...t }) => t);
      fs.mkdirSync(path.dirname(this.historyPath), { recursive: true });
      fs.writeFileSync(this.historyPath, JSON.stringify(keep), 'utf8');
    } catch { /* 记录失败不该让下载失败 */ }
  }

  get settings() {
    const d = this.getConfig().download || {};
    // 白名单外的值（老版本、手改的配置文件）一律折成 exhigh 这个稳妥档。
    // 无损是正常档位，不再折叠 —— 它下下来是 FLAC，符合要求。
    // 已下架的 hires（第④点）单独折成无损，别让它掉回极高。
    const q = d.quality === 'hires' ? 'lossless' : (TIERS.includes(d.quality) ? d.quality : 'exhigh');
    return {
      dir: d.dir || '',
      quality: q,
      organize: d.organize || 'none',
      template: d.template || '{歌手名} - {歌曲名}',
    };
  }

  /** 目标根目录：没配过就用系统的「音乐」文件夹 */
  rootDir() {
    const s = this.settings;
    return s.dir || require('electron').app.getPath('music');
  }

  /** 按「是否分类」算出一首歌该落哪个子目录，并确保目录存在 */
  _targetDir(song) {
    const root = this.rootDir();
    const org = this.settings.organize;
    let sub = '';
    if (org === 'artist') {
      const a = (song.artists || [])[0];
      sub = sanitize((a && a.name) || song.artistText || '未知歌手');
    } else if (org === 'album') {
      sub = sanitize((song.album && song.album.name) || '未知专辑');
    }
    const dir = sub ? path.join(root, sub) : root;
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * 补齐音轨号 / 碟号。
   *
   * 列表类接口（每日推荐、搜索、最近播放）回的歌曲对象里没有 `no` / `cd` 字段，
   * 只有歌曲详情接口有。缺了这两项，写标签时就跳过 TRCK / TPOS —— 文件本身能播，
   * 但拷进别的播放器就没有「第几首」了，和官方客户端下的文件对不上
   * （用户 m08537 第①点）。
   *
   * 只在两项目前都是 0（未知）时才去问一次；问不到就算了，绝不因此让下载失败。
   */
  async _fillTrackNumbers(song) {
    if (!song || !this.songDetail) return;
    // 补过一次就不再问（`discText` 为空是正常结果 —— 单碟专辑的 TPOS 只写 `01`，
    // 不能用「discText 是否为空」判断有没有问过，否则每次下载都会多打一次详情）。
    if (song._tnFetched) return;
    if ((song.trackNo || 0) > 0 && (song.discNo || 0) > 0) return;
    try {
      const list = await this.songDetail([song.id]);
      const d = Array.isArray(list) ? list[0] : null;
      song._tnFetched = true;
      if (!d) return;
      if (!(song.trackNo > 0) && d.trackNo > 0) song.trackNo = d.trackNo;
      if (!(song.discNo > 0) && d.discNo > 0) song.discNo = d.discNo;
      // 碟名（`disc1 万籁拂旧尘` 这种）只在详情接口里有，见 endpoints.js 的 discFields()。
      if (!song.discText && d.discText) song.discText = d.discText;
    } catch { /* 补不到就按未知处理，不写帧 */ }
  }

  /**
   * 拼 `COMM` 帧要用的字段（用户 m11461 第①点）。
   *
   * 三个值的来源，都踩过一下：
   *
   *   - `albumPic` 官方写的是 **http**（不是 https），且**不带任何查询参数**。
   *     直接拿 `song.cover` 不行 —— 它可能已经被上游改写成 https 了，照抄会和
   *     官方差 1 个字符。
   *   - `albumPicDocId` 是封面 URL 末尾那个数字（`…/109951172148710780.jpg`），
   *     不是专辑 id。抠不出来就写 0。
   *   - `gain` 官方写的是 ReplayGain 值（-9.312800407409668 这种），**四个取流接口
   *     里恒为 0** —— 要拿到得把整首歌解码做 EBU R128 响度分析。这里写 0 并在注释
   *     里认账：官方 app 靠 `musicId` 认文件，`gain` 只影响音量归一化。
   */
  _commInfo(song, br) {
    if (!song || !song.id) return null;
    const pic = String(song.cover || '')
      .replace(/^https:/i, 'http:')
      .replace(/\?.*$/, '');
    const docId = Number((/(\d+)\.[A-Za-z0-9]+$/.exec(pic) || [])[1]) || 0;
    return {
      musicId: song.id,
      musicName: song.name || '',
      artists: (song.artists || []).map((a) => [a.name, a.id]),
      album: (song.album && song.album.name) || '',
      albumId: (song.album && song.album.id) || 0,
      albumPicDocId: docId,
      albumPic: pic,
      mvid: song.mvid || 0,
      bitrate: br || 0,
      durationMs: song.duration || 0,
      gain: 0,
      alias: song.alias || [],
      transNames: [],
      // 碟名原文（`disc1 万籁拂旧尘`）。TPOS 帧照它写；空串时 id3.js 退回补两位的碟号。
      discText: song.discText || '',
    };
  }

  /**
   * 这首歌是不是「已经在那儿了，别再下一遍」（m02599 第①点）。
   *
   * 两边都要看，因为它们是两件不同的事：
   *  - **队列里还有**：同一首歌刚被丢进来（排队 / 正在下 / 暂停着等继续），再塞
   *    一条只会在列表里出现两行、两条 job 抢同一个 `.part`。这三种状态算「在办」。
   *  - **本机已经有文件**：`isLocal()` 交给 main.js 用本地索引判断（带音质比较 ——
   *    本地 128k 而用户这次要无损时应该去下，本地无损而这次要 128k 就直接用本地的）。
   *    另外再兜一道 `done` 任务里记着、且文件确实还在的路径：用户「清空索引」之后
   *    索引是空的，但下载记录仍能证明这首歌下过，不该再下一遍 —— 同样要比音质，
   *    记录里那份不如这次要的档位时照旧去下。
   *
   * `error` / `canceled` 的旧任务不算数：那是失败或用户主动放弃的，重来一次是
   * 用户的正当意图（列表里也专门留着「重试」）。
   */
  _alreadyHave(song, quality) {
    const id = song && Number(song.id);
    if (!id) return false;
    const inflight = this.tasks.some((t) => (
      Number(t.songId) === id
      && (t.state === 'queued' || t.state === 'running' || t.state === 'paused')
    ));
    if (inflight) return 'queued';
    const done = this.tasks.some((t) => (
      Number(t.songId) === id && t.state === 'done' && t.file && fs.existsSync(t.file)
      // 「下过」不等于「已经够了」：上次下的是 320k、这次用户设成无损，就该去
      // 下一份无损（FLAC），不能因为记录里有这一首就跳过。反过来，上次下的
      // 是无损、这次只要 320k，用本机那份就行，没必要再下一遍。
      && tierRank(t.quality) >= tierRank(quality)
    ));
    if (done) return 'local';
    let local = false;
    try { local = !!this.isLocal(id, quality); } catch { local = false; }
    return local ? 'local' : false;
  }

  /** 把一个或多个任务推进队列。songs 是渲染层来的歌曲对象数组。 */
  enqueue(songs, qualityOverride) {
    const list = (songs || []).filter(Boolean);
    if (!list.length) return { ok: false, error: '没有可下载的歌曲' };
    const quality = qualityOverride || this.settings.quality;
    // 同一批里重复勾选的同一首歌也要去掉（多选「全选」时列表本身不会重复，
    // 但「已选 + 右键再下」这种组合会）。
    const seenInBatch = new Set();
    let skipped = 0;
    let skippedLocal = 0;   // 本机已经有文件（或下过、文件还在）
    let skippedQueued = 0;  // 队列里已经在办这一首了
    for (const song of list) {
      const id = Number(song.id);
      if (!id || seenInBatch.has(id)) { skipped++; skippedQueued++; continue; }
      seenInBatch.add(id);
      const why = this._alreadyHave(song, quality);
      if (why) {
        skipped++;
        if (why === 'local') skippedLocal++; else skippedQueued++;
        continue;
      }
      this.tasks.push({
        key: ++this._seq,
        songId: song.id,
        name: song.name || '',
        artistText: song.artistText || '',
        cover: song.cover || '',
        quality,
        state: 'queued',      // queued | running | done | error | canceled
        received: 0,
        total: 0,
        file: '',
        error: '',
        // 会员 / 付费标记：详情页与设置页都要在无损上标 VIP
        vip: song.fee === 1,
        // 完整的歌曲对象留在任务上：模板要歌手 / 专辑，分类建目录也要它们，
        // 而 `_emitList()` 发出去的那份会被展开成浅拷贝，所以这里单独存一份。
        _song: song,
      });
    }
    const count = list.length - skipped;
    const result = { ok: true, count, skipped, skippedLocal, skippedQueued, total: list.length };
    // 全被跳掉时不要只回一句「0 首」：渲染层要据此说清「都已经在本地了」。
    if (!count) return result;
    this._emitList();
    this._pump();
    return result;
  }

  /**
   * 暂停（m00001 第①点）。
   *
   * 和「取消」的区别就是那条 `.part` 留不留：暂停把已经下到的字节原样留在盘上，
   * 继续时用 HTTP Range 从断点往后写同一个文件，因此绝不会出现第二个文件。
   */
  pause(key) {
    const t = this.tasks.find((x) => x.key === key);
    if (!t || (t.state !== 'running' && t.state !== 'queued')) return { ok: false };
    t.state = 'paused';
    if (this._abort) this._abort.abort();
    this._emitList();
    this._saveHistory();
    return { ok: true };
  }

  /** 继续 / 重试：把任务放回队列，`_run` 会自己找到 `.part` 从断点接上。 */
  resume(key) {
    const t = this.tasks.find((x) => x.key === key);
    if (!t || (t.state !== 'paused' && t.state !== 'error')) return { ok: false };
    t.state = 'queued';
    t.error = '';
    this._emitList();
    this._saveHistory();
    this._pump();
    return { ok: true };
  }

  cancel(key) {
    const t = this.tasks.find((x) => x.key === key);
    if (!t) return { ok: false };
    if (t.state === 'running') {
      t.state = 'canceled';
      if (this._abort) this._abort.abort();
    } else if (t.state === 'queued' || t.state === 'paused' || t.state === 'error') {
      t.state = 'canceled';
      // 用户明确不要了：半截文件连同续传账本一起删，别占着磁盘
      try { if (t.part) fs.unlinkSync(t.part); } catch { /* 可能还没建出来 */ }
      this._dropPart(t.part);
    }
    this._emitList();
    this._saveHistory();
    return { ok: true };
  }

  /** 全部暂停（m02003 第②点）：正在下的那首也会被 abort 掉，字节留在 `.part` 里。 */
  pauseAll() {
    let n = 0;
    for (const t of this.tasks) {
      if (t.state !== 'running' && t.state !== 'queued') continue;
      t.state = 'paused';
      n += 1;
    }
    // 先改状态再 abort：`_run` 的 catch 会看当前状态决定「保留 .part」还是「删掉」
    if (n && this._abort) this._abort.abort();
    this._emitList();
    this._saveHistory();
    return { ok: true, count: n };
  }

  /** 全部开始（m02003 第②点）：暂停的、失败的都放回队列，`_pump` 会串行跑起来。 */
  resumeAll() {
    let n = 0;
    for (const t of this.tasks) {
      if (t.state !== 'paused' && t.state !== 'error') continue;
      t.state = 'queued';
      t.error = '';
      n += 1;
    }
    this._emitList();
    this._saveHistory();
    if (n) this._pump();
    return { ok: true, count: n };
  }

  /**
   * 清空列表（m02003 第②点）：正在下的先停掉，然后所有任务连同半截文件一起删。
   *
   * 和「取消」同一口径 —— 用户点清空就是「这些我全不要了」，留着 `.part`
   * 只会在磁盘上积一堆没人认领的残片。
   */
  clearAll() {
    // 先让正在跑的那次收尾（它按当前状态决定留不留 .part），再统一清账
    for (const t of this.tasks) t.state = 'canceled';
    if (this._abort) this._abort.abort();
    for (const t of this.tasks) {
      try { if (t.part) fs.unlinkSync(t.part); } catch { /* 还没建出来 */ }
      this._dropPart(t.part);
    }
    const n = this.tasks.length;
    this.tasks = [];
    this._emitList();
    this._saveHistory();
    return { ok: true, count: n };
  }

  clearFinished() {
    const keep = (t) => t.state === 'running' || t.state === 'queued' || t.state === 'paused';
    const dropped = this.tasks.filter((t) => !keep(t));
    for (const t of dropped) {
      // 失败任务可能还留着 .part（为了能重试）；清掉记录时一起清掉，免得变孤儿
      try { if (t.part) fs.unlinkSync(t.part); } catch { /* 不存在就算了 */ }
      this._dropPart(t.part);
    }
    this.tasks = this.tasks.filter(keep);
    this._emitList();
    // 清空也是一次「历史变更」：不写盘的话下次开机被清掉的记录又全回来了
    this._saveHistory();
    return { ok: true };
  }

  /** 把任务当前的真实进度记进续传账本（以磁盘上的文件长度为准，不信内存计数）。 */
  _rememberPart(task) {
    if (!task.part) return;
    let size = 0;
    try { size = fs.statSync(task.part).size; } catch { return; }
    task.received = Math.max(0, size - (Number(task.tagSize) || 0));
    this._parts[task.part] = {
      songId: task.songId,
      quality: task.quality,
      ext: path.extname(task.file || ''),
      tagSize: Number(task.tagSize) || 0,
      skip: Number(task.skip) || 0,
      received: task.received,
      total: Number(task.total) || 0,
      updatedAt: Date.now(),
    };
    this._saveParts();
  }

  _emitList() {
    // 只发渲染层画列表需要的字段：`_song` 是整个歌曲对象，塞进 IPC 既浪费又没必要
    this.emit('download:list', this.tasks.map(({ _song, ...t }) => ({ ...t })));
  }

  async _pump() {
    if (this._running) return;
    const next = this.tasks.find((t) => t.state === 'queued');
    if (!next) return;
    this._running = true;
    try {
      await this._run(next);
    } finally {
      this._running = false;
      // 队列里可能还有下一首，也可能刚刚又被追加了
      setImmediate(() => this._pump());
    }
  }

  async _run(task) {
    // 每次 `_run` 领一个号：暂停/取消之后旧的那次仍会从 abort 里抛出来，
    // 但它不该再改任务状态 —— 用户已经点了「继续」，新的那次正在跑
    // （曾经就是这里把刚续上的任务又盖成「连接中断」）。
    const runId = ++this._runSeq;
    task._runId = runId;
    task.state = 'running';
    /** 本次 run 自己的中断控制器；旧 run 收尾时不能碰新 run 的那一份。 */
    let controller = null;
    this._emitList();
    try {
      // 依次试：目标档位 → 逐级退到标准。拿到 MP3 或 FLAC 都算成功；
      // 撞上私有容器就继续往下退（宁可要一档低一点的开源容器，也不落一个
      // 只有网易云能播的文件）。
      const levels = levelsFor(task.quality);
      let info = null;
      let used = levels[0];
      let privateType = '';
      for (const lv of levels) {
        const got = await this.songUrl(task.songId, lv);
        if (!got || !got.url) continue;
        // 试听片段不能算「拿到了」：存下来是 30 秒，比失败更误导。
        // 但它是有效信息，留着做最后的报错原因。
        if (got.trial) { info = info || got; continue; }
        const t = String(got.type || '').toLowerCase();
        if (!OPEN_TYPES.includes(t)) { privateType = t || '未知'; continue; }
        info = got; used = lv; break;
      }
      if (!info || !info.url) {
        // 「接口能给、但我们不要」要单独说，别混进「已下架」里让人以为是版权问题
        if (privateType) throw new Error(`只能取到网易云私有格式（.${privateType}），无法下载`);
        // fee === 1 是会员/付费专享；否则就是没版权或下架了
        throw new Error(info && info.fee === 1 ? '需要会员或付费，无法下载' : '暂无版权或已下架');
      }
      if (info.trial) {
        // 服务端只给了试听片段。非会员点会员曲会走到这里 —— 宁可失败，
        // 也不能把 30 秒的片段当整首存下来。
        throw new Error('只能试听，无法下载完整歌曲（需要会员）');
      }
      task.quality = used;
      // 以服务端真正给出的容器定后缀，绝不信模板里写的东西。能走到这里说明
      // type 已经在 OPEN_TYPES 里过了（mp3/flac），下面只是按它取值。
      const type = String(info.type || '').toLowerCase();
      const ext = type === 'flac' ? '.flac' : '.mp3';
      const base = applyTemplate(this.settings.template, task._song, QUALITY_LABEL[task.quality] || task.quality);
      const dir = this._targetDir(task._song);

      // ── 断点续传的目标文件（m00001 第①点）────────────────────────────────
      // 目标路径由模板算出来，是稳定的；上次留下的半截文件固定叫 `<正式名>.part`。
      // 只有「同一首歌 + 同一音质 + 同一后缀」才敢接着写，否则宁可重下，
      // 也绝不能把两首歌拼进同一个文件。
      let file = path.join(dir, base + ext);
      let part = file + '.part';
      let rec = this._parts[part];
      let resume = !!(rec && Number(rec.songId) === Number(task.songId)
        && rec.quality === task.quality && rec.ext === ext && fs.existsSync(part));
      if (!resume) {
        // 同名正式文件已经存在：沿用原来的去重规则，挑一个不冲突的名字
        if (fs.existsSync(file)) {
          file = uniquePath(dir, base, ext);
          part = file + '.part';
          rec = this._parts[part];
          resume = !!(rec && Number(rec.songId) === Number(task.songId)
            && rec.quality === task.quality && rec.ext === ext && fs.existsSync(part));
        }
        if (!resume) {
          // 这个 .part 是别的歌 / 别的音质留下的：删掉重来，别混写
          delete this._parts[part];
          try { if (fs.existsSync(part)) fs.unlinkSync(part); } catch { /* 忽略 */ }
          rec = null;
        }
      }
      task.file = file;
      task.part = part;
      if (resume) {
        // 以磁盘上的真实长度为准：进程被杀时内存里的 received 可能比落盘的多
        const size = fs.statSync(part).size;
        task.tagSize = Number(rec.tagSize) || 0;
        task.skip = Number(rec.skip) || 0;
        task.received = Math.max(0, size - task.tagSize);
        task.total = Number(rec.total) || 0;
      } else {
        task.tagSize = 0;
        task.skip = 0;
        task.received = 0;
        task.total = info.size || 0;
      }
      this._emitList();

      this._abort = new AbortController();
      controller = this._abort;
      // 接口给的直链大多是 http://，但 Electron 的 net.fetch 对这批纯 http 的
      // CDN 地址一律返回 net::ERR_BLOCKED_BY_CLIENT（同一资源换 https 就 200，
      // 图片代理也踩过同一个坑）。所以先统一升到 https 再取。
      const dlUrl = String(info.url).replace(/^http:\/\//i, 'https://');
      const reqHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: 'https://music.163.com/',
      };
      // 源流开头可能有一段 CDN 写的 ID3（我们不要它），所以远端偏移 =
      // 已跳过的标签长度 + 已写下的音频长度。
      const startAt = resume ? task.skip + task.received : 0;
      if (startAt > 0) reqHeaders.Range = `bytes=${startAt}-`;
      const res = await net.fetch(dlUrl, { headers: reqHeaders, signal: controller.signal });
      if (!res.ok) throw new Error('下载失败 HTTP ' + res.status);

      // 服务端认了 Range 才是真续传；返回 200 说明它无视 Range，必须截断重来，
      // 否则会写出「前半首 + 整首」的坏文件。
      let append = false;
      if (resume && res.status === 206) {
        const cr = res.headers.get('content-range') || '';
        const m = /^bytes\s+(\d+)-/i.exec(cr);
        if (!m || Number(m[1]) === startAt) {
          append = true;
          const totalAll = Number((/[/](\d+)\s*$/.exec(cr) || [])[1]) || 0;
          if (totalAll) task.total = Math.max(0, totalAll - task.skip);
        }
      }
      if (resume && !append) {
        task.received = 0;
        task.tagSize = 0;
        task.skip = 0;
        resume = false;
        rec = null;
        delete this._parts[part];
        this._saveParts();
      }
      if (!task.total) task.total = Number(res.headers.get('content-length')) || 0;

      let out;
      let onCount;
      if (resume) {
        // 续传：标签和前半段音频都已经在 .part 里，直接往后接
        const before = task.received;
        onCount = (n) => {
          task.received = before + n;
          this._tickProgress(task, part);
        };
        out = fs.createWriteStream(part, { flags: 'a' });
        await pipeline(Readable.fromWeb(res.body), new TransformCounter(onCount), out);
      } else {
        // 先把 ID3v2.3 标签写到 .part 最前面，再把音频接在后面（m07048 第④点）。
        // 写标签失败不算下载失败 —— writeTag 内部会把半截文件删掉，这里继续
        // 往下走，音频会从 0 开始重新写一份「没有标签但能播」的文件。
        // FLAC 例外：ID3 是 MP3 的标签格式，前面硬挂一段会让一部分播放器认不出。
        if (ext === '.mp3') {
          // 每日推荐 / 搜索这些来源的歌曲对象没有音轨号和碟号，先补一次详情
          await this._fillTrackNumbers(task._song);
          await writeTag(part, {
            title: task._song.name || task.name,
            artist: task.artistText,
            album: (task._song.album && task._song.album.name) || '',
            trackNo: task._song.trackNo || 0,
            discNo: task._song.discNo || 0,
            cover: task.cover,
            // COMM 帧：官方 app 靠这段认「这是我自己下的文件」（m11461 第①点）。
            comm: this._commInfo(task._song, info.br),
            padding: 128,
          });
        } else {
          fs.writeFileSync(part, Buffer.alloc(0));
        }
        try {
          task.tagSize = fs.statSync(part).size;
        } catch {
          // writeTag 自己失败时会把半截文件删掉：按「没标签但能播」继续
          task.tagSize = 0;
          fs.writeFileSync(part, Buffer.alloc(0));
        }
        let skipped = 0;
        onCount = (n) => {
          task.received = n;
          this._tickProgress(task, part);
        };
        out = fs.createWriteStream(part, { flags: 'a' });
        // 源流可能自带一段 ID3v2.4（CDN 转码器写的，实测 45 字节、只有 TSSE 一条）。
        // 不吞掉的话文件里就有两个 ID3，而且永远比官方那份多这几十字节（m07698 第③点）。
        await pipeline(
          Readable.fromWeb(res.body),
          makeStripper((n) => { skipped = n; task.skip = n; }),
          new TransformCounter(onCount),
          out,
        );
        task.skip = skipped;
      }

      // 下完才把 .part 改成正式文件名：中途退出时目录里永远只有一个半成品，
      // 不会出现「正式文件」和「(2)」两份。
      if (fs.existsSync(file)) file = uniquePath(dir, base, ext);
      fs.renameSync(part, file);
      task.file = file;
      task.part = '';
      this._dropPart(part);
      task.state = 'done';
      task.received = task.total || task.received;
      this._emitList();
      // 只有「已结束」的任务才写盘，而且必须在这时写：侧栏的「已下载音乐」
      // 页要在下次开机后仍然列出这一次下过的东西。
      this._saveHistory();
      this.onTaskDone(task);
    } catch (e) {
      // 这次 run 已经被后来的一次顶掉（暂停后立刻继续）：状态归新的那次管，
      // 这里只做收尾，不能把任务改成 error / paused。
      if (task._runId !== runId) return;
      if (task.state === 'paused') {
        // 暂停：保留 .part，把已经落盘的真实长度记进账本，继续时从断点接上
        this._rememberPart(task);
        this._emitList();
        this._saveHistory();
        return;
      }
      if (task.state === 'canceled') {
        try { if (task.part) fs.unlinkSync(task.part); } catch { /* 可能还没建出来 */ }
        this._dropPart(task.part);
      } else if (task.state === 'queued') {
        // 用户点了「继续」，任务已经重新排队。这次 run 只是被 abort 吵醒的，
        // 什么都不能改 —— `_pump()` 的 finally 马上会把队列里的它重新领走。
        return;
      } else {
        task.state = 'error';
        task.error = friendlyError(e);
        // 失败也保留 .part：点「重试」能接着下，不用从头再来
        this._rememberPart(task);
      }
      this._emitList();
      // 失败和取消也要落盘：用户回头要看得见「哪首没下成、为什么」
      this._saveHistory();
    } finally {
      // 只清自己那份：旧 run 延迟收尾时 `this._abort` 可能已经是新 run 的控制器了
      if (this._abort === controller) this._abort = null;
    }
  }

  /** 进度回调：顺手把续传账本按 1s 一次的频率落盘，进程被杀也能接上。 */
  _tickProgress(task, part) {
    const now = Date.now();
    if (now - (this._lastTick || 0) <= 200) return;
    this._lastTick = now;
    this._emitList();
    if (part && now - (this._lastPartSave || 0) > 1000) {
      this._lastPartSave = now;
      this._parts[part] = {
        songId: task.songId,
        quality: task.quality,
        ext: path.extname(task.file || ''),
        tagSize: Number(task.tagSize) || 0,
        skip: Number(task.skip) || 0,
        received: task.received,
        total: Number(task.total) || 0,
        updatedAt: now,
      };
      this._saveParts();
    }
  }
}

/**
 * 把下载过程中抛出的异常翻成一句用户能看懂的话（用户 m07698 第②点）。
 *
 * 原来直接把 `e.message` 写进任务行，断网时那一格显示的是 `fetch failed`
 * 或者 `The operation was aborted` —— 既没说是网络问题，也没说该等还是该换网。
 * 节点异常的类型（`e.cause.code`）才是真信息，消息往往只是 undici 的一句短语。
 *
 * 只翻「能确定」的几类，其余保留原文并带上字段名，方便用户回报时能对上。
 */
function friendlyError(e) {
  const msg = String((e && e.message) || e || '');
  const code = String((e && e.cause && e.cause.code) || (e && e.code) || '');
  const all = msg + ' ' + code;
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(all)) return '无法解析服务器地址：当前没有网络';
  if (/ECONNREFUSED/i.test(all)) return '连接被拒绝：服务器暂时不可达';
  if (/ECONNRESET|EPIPE|socket hang up|aborted/i.test(all)) return '连接中断，请重试';
  if (/ETIMEDOUT|timeout|timed out/i.test(all)) return '连接超时：网络不通或太慢，检查网络后重试';
  if (/ENOSPC/i.test(all)) return '磁盘空间不足，清理后重试';
  if (/EACCES|EPERM/i.test(all)) return '没有写入权限：换一个下载位置试试';
  if (/^下载失败 HTTP (\d+)$/.test(msg)) return msg;
  return msg || '下载失败';
}

/** 数着字节往下传的直通流，用来报进度 */
class TransformCounter extends require('node:stream').Transform {
  constructor(onCount) {
    super();
    this._n = 0;
    this._onCount = onCount;
  }

  _transform(chunk, _enc, cb) {
    this._n += chunk.length;
    this._onCount(this._n);
    cb(null, chunk);
  }
}

module.exports = { Downloader, applyTemplate, sanitize, QUALITY_LABEL };
