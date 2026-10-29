'use strict';
/**
 * High-level NetEase Cloud Music API surface.
 * Every method takes plain JS values and returns plain JS objects, so the
 * renderer never sees a cookie, a signature or a raw envelope.
 */
const { NeteaseClient, ApiError } = require('./client.js');
const { md5 } = require('./crypto.js');

const QUALITY = {
  standard: { level: 'standard', br: 128000, label: '标准 128k' },
  higher: { level: 'higher', br: 192000, label: '较高 192k' },
  exhigh: { level: 'exhigh', br: 320000, label: '极高 320k' },
  lossless: { level: 'lossless', br: 999000, label: '无损 FLAC' },
  // hires 档已删除（用户 m36690 第④点）。实测服务端对 lossless 和 hires 返回的是
  // 同一个 FLAC（见 songUrlV1 的注释），留着只会让用户在两个一模一样的档位之间
  // 选，还以为「Hi-Res」真能拿到更高规格。老配置里的 hires 在各调用点折成 lossless。
};

/**
 * 传输层失败的统一返回（用户 m36690 第①点）。
 *
 * `tryGet` / `tryPost` 会把「网络不通、DNS 挂掉、接口 5xx、被风控」统统吞成
 * `{code, message}` 返回，这时响应里根本没有 `data` 数组。如果调用方直接写
 * `(j.data || [])[0] || {}`，拿到的就是「一首 url 为空的歌」——和「服务端明确
 * 说这首歌没版权」长得一模一样，渲染层只能报「暂无版权或已下架」。网络一抖
 * 就冤枉歌，这是必须分开的两件事。
 *
 * 所以：`data` 是数组 = 服务端答了（url 为空才是真的没版权 / 要会员）；
 *       `data` 不是数组 = 根本没问到，带 `failed: true` 让调用方按网络问题重试。
 */
function transportFailure(id, j, extra) {
  return Object.assign({
    id,
    url: null,
    br: 0,
    size: 0,
    fee: undefined,
    level: null,
    type: null,
    md5: null,
    trial: null,
    playable: false,
    failed: true,
    code: (j && j.code) != null ? j.code : -1,
    message: (j && j.message) || '网络请求失败',
  }, extra || {});
}

/** Comment resource ids are prefixed by type. */
const COMMENT_TYPE = {
  song: 'R_SO_4_',
  album: 'R_AL_3_',
  playlist: 'A_PL_0_',
  dj: 'R_DJ_3_',
  mv: 'R_MV_5_',
};

class Netease extends NeteaseClient {
  // ================= auth =================

  async account() {
    const j = await this.tryGet('/api/nuser/account/get');
    if (j.profile) this.profile = j.profile;
    else this.profile = null;
    return { loggedIn: !!j.profile, profile: j.profile || null, account: j.account || null };
  }

  /** ---- QR login ---- */
  async qrCreate() {
    // The unikey must come from the encrypted endpoint or the poll will 800.
    const j = await this.post('/login/qrcode/unikey', { type: 1 });
    return { key: j.unikey, url: `https://music.163.com/login?codekey=${j.unikey}` };
  }

  async qrPoll(key) {
    // 用户 m09508 第①点：扫码确认后电脑端还是没反应。
    //
    // 上一轮（m08537 第⑥点）以为是「803 的 cookie 在响应体里」没收，于是补了
    // 下面那段 `j.cookie` 的合并 —— 但那段代码**从来没执行过**：这里原本调的是
    // `tryPost`，而 `tryPost` 内部是 `try { post() } catch { return {code, message} }`，
    // `_parse` 见到 `code: 803 !== 200` 就抛 ApiError，`j.cookie` 连同 profile
    // 一起被吞掉，只留下一个裸 code。所以界面上永远停在「扫描成功，请在手机上确认」。
    //
    // 改成 `post(..., lenient = true)`：非 200 也把响应体原样返回，
    // 801/802/803/800 这四种「正常业务状态」才走得下去。
    // 外面仍要 try/catch —— lenient 只放行业务码，网络层异常照样要兜住。
    let j
    try {
      j = await this.post('/login/qrcode/client/login', { key, type: 1 }, true)
    } catch (e) {
      return { code: e.code ?? -1, message: e.message }
    }
    // 800 expired, 801 waiting, 802 scanned-awaiting-confirm, 803 success
    //
    // 用户 m08537 第⑥点：扫码确认后桌面端一直没反应。原因是 803 的登录态
    // **不走 `Set-Cookie`**，而是以 `cookie` 字符串塞在响应体里返回：
    //
    //   { "code": 803, "cookie": "MUSIC_U=...;;__csrf=...", "profile": {...} }
    //
    // 而 `_absorb()` 只读 `res.headers.getSetCookie()`，jar 里永远没有
    // MUSIC_U，于是 `isLoggedIn` 一直是 false —— 界面上就是「扫码成功了
    // 但什么都没发生」。这里把响应体里的 cookie 收进 jar。
    if (j && j.cookie) {
      // 分隔符可能是 `;` 也可能是 `;;`，两种都拆一遍。
      // 用「合并」而不是 `setCookieString`（那个会先 clear）：轮询过程中
      // 已经攒下的 NMTID 之类不该被这一串覆盖掉。
      for (const part of String(j.cookie).replace(/;;/g, ';').split(';')) {
        const i = part.indexOf('=');
        if (i > 0) this.cookies.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
      }
    }
    return { code: j.code, message: j.message, profile: j.profile || null, cookie: j.cookie || null };
  }

  /**
   * 手机号 + 密码登录（m03577 第⑧点修的就是这里）。
   *
   * 服务端要的是 `md5_password`，只带明文 `password` 会一律回 502，界面上
   * 就成了「账号或密码错误」——密码明明是对的，用户怎么试都进不来。
   * 所以先把密码做一次 MD5 再塞进 `password` 字段（密文接口那边按
   * `md5_password || MD5(password)` 取值，两者等价，用后者兼容性更好）。
   */
  async loginPhone(phone, password, countrycode = '86') {
    try {
      const j = await this.post('/login/cellphone', {
        phone: String(phone),
        password: md5(password),
        countrycode: String(countrycode),
        rememberLogin: 'true',
      });
      return { code: j.code, profile: j.profile || null, bindings: j.bindings || [] };
    } catch (e) {
      // 登录同样会撞账号级安全验证门 -462（换设备、短信验证码登录最常见）。
      // 以前这里直接抛，界面只能显示一句「需要先完成手机号或短信验证」，
      // 用户既不知道去哪儿验证、也不知道该做什么；现在按关注那套返回
      // needVerify + 验证参数，界面把二维码/验证链接摆出来即可。
      return loginOutcome(e);
    }
  }

  /**
   * 让请求看起来像 PC 网页端。
   *
   * 官方接口库（NeteaseCloudMusicApi 的 `login_cellphone.js`）在登录前会
   * `query.cookie.os = 'pc'`，短信登录这条链路上的两个接口也走的是网页端那份
   * 通行证。我们自己的 jar 里只有 MUSIC_U / NMTID，缺这个标识，服务端看到的
   * 就是一个「什么客户端都不是」的陌生会话，风控（-462）更容易直接命中。
   */
  _ensureOsCookie() {
    if (!this.cookies.has('os')) this.cookies.set('os', 'pc');
  }

