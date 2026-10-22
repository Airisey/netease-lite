'use strict';
/**
 * 本地歌曲扫描（m35069 第 2 点）。
 *
 * 用户在歌单页点「本地扫描」→ 挑一个文件夹 → 这里把文件夹里的音频文件按
 * **文件名**和歌单里的歌曲对上，对上的记进索引。索引有两个用处：
 *   1. 歌曲行上的「√」亮起来（这首歌本机已经有文件了）；
 *   2. 播放时优先放本地文件，不用再去请求直链（见 player.js 的 `_load`）。
 *
 * 为什么匹配靠文件名而不是音频标签：
 *   读 ID3 / FLAC 标签要给每个文件解析头部，一个几千首的文件夹扫下来很慢，
 *   而且用户自己整理过的文件往往标签是空的、文件名反而是规整的
 *   （默认下载模板就是 `{歌手名} - {歌曲名}`）。文件名匹配又快又能覆盖
 *   本应用自己下下来的文件。
 *
 * 为什么索引单独存一个 JSON 而不是塞进 config.json：
 *   索引条数跟歌单规模同阶（几千条），config.json 是每次改设置都要整份
 *   重写的，塞进去会让每次改音量都写几千行。放 userData 下单独一份，
 *   坏了大不了重扫。
 *
 * **匹配口径（用户 m15635 第③点）**：优先读文件自己的标签（`TIT2`/`TPE1`/`TALB`
 * 或 FLAC 的 `TITLE`/`ARTIST`/`ALBUM`），拿标签里的歌名去跟接口的 `song.name`
 * 精确比对；读不到标签（或标签里没歌名）才退回文件名匹配。文件名是用户/工具
 * 起的，跟歌本身没有约束关系，`01.mp3` 和 `Rain.mp3` 都可能不是它 —— 标签是
 * 歌自己带的身份，靠它才不会串歌。
 *
 * 索引是**全局**的：从哪个歌单扫的只决定这一次拿哪些歌去对，对上之后
 * 任何页面（搜索、专辑、每日推荐）都能用上 —— 用户在意的是「这首歌本机
 * 有没有」，不是「这个歌单里有没有」。
 */
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { readTags } = require('./tags');

/** 认这些扩展名。ape / wma 这类冷门格式也收，Chromium 解不了的自然播不动，不影响匹配。 */
const AUDIO_EXT = new Set(['.mp3', '.flac', '.m4a', '.aac', '.wav', '.ogg', '.opus', '.ape', '.wma']);

/** 按扩展名给 Content-Type，Chromium 大多能自己嗅探，但给准了 seek 更稳。 */
const MIME = {
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.ape': 'audio/x-ape',
  '.wma': 'audio/x-ms-wma',
};

/**
 * 匹配用的归一化。
 *
 * NFKC 顺手把全角字母数字、罗马数字这些折成半角 —— 用户从各处拖来的文件
 * 全角半角混着写很常见。然后去掉所有空白和常见分隔符：`A - B`、`A-B`、
 * `A.B`、`A_B` 归一化之后是同一个键，这样命名习惯不同也能对上。
 */
function norm(s) {
  return String(s == null ? '' : s)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    // eslint-disable-next-line no-useless-escape
    .replace(/[._\-–—~～!！?？@#$%^&*()+=\[\]{};:'",<>/\\|`]/g, '');
}

/**
 * 把文件名拆成「歌手 - 歌名」。
 *
 * 只在**第一个** ` - ` 处拆：歌名里带横线的很多（`Puppet in the Dark (PartⅡ /
 * Buried Away)`、`名もなき花`），从后往前拆会把歌名切掉一半。
 * 拆不出来就只当歌名用。
 */
function splitBase(base) {
  const m = String(base).match(/^(.*?)\s+-\s+(.*)$/);
  if (!m) return { artist: '', title: base };
  return { artist: m[1].trim(), title: m[2].trim() };
}

/**
 * 递归收集一个目录下的音频文件。
 *
 * 跳过隐藏目录和常见的系统目录：`$RECYCLE.BIN`、`System Volume Information`
 * 这类要么没权限、要么扫出来全是噪音，撞上就整棵树卡住。
 */
function walk(dir, out = [], depth = 0) {
  if (depth > 12) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;   // 没权限的目录直接跳过，不因为一个子目录让整次扫描失败
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name.startsWith('.') || e.name.startsWith('$') || e.name === 'System Volume Information') continue;
      walk(full, out, depth + 1);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (!AUDIO_EXT.has(ext)) continue;
      // 标签**在这里读一次**就存下来：`matchSongs` 是「歌曲 × 文件」两重循环，
      // 在里面读标签会变成每对都开一次文件，几百首歌就能扫上几分钟。
      out.push({
        file: full,
        base: path.basename(e.name, path.extname(e.name)),
        ext,
        tag: readTags(full),
      });
    }
  }
  return out;
}