  /** ---- phone + captcha (sms) ---- */
  async sendCaptcha(phone, countrycode = '86') {
    this._ensureOsCookie();
    return this.post('/sms/captcha/sent', { cellphone: String(phone), ctcode: String(countrycode) });
  }

  /**
   * 手机号 + 短信验证码登录。
   *
   * 验证码是**服务端**按当前账号/环境下发的，客户端指定不了位数（我们这边现在是
   * 4 位，官网某些入口是 6 位，都是同一条短信通道的不同策略）。能控制的是「把码提到
   * 哪个接口去」，历史上有三个口子，不同客户端版本分别用过，**不能只押一个**：
   *
   * 1. `/w/login/cellphone`：网易网页端登录页用的口子（官方接口库
   *    `login_cellphone.js` 就是打它，参数是 `type=1` + `https=true` + 手机号/验证码）。
   *    要对着官网走，就按这个形状发。
   * 2. `/login/cellphone` 带 `captcha`：老口子，用户自己的号走这条一直能登进去。
   * 3. `/sms/captcha/verify`：验证码**校验**接口，校验通过时响应里也带登录态。
   *
   * 依次试，谁成功就用谁；三条都失败时抛**最后一条**的真实错误（例如「验证码错误」）。
   * 一旦撞上 `-462` 且带着 `verifyToken`，立刻返回 `needVerify` 让界面弹安全验证
   * 二维码 —— 那是账号级风控，换接口没用，但这一步不能吞掉。
   */
  async loginCaptcha(phone, captcha, countrycode = '86') {
    this._ensureOsCookie();
    const cc = String(countrycode);
    const base = {
      phone: String(phone),
      captcha: String(captcha),
      countrycode: cc,
      rememberLogin: 'true',
    };
    const attempts = [
      ['/w/login/cellphone', { type: '1', https: 'true', ...base }],
      ['/login/cellphone', { ...base }],
      ['/sms/captcha/verify', { cellphone: String(phone), ctcode: cc, captcha: String(captcha) }],
    ];

    const attempt = async ([path, body]) => {
      try {
        const j = await this.post(path, body);
        // 有的实现回 200 但不下发登录态，所以两个条件都要看。
        if (j.code === 200 || this.isLoggedIn) {
          return { done: { code: 200, profile: j.profile || null } };
        }
        return { fail: { code: j.code, message: j.message || '登录失败', payload: j } };
      } catch (e) {
        try {
          const r = loginOutcome(e);
          if (r && r.needVerify) return { done: r };
        } catch (ignored) { /* 不是 -462：记下错误，继续试下一个口子 */ }
        return { fail: { code: e.code, message: e.message || '登录失败', payload: e.payload } };
      }
    };

    let last = null;
    for (const a of attempts) {
      const r = await attempt(a);
      if (r.done) return r.done;
      last = r.fail;
    }
    const err = new Error(last.message);
    err.code = last.code;
    err.payload = last.payload;
    throw err;
  }

  async logout() {
    const r = await this.tryPost('/logout', {});
    this.cookies.delete('MUSIC_U');
    this.profile = null;
    return r;
  }

  /** Export the jar so the app can persist a login across restarts. */
  exportCookie() {
    return this.getCookieString();
  }

  // ================= user content =================

  async userPlaylists(uid) {
    const j = await this.get('/api/user/playlist', { uid, limit: 1000, offset: 0, timestamp: Date.now() });
    const list = (j.playlist || []).map(normalizePlaylist);
    // 我喜欢的音乐 is specialType 5; make sure it is easy to find.
    const liked = list.find((p) => p.specialType === 5) || null;
    return { playlists: list, liked };
  }

  /**
   * @param {object} [opts]
   * @param {number} [opts.limit]   v6 的 n 参数（服务端对别人的歌单并不遵守）
   * @param {number} [opts.offset]
   * @param {boolean} [opts.tracks] 是否需要完整曲目表，默认 true。
   *   侧栏取封面只要 tracks[0].cover，那种调用必须传 false —— 否则每个歌单都会
   *   触发一次「拿 trackIds + 分批换歌」，四十个歌单就是几十次请求，
   *   而调用方只想要一个封面。
   */
  async playlistDetail(id, { limit = 1000, offset = 0, tracks: wantTracks = true } = {}) {
    const j = await this.get('/api/v6/playlist/detail', { id, n: limit, s: 8 });
    const pl = j.playlist || {};
    let tracks = (pl.tracks || []).map(normalizeSong);
    // v6 对「不是自己创建的歌单」只内联 ~20 条 tracks，但同一次响应里的
    // trackIds 永远是全量。补全只能靠 trackIds，不能靠 /api/playlist/track/all
    // —— 那个接口本客户端可达的两种方言下都是 404「接口未找到」。
    let complete = true;
    if (wantTracks && shouldPage(pl, tracks.length)) {
      const full = await this.playlistTrackIds(pl.trackIds);
      if (full.length > tracks.length) tracks = full;
      complete = !shouldPage(pl, tracks.length);
    }
    // tracks:false 时上面整块被跳过，但 complete 必须照样如实计算 ——
    // 侧栏那种调用只取了一首，不能对外声称「这是完整列表」。
    if (!wantTracks) complete = !shouldPage(pl, tracks.length);
    return {
      id: pl.id,
      name: pl.name,
      cover: pl.coverImgUrl,
      description: pl.description || '',
      creator: pl.creator ? { id: pl.creator.userId, name: pl.creator.nickname, avatar: pl.creator.avatarUrl } : null,
      trackCount: pl.trackCount || tracks.length,
      playCount: pl.playCount,
      specialType: pl.specialType,
      subscribed: pl.subscribed,
      // 歌单页要在创建者昵称后面显示创建时间。两个时间都是毫秒时间戳，
      // 老歌单可能只有 updateTime（createTime 为 0），交给渲染层判断。
      createTime: pl.createTime || 0,
      updateTime: pl.updateTime || 0,
      tracks,
      // 列表是否已经是全量。调用方据此决定要不要再补一次，省一次没必要的请求。
      // （曾经这里的判据是 tracks.length < trackCount，但补完之后两者相等，
      //  渲染层那个「超过 1000 首时后台补全」的分支就再也走不进去了。）
      complete,
    };
  }

  /**
   * 把一个歌单的**全部**曲目抓齐。
   *
   * 之前这里拼的是 `/api/playlist/track/all` —— 实测在 weapi 与 plain GET 两种
   * 方言下都返回 404「接口未找到」，于是 `if (j.songs?.length)` 永远不成立，
   * 函数静默回落成「只有 v6 内联的那 20 首」。用户看到的现象是：1633 首的
   * 歌单，页面统计写着「1633 首」，列表里却只有 20 行 —— 而且连滚动都补不出
   * 来（滚动补渲染读的是同一个数组）。
   *
   * 现在改成：拿全量 trackIds → `/v3/song/detail` 分批换回完整 song 对象。
   * 实测单批 1000 首仍然 code 200，但 1633 首会 code 400「参数错误」，所以
   * 每批 500 并留出余量；并发 4 路足够快（1633 首约 1.2s），再高容易触发频控。
   */
  async playlistTrackIds(trackIds) {
    const ids = (trackIds || []).map((t) => (typeof t === 'object' ? t.id : t)).filter(Boolean);
    if (!ids.length) return [];
    const BATCH = 500;
    const CONC = 4;
    const batches = [];
    for (let i = 0; i < ids.length; i += BATCH) batches.push(ids.slice(i, i + BATCH));

    const out = [];
    for (let i = 0; i < batches.length; i += CONC) {
      const got = await Promise.all(batches.slice(i, i + CONC).map(async (chunk) => {
        // ⚠️ 这里写 '/v3/song/detail' 而不是 '/api/v3/song/detail' —— post() 自己
        // 会拼上 /weapi 前缀，再带 /api 就成了 /weapi/api/v3/...，服务端回 404
        // 「接口未找到」，而 tryPost 会把 404 吞掉，结果就是静默少歌。
        const j = await this.tryPost('/v3/song/detail', {
          c: JSON.stringify(chunk.map((id) => ({ id }))),
        });
        return (j.songs || []).map(normalizeSong);
      }));
      for (const g of got) out.push(...g);
    }

    // song/detail 实测按请求顺序返回，但接口没有承诺过，所以按 trackIds 重排
    // 一次 —— 歌单顺序是用户自己排的，乱了比少了更让人恼火。
    const byId = new Map(out.map((s) => [s.id, s]));
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
    // 万一某个 id 没换回来，宁可少几首也不要留空洞
    return ordered.length ? ordered : out;
  }

  /** Full track list for a playlist, paged past the 1000 cap. */
  async playlistTracks(id, total) {
    // 已经带上全量判据：一次调用就把该抓的都抓了，调用方再问一遍是浪费。
    return this.playlistDetail(id);
  }

  /**
   * 每日推荐 —— 必须用 `/v1/discovery/recommend/songs`，不能用
   * `/discovery/recommend/songs`。
   *
   * 这两个接口名字几乎一样，但返回的是**两份完全不相交的列表**（实测 0 首重合）：
   *   - `/discovery/recommend/songs`  顶层裸 `recommend` 数组，32 首，泛流行，
   *     `alg` 是 `play_itembased_on` / `dis_itembased` 这类「猜你喜欢」算法，
   *     对 limit/offset 完全无反应。它是推荐流，不是每日推荐。
   *   - `/v1/discovery/recommend/songs` 带 `data.dailySongs`，`alg` 里清一色
   *     `alg-music-rec-unite-daily-*`，每首歌还带 `recommendReason`
   *     （"超75%人播放" / "NO.15 飙升榜"）。这才是网页版
   *     music.163.com/#/discover/recommend/taste 用的那份。
   *
   * 之前用前者，页面能渲染、也不报错，但推的歌和官方对不上，很难从表象发现。
   * 顶层 `recommend` 仍作为兜底保留（个别账号/区域只给这一种形状）。
   */
  async dailyRecommend() {
    const j = await this.post('/v1/discovery/recommend/songs', {});
    const songs = j.data?.dailySongs || j.recommend || [];
    return {
      songs: songs.map(normalizeSong),
      reason: (j.data && j.data.dailyRecommendReason) || '',
      date: new Date().toISOString().slice(0, 10),
    };
  }

  async recommendPlaylists() {
    const j = await this.tryGet('/api/personalized/playlist', { limit: 12 });
    return (j.result || []).map((p) => ({
      id: p.id, name: p.name, cover: p.picUrl, playCount: p.playCount,
      trackCount: p.trackCount,
    }));
  }

  // ================= 榜单 / 播客 =================

  /**
   * 榜单列表。`/api/toplist/detail` 一次返回全部 64 个榜单（含全球榜），
   * 每个榜单本身就是一个歌单 id，点进去直接复用 playlistDetail。
   */
  async toplists() {
    const j = await this.tryGet('/api/toplist/detail', {});
    return (j.list || []).map((t) => ({
      id: t.id,
      name: t.name,
      cover: t.coverImgUrl,
      updateFrequency: t.updateFrequency || '',
      trackCount: t.trackCount || 0,
      playCount: t.playCount || 0,
      description: t.description || '',
      // 官方榜 ToplistType=S/O/N，地区榜没有这个字段
      topType: t.ToplistType || '',
    }));
  }

  /**
   * 播客电台列表。
   *
   * `/api/djradio/recommend` 与 `/api/djradio/hot` 在当前 weapi 方言下都返回
   * `code 400`，`/api/djradio/detail` 更是 404（均已实测）。唯一稳定可用的
   * 数据源是 `/api/personalized/djprogram`：它按「推荐节目」返回，但每个节目
   * 里都嵌着完整的 `program.radio` 对象（name/picUrl/desc/programCount/
   * subCount/dj），把这些去重就是电台列表。
   */
  async podcasts(limit = 30) {
    const j = await this.tryGet('/api/personalized/djprogram', { limit });
    const seen = new Map();
    for (const it of j.result || []) {
      const r = it.program && it.program.radio;
      if (r && r.id && !seen.has(r.id)) seen.set(r.id, normalizeRadio(r));
    }
    return [...seen.values()];
  }

  /** 电台详情：同样只能从节目里反查，取任意一个该电台的节目即可。 */
  async podcastDetail(radioId) {
    const j = await this.tryGet('/api/dj/program/byradio', {
      radioId, limit: 1, offset: 0, asc: false,
    });
    const r = j.programs?.[0]?.radio;
    if (r) return normalizeRadio(r);
    return { id: Number(radioId), name: '', cover: '', desc: '', programCount: 0, subCount: 0, dj: null };
  }

  /** 电台的节目列表（按发布时间倒序）。 */
  async podcastPrograms(radioId, limit = 30, offset = 0) {
    const j = await this.tryGet('/api/dj/program/byradio', {
      radioId, limit, offset, asc: false,
    });
    const radio = j.programs?.[0]?.radio ? normalizeRadio(j.programs[0].radio) : null;
    return {
      radio,
      count: j.count || 0,
      more: !!j.more,
      programs: (j.programs || []).map(normalizeProgram),
    };
  }

  // ================= songs =================

  async songDetail(ids) {
    const idArr = Array.isArray(ids) ? ids : [ids];
    const j = await this.get('/api/v3/song/detail', { c: JSON.stringify(idArr.map((id) => ({ id }))) });
    return (j.songs || []).map(normalizeSong);
  }

  async songUrl(id, quality = 'exhigh') {
    const q = QUALITY[quality] || QUALITY.exhigh;
    const j = await this.tryGet('/api/song/enhance/player/url', {
      ids: JSON.stringify([id]), br: q.br,
    });
    if (!Array.isArray(j && j.data)) return transportFailure(id, j);
    const d = j.data[0] || {};
    return {
      id,
      url: d.url || null,
      br: d.br || 0,
      size: d.size || 0,
      fee: d.fee,
      level: d.level || null,
      type: d.type || null,
      md5: d.md5 || null,
      // freeTrialInfo present => only a preview clip is available
      trial: d.freeTrialInfo ? { start: d.freeTrialInfo.start, end: d.freeTrialInfo.end } : null,
      playable: !!d.url,
    };
  }