/** 让出一次事件循环：主进程不 yield 的话，扫描进度永远到不了渲染层。 */
const tick = () => new Promise((r) => setImmediate(r));

/**
 * 异步版 `walk`：只收集文件路径，不读标签。
 *
 * 分成「收集 → 读标签 → 匹配」三段是为了给进度条一个确定的分母：目录遍历
 * 本身很快但文件总数事先不知道，先走完这一遍，后面的进度才有 `done/total`。
 * 每 20 个文件 yield 一次，让 `local:progress` 的 IPC 有机会发出去。
 */
async function walkAsync(dir, out = [], depth = 0, onProgress) {
  if (depth > 12) return out;
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return out;   // 没权限的目录直接跳过，不因为一个子目录让整次扫描失败
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name.startsWith('.') || e.name.startsWith('$') || e.name === 'System Volume Information') continue;
      await walkAsync(full, out, depth + 1, onProgress);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (!AUDIO_EXT.has(ext)) continue;
      out.push(full);
      if (onProgress && out.length % 20 === 0) {
        onProgress({ phase: 'walk', pct: 2, found: out.length, file: e.name });
        await tick();
      }
    }
  }
  return out;
}

/**
 * 给「歌曲 × 文件」打分。分数越高越可信，0 表示不算匹配。
 *
 * **优先按标签（用户 m15635 第③点）**：文件里有 `TIT2`/`TALB`/`TPE1` 时，歌名
 * 必须与 `song.name` 精确相等（归一化后），再拿歌手、专辑加分。标签存在但歌名
 * 对不上就是 0 —— 不能因为标签「没帮上忙」就退回去猜文件名，那等于没改。
 *
 * 标签缺失（老文件、非 mp3/flac、用户自己拼的合集）才退回文件名，分三档：
 *   100  归一化后整名相等（`歌手 - 歌名` / `歌名 - 歌手` / 纯歌名 都算）
 *    80  文件名拆出的歌名与歌曲名完全相等（歌手部分可能是别名 / 缺省）
 *    60  歌名被包含在文件名里，且歌名够长（≥ 4 字）
 * 歌手参与打分：档内歌手也对得上的 +5，用来在同一个歌名有多个版本时选对。
 */
function score(song, f) {
  const name = norm(song.name);
  if (!name) return 0;

  const artists = [norm(song.artistText)];
  for (const a of song.artists || []) artists.push(norm(a.name));

  // ---------------------------------------------------------------- 标签路径
  const tag = f.tag;
  if (tag && tag.title) {
    if (norm(tag.title) !== name) return 0;
    const tArtist = norm(tag.artist);
    const tAlbum = norm(tag.album);
    const artistHit = tArtist && artists.some((a) => a && (a === tArtist || a.includes(tArtist) || tArtist.includes(a)));
    const albumHit = tAlbum && tAlbum === norm(song.albumName);
    // 标签里带了歌手、而歌里也有歌手，却两边都对不上 —— 这是同名的另一首歌
    // （翻唱、现场版、完全撞名），不能算匹配。专辑对得上时放行，用来兜住
    // 「标签的歌手写的是 Various Artists / 专辑艺人」这种合集情况。
    if (tArtist && artists.some(Boolean) && !artistHit && !albumHit) return 0;
    // 歌名相等已经是强证据；歌手对上再 +8、专辑对上 +4，用来在「同名不同版本」
    // 里挑对那一份（现场版、翻唱、同名不同专辑都靠这两档分开）。
    return 100 + (artistHit ? 8 : 0) + (albumHit ? 4 : 0);
  }

  // -------------------------------------------------------------- 文件名路径
  const fBase = norm(f.base);
  const fArtist = norm(song.artistText || (song.artists || []).map((a) => a.name).join('/'));
  const parts = splitBase(f.base);
  const fTitle = norm(parts.title);
  const fArtistOnly = norm(parts.artist);
  const artistHit = artists.some((a) => a && (fArtistOnly === a || fArtistOnly.includes(a) || a.includes(fArtistOnly)));

  if (fBase === name) return 100;
  if (fArtist && (fBase === fArtist + name || fBase === name + fArtist)) return 100;
  if (fTitle && fTitle === name) return artistHit ? 85 : 80;
  if (name.length >= 4 && fBase.includes(name)) return artistHit ? 65 : 60;
  return 0;
}