  /**
   * 取播放/下载直链（v1 方言）。
   *
   * `encodeType` 名义上是「拿到什么容器」的开关：无损要 flac，其余要 mp3。
   * 不传的话服务端会按 br 自己挑，可能给出 .m4a 之类，所以这里仍然显式给一个。
   *
   * ⚠️ 实测结论（m35069 第 3 点）：**服务端基本忽略 `encodeType`，容器由 `level`
   * 决定** —— `level=lossless` 时不管 encodeType 传什么都回 FLAC，
   * `level<=exhigh` 才回 MP3。正因为 lossless 与 hires 回来的 FLAC 完全一样
   * （用户 m36690 第④点），hires 档已经删掉。
   *
   * 也就是说「要什么格式」= 「选哪一档」，调用方（下载队列）靠 `level` 选档，
   * 再用返回的 `type` 做容器白名单。用户 m36467 的口径是 MP3 或 FLAC 都行，
   * 只要不是私有格式，所以这里不再把 level 封在 exhigh。
   */
  async songUrlV1(id, quality = 'exhigh', encodeType) {
    const q = QUALITY[quality] || QUALITY.exhigh;
    const lossless = quality === 'lossless';
    const enc = encodeType || (lossless ? 'flac' : 'mp3');
    const j = await this.tryGet('/api/song/enhance/player/url/v1', {
      ids: JSON.stringify([id]), level: q.level, encodeType: enc,
    });
    if (!Array.isArray(j && j.data)) return transportFailure(id, j);
    const d = j.data[0] || {};
    return {
      url: d.url || null,
      br: d.br || 0,
      size: d.size || 0,
      level: d.level,
      // `type` 是服务端真正给出的容器（mp3 / flac / m4a…），下载时以它为准定后缀
      type: d.type || null,
      fee: d.fee,
      // 只有试听片段（非会员点会员曲）时必须能认出来：把 30 秒试听存成
      // 「整首」比直接失败更糟 —— 用户以为下好了。
      trial: d.freeTrialInfo ? { start: d.freeTrialInfo.start, end: d.freeTrialInfo.end } : null,
      playable: !!d.url,
    };
  }

  /** Batch URLs — one call for a whole queue, much faster than per-song. */
  async songUrls(ids, quality = 'exhigh') {
    const q = QUALITY[quality] || QUALITY.exhigh;
    const out = {};
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const j = await this.tryGet('/api/song/enhance/player/url', {
        ids: JSON.stringify(chunk), br: q.br,
      });
      for (const d of j.data || []) {
        out[d.id] = { url: d.url || null, br: d.br, size: d.size, fee: d.fee, playable: !!d.url, trial: d.freeTrialInfo || null };
      }
    }
    return out;
  }

  async lyrics(id) {
    const j = await this.tryGet('/api/song/lyric', { id, lv: -1, kv: -1, tv: -1 });
    return {
      lrc: j.lrc?.lyric || '',
      tlyric: j.tlyric?.lyric || '',
      romalrc: j.romalrc?.lyric || '',
      klyric: j.klyric?.lyric || '',
    };
  }

  async comments(type, id, limit = 20, offset = 0) {
    // Accept either (type, id, limit, offset) or (type, id, {limit, offset}).
    if (limit && typeof limit === 'object') {
      offset = limit.offset || 0;
      limit = limit.limit || 20;
    }
    const prefix = COMMENT_TYPE[type] || COMMENT_TYPE.song;
    const j = await this.get(`/api/v1/resource/comments/${prefix}${id}`, {
      limit, offset, beforeTime: 0,
    });
    return {
      total: j.total || 0,
      more: !!j.more,
      hot: (j.hotComments || []).map(normalizeComment),
      latest: (j.comments || []).map(normalizeComment),
    };
  }

  /**
   * 评论点赞 / 取消点赞。`threadId` 是带类型前缀的资源 id（`R_SO_4_<id>` 等）。
   *
   * 只有 weapi 方言认这两个路径，且**点赞与取消点赞是两个不同的接口**：
   * 点赞 `POST /v1/comment/like`（`type: 0`），取消 `POST /v1/comment/unlike`
   * （`type: 1`）。把取消也发到 like 上（或反过来）只会拿到 250。
   *
   * 注意 `post()` 会自己补 `/weapi` 前缀，所以这里给的是 `/v1/...` 而不是
   * `/api/v1/...` —— 后者会拼成 `/weapi/api/v1/...`，服务端回 `404 接口未找到`。
   *
   * **当前账号上「点赞」被网易云的风控门挡住**：三种方言（weapi、App 的
   * `interface.music.163.com`、eapi）都只回 `{"code":250,"msg":"点赞异常，
   * 请稍后再试！"}`；同一 cookie 下歌曲喜欢回 `524 当前环境异常，已取消喜欢`，
   * 而所有「取消」类写操作（取消点赞、取消喜欢、取消收藏）一律回 200。这是
   * 账号级的 add 门，不是参数、header 或方言问题，客户端绕不过去。所以这里
   * 如实把 250 交回上层，由渲染层做「乐观更新 + 失败回滚 + 如实提示」，
   * 绝不伪造成功。取消点赞是通的（官方 App 里点过赞的评论在这里能取消）。
   */
  async commentLike(threadId, commentId, like = true) {
    const uri = like ? '/v1/comment/like' : '/v1/comment/unlike';
    const j = await this.tryPost(uri, {
      threadId: String(threadId),
      commentId: String(commentId),
      type: like ? 0 : 1,
    });
    if (j && j.code === 200) return { ok: true, liked: !!like };
    return {
      ok: false,
      code: (j && j.code) || -1,
      message: (j && (j.message || j.msg)) || '操作失败',
    };
  }

  /**
   * Ids of every song the user has hearted. Returns a plain array (IPC-safe).
   *
   * `/api/song/like` is the cheap endpoint for this but it currently answers
   * `code 400 请求参数错误` for every uid we have tried, which would silently
   * render every heart as empty. Fall back to reading the tracks of the
   * specialType-5 playlist ("我喜欢的音乐") — same data, one extra request, and
   * it is the only source we could verify to work.
   */
  async likedIds(uid) {
    const j = await this.tryGet('/api/song/like', { uid, timestamp: Date.now() });
    if (Array.isArray(j.ids)) return j.ids;

    const { liked } = await this.userPlaylists(uid);
    if (!liked) return [];
    const pl = await this.playlistTracks(liked.id, liked.trackCount);
    return pl.tracks.map((s) => s.id);
  }

  /**
   * 用户主页详情。`/api/v1/user/detail/<uid>` 把等级/听歌数等统计放在顶层，
   * 个人资料放在 `profile` 里 —— 两者要合并成一个对象，否则调用方拿到
   * `profile.follows` 会漏掉 `level` / `listenSongs`。
   */
  async userDetail(uid) {
    const j = await this.get(`/api/v1/user/detail/${uid}`, {});
    const p = j.profile || {};
    return {
      id: p.userId || Number(uid),
      nickname: p.nickname || '',
      avatar: p.avatarUrl || '',
      background: p.backgroundUrl || '',
      signature: p.signature || '',
      gender: p.gender,
      city: p.city,
      province: p.province,
      birthday: p.birthday,
      description: p.description || '',
      vipType: p.vipType || 0,
      follows: p.follows || 0,
      followeds: p.followeds || 0,
      playlistCount: p.playlistCount || 0,
      eventCount: p.eventCount || 0,
      createTime: p.createTime || 0,
      level: j.level || 0,
      listenSongs: j.listenSongs || 0,
      // 网易云默认对陌生人的听歌排行设隐私，页面据此提示而不是显示空列表
      recordVisible: j.peopleCanSeeMyPlayRecord !== false,
      followed: !!p.followed,
      followMe: !!p.followMe,
      mutual: !!p.mutual,
      // 今日是否已签到。`/api/v1/user/detail` 顶层就带这个字段，用它把签到按钮
      // 直接渲染成「今日已签到」，用户不必点一下才发现已经签过。
      pcSign: !!j.pcSign,
    };
  }

  /**
   * 最近播放（听歌排行）。
   * `type=0` 才是全部记录，`type=1` 只返回 `weekData`（一周）；只读后者会得到
   * 空列表。返回的 song 是完整对象，可直接交给 normalizeSong。
   */
  async playRecord(uid, type = 0) {
    const j = await this.get('/api/v1/play/record', { uid, type });
    const arr = type === 1 ? (j.weekData || []) : (j.allData || j.weekData || []);
    return {
      songs: arr.map((it) => ({ ...normalizeSong(it.song), playCount: it.playCount || 0, score: it.score || 0 })),
      total: arr.length,
    };
  }

  /**
   * 每日签到。只有 `type=1`（pc 端）真的能签到，`type=0`（app 端）返回
   * `{code:200, msg:"功能暂不支持"}` 会被误判成成功。今日已签时服务端返回
   * `code:-2 "重复签到"`，调用方据此区分「刚签上」与「今天已经签过」。
   */
  async dailyTask(type = 1) {
    const j = await this.tryPost('/point/dailyTask', { type });
    return { ok: j.code === 200, already: j.code === -2, point: j.point || 0, code: j.code, message: j.message || j.msg || '' };
  }

  /** 等级详情：进度与升级所需播放/登录次数。 */
  async userLevel(uid) {
    const j = await this.tryPost('/user/level', { uid });
    const d = j.data || {};
    return {
      level: d.level || 0, info: d.info || '', progress: d.progress || 0,
      nowPlayCount: d.nowPlayCount || 0, nextPlayCount: d.nextPlayCount || 0,
      nowLoginCount: d.nowLoginCount || 0, nextLoginCount: d.nextLoginCount || 0,
    };
  }

  /**
   * 关注列表。uid 必须嵌在路径里：`/api/user/getfollows?uid=` 返回 404，
   * `/api/user/getfollows/<uid>` 才返回 `{follow, more, touchCount}`。
   */
  async follows(uid, limit = 30, offset = 0) {
    const j = await this.get(`/api/user/getfollows/${uid}`, { offset, limit });
    return { users: (j.follow || []).map(normalizeUser), more: !!j.more, total: j.touchCount || 0 };
  }

  /**
   * 粉丝列表。与关注列表不同，这个走 weapi POST 且 uid 放在 body 里
   * （`{userId, offset, limit, time}`），路径带 uid 反而失败。
   */
  async followeds(uid, limit = 30, offset = 0) {
    const j = await this.tryPost('/user/getfolloweds', { userId: uid, offset, limit, time: 0 });
    return { users: (j.followeds || []).map(normalizeUser), more: !!j.more, total: j.newCount || 0 };
  }

  // ================= write operations =================

  async playlistAdd(pid, trackIds) {
    return this.post('/playlist/manipulate/tracks', {
      op: 'add', pid: String(pid), trackIds: JSON.stringify(trackIds.map(Number)), imme: 'true',
    });
  }

  async playlistRemove(pid, trackIds) {
    return this.post('/playlist/manipulate/tracks', {
      op: 'del', pid: String(pid), trackIds: JSON.stringify(trackIds.map(Number)), imme: 'true',
    });
  }

  async playlistCreate(name, privacy = 0) {
    const j = await this.post('/playlist/create', {
      name, privacy: String(privacy), type: 'NORMAL',
    });
    const id = j.id || j.playlist?.id;
    return { id, playlist: { id, name: j.playlist?.name || name, cover: j.playlist?.coverImgUrl } };
  }

  async playlistDelete(pid) {
    return this.post('/playlist/delete', { pid: String(pid) });
  }

  async playlistUpdate(id, data) {
    return this.post('/playlist/update', Object.assign({ id: String(id) }, data));
  }

  /**
   * Heart / un-heart a track.
   *
   * Uses `/weapi/song/like`, not the older `/weapi/radio/like`: on a real
   * account `radio/like` answers `-460 检测到您的网络环境存在风险` for every
   * parameter shape tried (alg/time present or not, `like` as string or
   * boolean, csrf in the body), while `song/like` on the same cookie returns
   * `{playlistId, code:200}` and the track really lands in 我喜欢的音乐.
   * `radio/like` is kept as a fallback in case `song/like` is ever retired.
   */
  async like(trackId, like = true) {
    const want = String(!!like);
    try {
      const j = await this.post('/song/like', { trackId: String(trackId), like: want });
      if (j && j.code === 200) return j;
    } catch (e) { /* fall through to the legacy endpoint */ }
    return this.post('/radio/like', {
      trackId: String(trackId), like: want, alg: 'itembased', time: '3',
    });
  }

  /**
   * 收藏 / 取消收藏歌单。
   *
   * 取消收藏必须走 `/weapi/playlist/unsubscribe`：`/weapi/playlist/subscribe`
   * 只认 t=1，带 `t:0` 过去会被服务端判成参数非法并回 `code 501`（实测
   * `{"code":501,"msg":"..."}`），界面上就是「点取消收藏报错 code 501」。
   * 收藏则继续用 subscribe + t=1。
   */
  async subscribePlaylist(id, subscribe = true) {
    if (!subscribe) return this.post('/playlist/unsubscribe', { id: String(id) });
    return this.post('/playlist/subscribe', { id: String(id), t: 1 });
  }

  async scrobble(id, sourceId, time = 0) {
    return this.tryPost('/scrobble', {
      id: String(id), sourceid: String(sourceId), time: String(time), total: '0',
    });
  }

  // ================= search =================

  /**
   * Search across songs / playlists / artists / albums.
   *
   * Uses `/api/cloudsearch/pc` rather than `/api/search/get/web`: the legacy
   * endpoint returns album objects carrying only `picId` (no `picUrl`), so every
   * song row came back without cover art. cloudsearch returns the modern shape
   * (`al.picUrl`, `ar`, `dt`) for songs and real cover URLs for the other types.
   */
  async search(keyword, type = 1, limit = 30, offset = 0) {
    if (limit && typeof limit === 'object') {
      offset = limit.offset || 0;
      limit = limit.limit || 30;
    }
    const j = await this.get('/api/cloudsearch/pc', { s: keyword, type, offset, limit });
    const r = j.result || {};
    const out = { songs: [], playlists: [], artists: [], albums: [], users: [], count: 0 };
    if (type === 1) {
      out.songs = (r.songs || []).map(normalizeSong);
      out.count = r.songCount || 0;
    } else if (type === 1000) {
      out.playlists = (r.playlists || []).map(normalizePlaylist);
      out.count = r.playlistCount || 0;
    } else if (type === 100) {
      out.artists = (r.artists || []).map((a) => ({
        id: a.id, name: a.name, cover: a.picUrl, albumSize: a.albumSize, musicSize: a.musicSize, alias: a.alias,
      }));
      out.count = r.artistCount || 0;
    } else if (type === 10) {
      out.albums = (r.albums || []).map((a) => ({
        id: a.id, name: a.name, cover: a.picUrl || a.blurPicUrl, artist: a.artist?.name, size: a.size,
      }));
      out.count = r.albumCount || 0;
    } else if (type === 1002) {
      // 用户搜索（用户 m03593 第②点）。cloudsearch 把用户放在 `userprofiles`，
      // 计数字段是 `userprofileCount`（不是 userCount）—— 探针
      // `_probe/probe-search-user.mjs` 实测确认过，字段名和关注列表接口回的是同一套
      // （userId / nickname / avatarUrl / signature / followed / mutual…），
      // 所以直接复用 normalizeUser 与渲染进程已有的 userCard。
      out.users = (r.userprofiles || []).map(normalizeUser);
      out.count = r.userprofileCount || 0;
    }
    return out;
  }

  // ================= artist / album =================

  async artistSongs(id, limit = 50, offset = 0) {
    if (limit && typeof limit === 'object') {
      offset = limit.offset || 0;
      limit = limit.limit || 50;
    }
    const j = await this.tryGet('/api/v1/artist/songs', { id, limit, offset, order: 'hot' });
    return (j.songs || []).map(normalizeSong);
  }

  /**
   * 歌手**全部**作品（分页）。
   *
   * 与上面的 `artistSongs` 是同一条接口，区别只在「要第几页」：桌面歌手页的
   * 「全部歌曲」得能一路翻到底（有的歌手 2500+ 首），所以这里把服务端的
   * `total` / `more` 一起带回去，界面才能画「已加载 200 / 共 2573 首」。
   * 顺序仍用 `hot`，与「热门歌曲」同一个口径，第一页就是热歌。
   */
  async artistAllSongs(id, limit = 100, offset = 0) {
    const j = await this.tryGet('/api/v1/artist/songs', { id, limit, offset, order: 'hot' });
    const songs = (j.songs || []).map(normalizeSong);
    return {
      songs,
      total: Number.isFinite(j.total) ? j.total : songs.length,
      more: j.more === undefined ? songs.length >= limit : !!j.more,
    };
  }

  /**
   * 音乐云盘列表（用户 m05071 第④点）。
   *
   * 走 `/api/cloud/get`：实测 `limit` / `offset` / `all` 三个参数都认，返回
   * `{ data, count, size, maxSize, hasMore }` —— `count` 是云盘里一共几首、
   * `size` / `maxSize` 是已用 / 总容量字节数，云盘页的头部统计就靠它们。
   *
   * `data[]` 的每一项是云盘记录（`songId` / `songName` / `artist` / `album` /
   * `fileSize` / `bitrate` / `simpleSong`），`simpleSong` 里是完整的歌曲对象，
   * 所以优先用它归一化；万一服务端没给，就按记录里的字段拼一个，至少能显示、
   * 能播（`id` 就是 `songId`，播放走正常取流接口）。
   */
  async cloudSongs(limit = 100, offset = 0) {
    if (limit && typeof limit === 'object') {
      offset = limit.offset || 0;
      limit = limit.limit || 100;
    }
    const j = await this.tryGet('/api/cloud/get', { limit, offset });
    const list = Array.isArray(j.data) ? j.data : [];
    const songs = list.map((it) => {
      if (it.simpleSong && it.simpleSong.id) {
        const s = normalizeSong(it.simpleSong);
        // 云盘记录上的文件信息比歌曲本身更准（用户上传的是什么就是什么）
        s.cloudSize = it.fileSize || 0;
        s.cloudBitrate = it.bitrate || 0;
        s.cloudAddTime = it.addTime || 0;
        return s;
      }
      return {
        id: it.songId,
        name: it.songName || it.fileName || '',
        artists: [{ id: 0, name: it.artist || '未知歌手' }],
        artistText: it.artist || '未知歌手',
        album: { id: 0, name: it.album || '' },
        albumName: it.album || '',
        duration: it.songId ? 0 : 0,
        cover: it.album?.picUrl || '',
        cloudSize: it.fileSize || 0,
        cloudBitrate: it.bitrate || 0,
        cloudAddTime: it.addTime || 0,
      };
    });
    return {
      songs,
      count: Number.isFinite(j.count) ? j.count : songs.length,
      size: Number(j.size) || 0,
      maxSize: Number(j.maxSize) || 0,
      more: j.hasMore === undefined ? songs.length >= limit : !!j.hasMore,
    };
  }

  async album(id) {
    const j = await this.tryGet('/api/v1/album/' + id);
    return {
      id: j.album?.id,
      name: j.album?.name,
      cover: j.album?.picUrl,
      description: j.album?.description,
      artist: j.album?.artist?.name,
      publishTime: j.album?.publishTime,
      songs: (j.songs || []).map(normalizeSong),
    };
  }

  /** 歌手主页头部：头像、别名、关注状态与三个统计数字。 */
  async artistDetail(id) {
    const j = await this.tryGet('/api/artist/' + id);
    const a = j.artist || {};
    return {
      id: a.id || id,
      name: a.name || '',
      avatar: a.picUrl || a.img1v1Url || '',
      alias: a.alias || [],
      followed: !!a.followed,
      albumSize: a.albumSize || 0,
      musicSize: a.musicSize || 0,
      mvSize: a.mvSize || 0,
    };
  }

  /** 歌手专辑列表。`/api/artist/<id>` 的 briefDesc 恒为空，简介必须走下面那个接口。 */
  async artistAlbums(id, limit = 30, offset = 0) {
    const j = await this.tryGet('/api/artist/albums/' + id, { limit, offset });
    return {
      albums: (j.hotAlbums || []).map((a) => ({
        id: a.id, name: a.name, cover: a.picUrl || a.blurPicUrl,
        artist: a.artist?.name, size: a.size, publishTime: a.publishTime,
      })),
      more: !!j.more,
    };
  }

  /** 歌手简介：`/api/artist/head/info/get` 才是正确来源（`/api/artist/<id>` 的 briefDesc 是空串）。 */
  async artistDesc(id) {
    const j = await this.tryGet('/api/artist/head/info/get', { id });
    const d = j.data || {};
    const a = d.artist || {};
    return {
      id: a.id || id,
      name: a.name || '',
      avatar: a.avatar || '',
      briefDesc: a.briefDesc || '',
      identities: a.identities || [],
      transNames: a.transNames || [],
      // 「演唱 566 / 作词 278 / 作曲 2813」这类身份统计
      expertises: (d.secondaryExpertIdentiy || []).map((e) => ({
        name: e.expertIdentiyName, count: e.expertIdentiyCount,
      })),
    };
  }

  /**
   * 关注 / 取关歌手。取关时 artistIds 必须一起带上，只给 artistId 会 400。
   *
   * 失败时不直接抛出：`-462` 会附带一整套安全验证参数，调用方要拿它去换二维码，
   * 而 tryPost 会把 payload 丢掉，所以这里显式 catch 并走 `followOutcome`。
   */
  async artistSub(id, sub = true) {
    try {
      const j = sub
        ? await this.post('/artist/sub', { artistId: id })
        : await this.post('/artist/unsub', { artistId: id, artistIds: JSON.stringify([id]) });
      return { ok: j.code === 200, code: j.code, message: j.message || '' };
    } catch (e) {
      return followOutcome(e, 'artist');
    }
  }

  /**
   * 关注 / 取关用户。
   *
   * weapi 的 `/user/follow/<id>` 对任何目标都只回 `code 250 关注异常`（同一
   * cookie 在浏览器里点关注是成功的），必须走 `interface.music.163.com` 的
   * App 方言：关注 `POST /api/user/follow/<uid>`、取关
   * `POST /api/user/delfollow/<uid>`，两者 body 都为空。
   *
   * 成功时响应体是一个完整的 user 对象（`user.followed` 为 true/false），
   * **没有 `code` 字段**；失败才返回 `{code:250,...}` 并由 `_parse` 抛出。
   *
   * `-462` 是账号级安全验证门，与请求本身无关（对照 NeteaseCloudMusicApi
   * 发同样的请求同样撞门），无法靠改 header / cookie / 方言绕过，唯一出路是
   * 让用户拿官方 App 扫一次验证二维码。故这里把它翻译成 `needVerify` 结果，
   * 由渲染层弹二维码，而不是抛一个用户无从下手的错误。
   */
  async userFollow(uid, follow = true) {
    const verb = follow ? 'follow' : 'delfollow';
    try {
      const j = await this.postApp(`/api/user/${verb}/${uid}`, {});
      const u = j.user || j;
      return { ok: true, followed: u && u.followed !== undefined ? !!u.followed : !!follow, user: u };
    } catch (e) {
      return followOutcome(e, 'user');
    }
  }

  /**
   * 用 `-462` 里带回的参数换一张安全验证二维码。
   *
   * `verify` 就是 `followOutcome` 抽出来的那包字段。二维码图片由网易云自己
   * 生成（CDN 上的 130x130 JPEG），内容是一条 `https://163cn.tv/...` 官方短链，
   * 用官方 App 扫码即完成手机号/短信步进验证。
   */
  async riskQr(verify = {}) {
    const j = await this.tryPost('/frontrisk/verify/getqrcode', {
      verifyConfigId: verify.verifyId,
      verifyType: verify.verifyType,
      token: verify.verifyToken,
      params: JSON.stringify({ event_id: verify.eventId, sign: verify.sign }),
      size: 150,
      // 这两个风控接口把成功写成字符串 `"200"`，必须宽松解析，否则成功被当失败抛出
    }, true);
    const d = j.data || {};
    if (!d.qrCode) {
      return { ok: false, code: j.code, message: j.message || j.msg || '二维码获取失败' };
    }
    return {
      ok: true,
      qrCode: d.qrCode,
      imageUrl: d.imageUrl || '',
      // 官方 H5 验证页：手机上直接打开也可以（与二维码等价）
      verifyUrl: 'https://st.music.163.com/encrypt-pages'
        + `?qrCode=${encodeURIComponent(d.qrCode)}`
        + `&verifyToken=${encodeURIComponent(verify.verifyToken || '')}`
        + `&verifyId=${encodeURIComponent(verify.verifyId || '')}`
        + `&verifyType=${encodeURIComponent(verify.verifyType || '')}`
        + `&params=${encodeURIComponent(JSON.stringify({ event_id: verify.eventId, sign: verify.sign }))}`,
    };
  }

  /** 轮询扫码结果。`status === 2`（或非 0 且非 1）视为已完成。 */
  async riskQrStatus(qrCode) {
    const j = await this.tryPost('/frontrisk/verify/qrcodestatus', { qrCode }, true);
    const d = j.data || {};
    const status = d.qrCodeStatus;
    return {
      ok: j.code == 200,
      status: status == null ? -1 : Number(status),
      done: Number(status) >= 2,
      reason: d.detailReason || 0,
      code: j.code,
      message: j.message || j.msg || '',
    };
  }
}