/**
 * 把一批歌曲和一批文件配上对。
 *
 * 做法是「先给每首歌挑出所有够格的文件，再按分数从高到低贪心分配」——
 * 一个文件只能给一首歌，一首歌也只要一个文件。贪心按分数降序做，所以
 * 分数高的先占位，剩下的低分自然被挤掉，不会出现「A 抢走了本该属于 B 的
 * 那个精确同名文件」。
 */
function matchSongs(songs, files) {
  const cands = [];
  for (const song of songs) {
    for (const f of files) {
      const s = score(song, f);
      if (s > 0) cands.push({ id: song.id, file: f.file, base: f.base, s });
    }
  }
  cands.sort((a, b) => b.s - a.s || a.base.length - b.base.length);

  const usedFile = new Set();
  const bySong = new Map();
  for (const c of cands) {
    if (bySong.has(c.id) || usedFile.has(c.file)) continue;
    bySong.set(c.id, c.file);
    usedFile.add(c.file);
  }
  return bySong;
}

/**
 * Windows 路径 → `file://` URL。
 *
 * 渲染层是 `file://` 页面，实测 `<audio src="file:///...">` 能直接播、还能
 * 拖动进度（Chromium 自己处理 Range），所以不必另开一个自定义协议。
 *
 * 直接用 node 的 `pathToFileURL` 而不是自己拼字符串：歌名里出现 `#`、`?`、
 * `%` 的概率不低（`#1`、`What?`），手拼很容易漏掉转义，漏掉之后 `#` 之后
 * 的部分会被当成 fragment 丢掉，文件直接打不开。
 */
function toFileUrl(p) {
  return pathToFileURL(String(p)).href;
}

function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/**
 * 音质档高低，越大越好（用户 m11461 第③点）。认不出的档一律按最低算。
 *
 * 与 `download.js` 的 `TIERS` 同序，`hires` 当 `lossless`（服务端两者回的是同一份
 * FLAC，见 download.js:100 的说明）。
 */
const QUALITY_RANK = { standard: 0, higher: 1, exhigh: 2, lossless: 3, hires: 3 };

function rankOf(q) {
  const r = QUALITY_RANK[String(q || '')];
  return r == null ? -1 : r;
}

/**
 * 本地索引。
 *
 * 依赖注入 `getIndexPath()` 而不是自己去问 electron 的 app —— 这样这个文件
 * 不直接依赖 electron，单独跑测试也容易。
 */
class LocalIndex {
  constructor({ getIndexPath }) {
    this.getIndexPath = getIndexPath;
    /**
     * 歌曲 id → `{ file, quality }`。
     *
     * `quality` 是用户 m11461 第③点加的：以前索引只记 id → 路径，于是「本地有这首
     * 歌」和「本地有这首歌的无损版」是同一件事 —— 用户在播放页从极高切到无损，
     * 播放器拿到的还是同一个 320k 文件，听起来当然没变化。现在下载完成时把档位
     * 一起存进来，切档时先问一句「本地这份够不够」，够就用本地的（不费流量），
     * 不够才去取新流。
     *
     * 空串表示**不知道**：用户自己扫进来的文件没有下载记录，读标签要知道每首歌
     * 什么音质得为每个文件开一次流，几千首的目录要扫十几秒。不知道就当成「够格」
     * —— 用户自己放进来的文件，宁可用它也别为了一个我们没记过的档位去重新下载。
     *
     * @type {Map<number, {file: string, quality: string}>}
     */
    this.map = new Map();
    /** @type {string[]} 扫过的目录，只用来在界面上说明「索引是哪来的」 */
    this.dirs = [];
    this.at = 0;
    this._loaded = false;
  }