/**
 * 把关注类接口的异常翻译成统一结果。
 *
 * `-462`（账号级安全验证门）会被抽成 `needVerify` + 一包 `verify` 参数，供
 * `riskQr()` 换二维码；其余错误原样抛出，交由上层 toast。
 */
function followOutcome(e, kind) {
  const payload = e && e.payload;
  const d = (payload && payload.data) || null;
  if (e && e.code === -462 && d && d.verifyToken) {
    return {
      ok: false,
      needVerify: true,
      code: -462,
      message: e.message || '需要安全验证',
      kind,
      verify: {
        verifyType: d.verifyType,
        verifyId: d.verifyId,
        verifyToken: d.verifyToken,
        blockText: d.blockText || '',
        eventId: (d.params && d.params.event_id) || '',
        sign: (d.params && d.params.sign) || '',
      },
    };
  }
  throw e;
}

/**
 * 把登录接口的异常翻译成统一结果。
 *
 * 与 [followOutcome] 同一套：`-462` 抽成 `needVerify` + 一包 `verify` 参数，
 * 供 `riskQr()` 换二维码；其余错误照旧抛出（密码错、限流等）。
 */
function loginOutcome(e) {
  const payload = e && e.payload;
  // 有的接口把安全验证参数放在 `data` 里，有的直接摊在顶层 —— 两个形状都认，
  // 否则用户只会看到一句「请确认是否本人账号」，而弹窗（换二维码那条路）不出现。
  const d = (payload && (payload.data || payload)) || null;
  if (e && e.code === -462 && d && d.verifyToken) {
    return {
      ok: false,
      needVerify: true,
      code: -462,
      message: e.message || '需要安全验证',
      kind: 'login',
      verify: {
        verifyType: d.verifyType,
        verifyId: d.verifyId,
        verifyToken: d.verifyToken,
        blockText: d.blockText || '',
        eventId: (d.params && d.params.event_id) || '',
        sign: (d.params && d.params.sign) || '',
      },
    };
  }
  throw e;
}

// ================= normalizers =================

function normalizePlaylist(p) {
  return {
    id: p.id,
    name: p.name,
    cover: p.coverImgUrl || p.picUrl,
    trackCount: p.trackCount,
    playCount: p.playCount,
    specialType: p.specialType,
    subscribed: p.subscribed,
    creator: p.creator ? { id: p.creator.userId, name: p.creator.nickname, avatar: p.creator.avatarUrl } : null,
    description: p.description || '',
    updateTime: p.updateTime,
  };
}

/**
 * v6 内联的 tracks 是不是被截断了。
 *
 * 注意判据是 trackCount 而不是 trackIds.length：v6 对别人的歌单只内联 20 条，
 * 但 trackIds 一直是全量 —— 拿 trackIds 当分母会得出「已经齐了」的错结论。
 * 另外 trackCount 偶尔会比实际少（歌单被删歌之后没刷新），所以只要内联的条数
 * 少于 trackCount 就补；补完仍然少也不循环（补全只做一次）。
 */
function shouldPage(pl, have) {
  const total = pl.trackCount || 0;
  return total > have;
}

/**
 * 把接口里那个 `cd` 拆成「碟号 + 碟名原文」。
 *
 * 官方客户端的 TPOS 帧就写这两者的组合，而且**两种形状都原样照抄**：
 *   - `cd = "01"`               → TPOS `01`
 *   - `cd = "disc1 万籁拂旧尘"` → TPOS `disc1 万籁拂旧尘`
 * 所以这里除了算一个整数碟号，还要把原文留一份给 `id3.js` 直接用。
 *
 * 为什么不能只留整数：`Number("disc1 万籁拂旧尘")` 是 NaN，
 * `Number("01")` 是 1 —— 前者会让 TPOS 整帧被跳过（碟号 0 = 未知），
 * 后者恰好对。用户是拿资源管理器「详细信息 → 集的一部分」逐项比的，
 * 少了这一行一眼就能看出来。
 *
 * @param {*} cd 接口原值（字符串或数字，也可能没有）
 * @returns {{trackNo?: number, discNo: number, discText: string}}
 */