  /** 懒加载：第一次用到才读盘，主进程启动时不必等它。 */
  load() {
    if (this._loaded) return this;
    this._loaded = true;
    const p = this.getIndexPath();
    if (!p) return this;
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      for (const [k, v] of Object.entries(j.map || {})) {
        const id = Number(k);
        if (!id) continue;
        // 老索引存的是裸字符串路径（m11461 之前），读进来当作「音质未知」。
        // 不迁移的话升级一次用户就得重扫一遍整个目录。
        if (typeof v === 'string') this.map.set(id, { file: v, quality: '' });
        else if (v && typeof v.file === 'string') {
          this.map.set(id, { file: v.file, quality: String(v.quality || '') });
        }
      }
      this.dirs = Array.isArray(j.dirs) ? j.dirs.filter((d) => typeof d === 'string') : [];
      this.at = Number(j.at) || 0;
    } catch {
      // 没有索引 / 索引坏了都当空的重来，不是错误
    }
    return this;
  }

  save() {
    const p = this.getIndexPath();
    if (!p) return;
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const map = {};
      for (const [k, v] of this.map) map[k] = v;
      fs.writeFileSync(p, JSON.stringify({ version: 1, dirs: this.dirs, at: this.at, map }));
    } catch { /* 索引写不进去不影响本次会话的使用 */ }
  }

  /** 已匹配到的歌曲 id 列表 —— 渲染层拿它决定哪些行的「√」要亮。 */
  ids() {
    this.load();
    return [...this.map.keys()];
  }

  /**
   * 索引的完整内容，给「已下载音乐」页当列表数据用（m01537 第②点）。
   *
   * 这一页以前画的是**下载任务**，所以本地扫描扫出来的歌在界面上根本不存在 ——
   * 扫描只写这张表，页面却不读它，用户看到的就是「扫出来了但不显示」。现在页面
   * 照这张表画，索引里有什么就显示什么。
   *
   * 每一条带回 `mtime` / `size` / `name`：
   * - `mtime` 用来排序 —— 这一页按「最近拿到的排前面」排，扫进来的文件没有下载
   *   时间可查，文件的修改时间是最接近的替代（下载完成时刚写过盘，就是那一刻）。
   * - `name` 是文件名，用来在取不到歌曲详情时（下架 / 接口失败）兜底显示，
   *   否则列表里会出现一行空白。
   *
   * 文件已经不在了的条目顺手剔掉：这一页是「本机有哪些歌」的唯一出口，留着
   * 不存在的路径点一下就播不出来。
   */
  entries() {
    this.load();
    const out = [];
    let dropped = 0;
    for (const [id, entry] of this.map) {
      let st = null;
      try { st = fs.statSync(entry.file); } catch { st = null; }
      if (!st || !st.isFile()) { this.map.delete(id); dropped++; continue; }
      out.push({
        id,
        file: entry.file,
        quality: entry.quality || '',
        name: path.basename(entry.file),
        size: st.size,
        mtime: st.mtimeMs || st.mtime.getTime(),
      });
    }
    if (dropped) this.save();
    return out;
  }

  /**
   * 查一首歌的本地文件。
   *
   * 每次都 `existsSync` 一下：用户在资源管理器里把文件删了 / 挪走了，
   * 索引不该继续宣称「本机有」。一次同步 stat 的代价可以忽略，而
   * 拿一个已经不存在的路径去喂 `<audio>` 会得到一个没有解释的播放失败。
   *
   * 第二个参数 `want` 是用户当前选的音质（用户 m11461 第③点）：给了就在返回值
   * 里带上 `satisfied`，说明本地这份够不够这一档。不够时**仍然返回这条记录**、
   * 只是 `satisfied: false`，由调用方决定去取新流 —— 不能在这里返回 null，
   * 因为 null 在调用方那边的语义是「文件不在了」，会顺手把索引删掉。
   *
   * 为什么用「够不够」而不是「等不等」：本地是 320k 而用户选了 128k 时放 320k
   * 谁也不吃亏（省流量是目的，音质更好不是问题）；反过来本地 128k 而用户要无损，
   * 就必须走网络 —— 那正是用户点这一档的意思。
   */
  resolve(id, want) {
    this.load();
    const entry = this.map.get(Number(id));
    if (!entry) return null;
    const file = entry.file;
    if (!fs.existsSync(file)) {
      this.map.delete(Number(id));
      this.save();
      return null;
    }
    const q = entry.quality || '';
    // 不知道档位（扫进来的文件）一律算够 —— 用户自己放进来的文件，宁可用它，
    // 也别为了一个我们没记过的档位去重新下载。
    const satisfied = !want || !q || rankOf(q) >= rankOf(want);
    return {
      file,
      url: toFileUrl(file),
      mime: mimeFor(file),
      name: path.basename(file),
      quality: q,
      satisfied,
    };
  }

  /** 这首歌本地那份是什么音质；空串表示不知道（扫进来的文件）。 */
  qualityOf(id) {
    this.load();
    return this.map.get(Number(id))?.quality || '';
  }

  /**
   * 只剔掉一首歌的索引条目（m36690 第⑥点）。
   *
   * `resolve()` 发现文件不在了会自己删，但那条路不给渲染层任何反馈；播放器还
   * 需要一个「文件明明在、内容却解不了码」的上报口 —— 那种坏法 `existsSync`
   * 看着一切正常，索引自己是永远发现不了的，只能靠真正播过一次的人告诉它。
   *
   * 返回是否真的删掉了，界面可以据此决定要不要重画。
   */
  drop(id) {
    this.load();
    const n = Number(id);
    if (!n) return false;
    const had = this.map.delete(n);
    if (had) this.save();
    return had;
  }

  /**
   * 登记一个「本机确实有这个文件」的歌曲（扫描匹配、下载完成都走这里）。
   *
   * [quality] 是下载时用的档位（用户 m11461 第③点）。扫描进来的文件不传 ——
   * 「不知道」比「猜一个」诚实，见构造里 `this.map` 的说明。
   */
  add(id, file, quality) {
    this.load();
    const n = Number(id);
    if (!n || !file) return false;
    this.map.set(n, { file, quality: String(quality || '') });
    return true;
  }

  /**
   * 扫描一个目录并和 songs 配对，结果并进索引。
   *
   * 返回的 `matched` 是**这一次**新配上的（渲染层要报「匹配到 N 首」），
   * `total` 是索引里的总条数。
   *
   * 扫描**不动**已经有下载记录的条目：那些条目带着音质档位，重扫一遍把档位
   * 抹成「不知道」会让用户刚切到无损就又被拽回 320k 那份文件。
   */
  scan(dir, songs) {
    this.load();
    const files = walk(dir);
    const bySong = matchSongs(songs || [], files);
    for (const [id, file] of bySong) {
      const old = this.map.get(id);
      this.map.set(id, { file, quality: old ? old.quality : '' });
    }
    if (dir && !this.dirs.includes(dir)) this.dirs.push(dir);
    this.at = Date.now();
    this.save();
    return {
      ok: true,
      dir,
      files: files.length,
      matched: bySong.size,
      total: this.map.size,
      // 这次没配上的歌名，界面上可以据此提示「还有 N 首没找到」
      unmatched: (songs || []).filter((s) => !bySong.has(s.id)).length,
    };
  }

  /**
   * 扫描一个目录并和 songs 配对，**边扫边报进度**（m00001 第②点）。
   *
   * 与 [scan] 的结果完全一样，只是把同步流程拆成三段并让出事件循环：
   *   1. 遍历目录收集音频文件（phase=walk）—— 这一步事先不知道总数，
   *      进度条只显示「已找到 N 个」；
   *   2. 逐个读标签（phase=tags）—— 有了总数，进度条按 `done/total` 走，
   *      同时把当前文件名推给界面；
   *   3. 拿全部文件去和歌曲配对（phase=match）—— 这一步按歌曲数走。
   *
   * 为什么要读标签这一段占大头：`readTags` 要开文件读头部，一个几千首的
   * 音乐库能花十几秒，正是用户「看着界面不动」的那一段。
   *
   * @param {(p: object) => void} [onProgress] 进度回调（主进程里接到 broadcast）
   */
  async scanAsync(dir, songs, onProgress) {
    this.load();
    const report = (p) => { if (onProgress) onProgress(p); };

    report({ phase: 'walk', pct: 1, found: 0, file: '' });
    const paths = await walkAsync(dir, [], 0, report);
    const total = paths.length;
    report({ phase: 'walk', pct: 4, found: total, file: '' });

    const files = [];
    for (let i = 0; i < total; i++) {
      const full = paths[i];
      const name = path.basename(full);
      const ext = path.extname(name).toLowerCase();
      files.push({
        file: full,
        base: path.basename(name, ext),
        ext,
        tag: readTags(full),
      });
      // 每 8 个文件推一次：太少会把 IPC 刷爆，太多进度条会一跳一大截。
      // 短目录（< 8 个）也保证至少推一次，否则界面一直停在准备阶段。
      if (i % 8 === 0 || i === total - 1) {
        report({
          phase: 'tags',
          // 5% ~ 85% 给读标签，剩下的留给匹配
          pct: total ? 5 + Math.round(((i + 1) / total) * 80) : 85,
          done: i + 1,
          total,
          file: name,
        });
        await tick();
      }
    }

    const list = songs || [];
    const bySong = new Map();
    const usedFile = new Set();
    for (let i = 0; i < list.length; i++) {
      const song = list[i];
      // 每首歌只跟自己最高分的那个文件配：和 `matchSongs` 的贪心是同一个
      // 结果口径（先按分数排序再分配），但可以逐首报进度。
      const cands = [];
      for (const f of files) {
        if (usedFile.has(f.file)) continue;
        const s = score(song, f);
        if (s > 0) cands.push({ f, s });
      }
      cands.sort((a, b) => b.s - a.s || a.f.base.length - b.f.base.length);
      if (cands.length) {
        bySong.set(song.id, cands[0].f.file);
        usedFile.add(cands[0].f.file);
      }
      if (i % 20 === 0 || i === list.length - 1) {
        report({
          phase: 'match',
          pct: list.length ? 85 + Math.round(((i + 1) / list.length) * 14) : 99,
          done: i + 1,
          total: list.length,
          file: song.name || '',
        });
        await tick();
      }
    }

    for (const [id, file] of bySong) {
      const old = this.map.get(id);
      this.map.set(id, { file, quality: old ? old.quality : '' });
    }
    if (dir && !this.dirs.includes(dir)) this.dirs.push(dir);
    this.at = Date.now();
    this.save();
    report({ phase: 'done', pct: 100, done: total, total, file: '' });
    return {
      ok: true,
      dir,
      files: files.length,
      matched: bySong.size,
      total: this.map.size,
      unmatched: list.filter((s) => !bySong.has(s.id)).length,
    };
  }

  /**
   * 剔掉索引里已经失效的条目（文件被删 / 挪走 / 改名）。
   *
   * `resolve()` 每次都会 stat，所以单首歌的失效是自愈的；但「已下载音乐」页
   * 要给出一个总数，而那个总数只能靠把整张表走一遍才能得到 —— 否则页面上写
   * 「40 首」，其中 5 个文件早就没了，用户点播放才发现。
   *
   * 返回剔掉了多少条，界面可以如实报出来（不说的话用户会以为点击没生效）。
   */
  prune() {
    this.load();
    let removed = 0;
    for (const [id, entry] of [...this.map]) {
      if (!fs.existsSync(entry.file)) { this.map.delete(id); removed++; }
    }
    if (removed) this.save();
    return { ok: true, removed, total: this.map.size };
  }

  forget() {
    this.map.clear();
    this.dirs = [];
    this.at = 0;
    this.save();
    return { ok: true };
  }

  /**
   * 当前索引的概况，设置页 / 侧栏计数 / 提示里用。
   *
   * `count` 用去掉「文件已经不在了」的条目之后的条数（m01537 第①点）：侧栏
   * 「已下载音乐」的角标和这一页的列表必须是同一个数，否则用户会看到「角标
   * 398、页面 30 首」这种对不上的情况。`entries()` 顺手把失效条目从表里剔掉。
   */
  info() {
    this.load();
    const live = this.entries().length;
    return { count: live, dirs: [...this.dirs], at: this.at };
  }
}

module.exports = {
  LocalIndex, walk, walkAsync, matchSongs, score, norm, splitBase, toFileUrl, mimeFor, AUDIO_EXT, rankOf,
};