function discFields(cd) {
  const raw = cd == null ? '' : String(cd).trim();
  if (!raw) return { discNo: 0, discText: '' };
  // `disc1 万籁拂旧尘` / `1` / `01` 都能抠出前导数字
  const m = /^(?:disc)?\s*(\d+)/i.exec(raw);
  const n = m ? Number(m[1]) : 0;
  // 纯数字（`01` / `1`）不留原文 —— 那种情况 TPOS 要补两位，由 id3.js 拼。
  // 带碟名的才留，且留**完整原文**（连 `disc1 ` 前缀一起），官方就是那么写的。
  const hasName = /[^\d\s]/i.test(raw.replace(/^disc\s*\d+\s*/i, ''));
  return { discNo: n || 0, discText: hasName ? raw : '' };
}

/** Collapse the several song shapes the API returns into one. */
function normalizeSong(s) {
  if (!s) return null;
  const album = s.al || s.album || {};
  const artists = s.ar || s.artists || [];
  return {
    id: s.id,
    name: s.name,
    // v6 playlist rows carry `tns`; search results carry `alia`
    alias: s.alia || s.tns || [],
    cover: album.picUrl || s.picUrl || '',
    album: { id: album.id, name: album.name || '' },
    artists: artists.map((a) => ({ id: a.id, name: a.name })),
    artistText: artists.map((a) => a.name).join('/'),
    duration: s.dt || s.duration || 0,
    fee: s.fee,
    // 每日推荐每首歌会带一句推荐理由（"超75%人播放" / "NO.15 飙升榜"），
    // 其它接口没有这个字段，所以这里取到空串即可。
    reason: s.recommendReason || s.reason || '',
    // st === -200 means the track is unavailable in this region/account
    unavailable: s.st === -200 || !!s.noCopyrightRcmd,
    mvid: s.mv || 0,
    // 音轨号 / 碟号：下载时写进 ID3 的 TRCK / TPOS（用户 m07048 第④点）。
    // 官方客户端下的文件带这两帧，我们原来只有 TSSE，拷进别的播放器就丢了
    // 「第几首」。字段名是 `no` / `cd`，缺省 0 表示未知，未知时不写帧。
    //
    // `cd` 有两种形状，**不能一把 Number() 了事**（用户 m15041 那轮的真 bug）：
    //   - 单碟专辑：`"01"`（字符串数字）→ 碟号 1，TPOS 写 `01`
    //   - 多碟合集：`"disc1 万籁拂旧尘"`（碟号 + 碟名）→ 碟号 1，
    //     TPOS **原文照抄**成 `disc1 万籁拂旧尘`
    // 原来只做了 `Number(s.cd)`，第二种直接得 NaN → 0，于是 TPOS 整帧不写，
    // 官方 app 下的同名文件在资源管理器「详细信息」里比我们多一行「集的一部分」。
    trackNo: Number(s.no) || 0,
    // 两个详情接口的字段名不一样：`/api/v3/song/detail` 叫 `cd`，
    // 老版 `/api/song/detail` 叫 `disc`（实测同一首歌两边的值完全相同）。
    ...discFields(s.cd != null ? s.cd : s.disc),
    privilege: s.privilege ? { fee: s.privilege.fee, st: s.privilege.st, pl: s.privilege.pl } : null,
  };
}

function normalizeComment(c) {
  return {
    id: c.commentId,
    content: c.content,
    time: c.time,
    timeStr: c.timeStr,
    likedCount: c.likedCount,
    liked: !!c.liked,
    user: c.user
      ? { id: c.user.userId, name: c.user.nickname, avatar: c.user.avatarUrl, vip: c.user.vipType }
      : null,
    replied: c.beReplied?.length
      ? { user: c.beReplied[0].user?.nickname, content: c.beReplied[0].content }
      : null,
    replyCount: c.replyCount || 0,
  };
}

/** 播客电台。字段来自 `program.radio`（`/api/djradio/detail` 是 404）。 */
function normalizeRadio(r) {
  const dj = r.dj || {};
  return {
    id: r.id,
    name: r.name || '',
    cover: r.picUrl || r.picURL || '',
    desc: r.desc || '',
    programCount: r.programCount || 0,
    subCount: r.subCount || 0,
    category: r.category || '',
    categoryId: r.categoryId || 0,
    // 电台主理人，播客页显示成"主播"
    dj: dj.userId ? { id: dj.userId, name: dj.nickname || '', avatar: dj.avatarUrl || '' } : null,
  };
}

/**
 * 播客节目。节目本身不能直接播放，真正的音源是 `mainSong.id`，
 * 所以这里既保留节目信息（标题/时长/封面/简介），又把 mainSong 归一化成
 * 一个普通 song 对象挂在 `song` 上，播放列表直接用它即可。
 *
 * 注意 `mainSong` 里没有 `dt`，时长在节目级 `duration` 上；封面在
 * `coverUrl`（mainSong.album.picUrl 往往是占位图）。
 */
function normalizeProgram(p) {
  const song = normalizeSong(p.mainSong);
  const radio = p.radio ? normalizeRadio(p.radio) : null;
  const cover = p.coverUrl || p.blurCoverUrl || (song && song.cover) || '';
  if (song) {
    // 节目封面比 mainSong 的专辑图更准，用节目封面覆盖
    song.cover = cover;
    song.duration = p.duration || song.duration || 0;
    song.programId = p.id;
    // 主播当作"歌手"展示，点进去不是歌手页，所以把 id 归零交给渲染层识别
    song.artists = radio && radio.dj
      ? [{ id: 0, name: radio.dj.name }]
      : [{ id: 0, name: radio ? radio.name : '播客' }];
    song.artistText = song.artists.map((a) => a.name).join('/');
    song.album = { id: 0, name: radio ? radio.name : '' };
  }
  return {
    id: p.id,
    name: p.name || '',
    cover,
    duration: p.duration || 0,
    desc: p.description || p.programDesc || '',
    createTime: p.createTime || 0,
    listenerCount: p.listenerCount || 0,
    serialNum: p.serialNum || 0,
    radio,
    song,
  };
}

function normalizeUser(u) {
  return {
    id: u.userId,
    name: u.nickname,
    avatar: u.avatarUrl,
    signature: u.signature || '',
    gender: u.gender,
    vipType: u.vipType || 0,
    follows: u.follows || 0,
    followeds: u.followeds || 0,
    eventCount: u.eventCount || 0,
    playlistCount: u.playlistCount || 0,
    followed: !!u.followed,
    mutual: !!u.mutual,
  };
}

module.exports = { Netease, QUALITY, COMMENT_TYPE };
