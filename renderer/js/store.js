/* ============================================================
   全局状态
   ============================================================ */
(function (global) {
  'use strict';

  // ------------------------------------------------------------
  // 最近播放的落盘（m38831 第⑤点）
  // ------------------------------------------------------------
  // 之前 `recent` 是纯内存的，关掉软件就没了 —— 而「最近播放」这个名字本身
  // 就承诺了它是跨会话的。这里用 localStorage 存一份：它跟着 userData 目录走，
  // 不需要为它开 IPC（主进程的 config.json 是给「设置」用的，两百首歌的对象
  // 塞进去会把配置文件撑得又大又难读）。
  //
  // 存之前必须瘦身：normalizeSong 出来的对象带着 privilege 等一大堆前端用不到
  // 的字段，200 首能到几百 KB。列表渲染与播放需要的只有下面这几个 ——
  // 少了 id 播不了，少了 cover/artists/album/duration 列表会长得不对。
  const RECENT_KEY = 'nl.recent.v1';

  function trimSong(song) {
    if (!song || !song.id) return null;
    return {
      id: song.id,
      name: song.name || '',
      alias: song.alias || [],
      cover: song.cover || '',
      album: song.album ? { id: song.album.id, name: song.album.name } : null,
      // artists 必须是数组：views 的行模板直接 song.artists.map(...)
      artists: (song.artists || []).map((a) => ({ id: a.id, name: a.name })),
      artistText: song.artistText || '',
      duration: song.duration || 0,
      fee: song.fee,
      mvid: song.mvid || 0,
      reason: song.reason || '',
      unavailable: !!song.unavailable,
    };
  }

  function loadRecent() {
    try {
      const raw = global.localStorage && global.localStorage.getItem(RECENT_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr
        .map((x) => ({ song: trimSong(x && x.song), playedAt: (x && x.playedAt) || 0 }))
        .filter((x) => x.song);
    } catch {
      // 存坏了就当没有：一份听歌历史不值得让整个界面起不来
      return [];
    }
  }

  function saveRecent(list) {
    try {
      global.localStorage.setItem(RECENT_KEY, JSON.stringify(
        list.map((x) => ({ song: trimSong(x.song), playedAt: x.playedAt })).filter((x) => x.song)));
    } catch {
      // 配额满 / 隐私模式：功能退化成「只在本次运行里记住」，不该弹错
    }
  }

  const store = {
    // 登录
    loggedIn: false,
    profile: null,
    uid: null,

    // 音乐库
    playlists: [],
    liked: null,          // 我喜欢的音乐
    likedIds: new Set(),

    // 本机听歌历史：服务端的 /play/record 是按播放次数排名的榜单，响应里
    // 没有任何时间戳，拿不到「最近」的语义，所以真实时间序由本机记录。
    // 这份记录会落盘（见文件顶部），关掉软件再打开还在。
    recent: loadRecent(),
    recentMax: 200,

    // 本地文件（m35069 第 2 点）：本机已经有的音频。`localIds` 是歌曲 id 的集合，
    // 列表里的「√」标记、以及播放时「优先用本地文件」都只查这个集合 ——
    // 拿 Set 而不是数组，是因为每次渲染行都要问一遍「这首有没有」。
    // `localInfo` 是给设置页显示「已匹配 N 首 / 扫描过哪些目录」用的。
    localIds: new Set(),
    localInfo: { count: 0, dirs: [], at: 0 },

    // 这次会话里「在任意列表中出现过」的歌曲（m00001 第③点）。
    // 本地扫描从歌单页搬到已下载音乐页之后，扫描时没有「当前歌单」可当字典了，
    // 就把用户看过的每一行都记下来，扫描时一起拿去匹配。只留匹配要用的字段，
    // 几千首也不过几百 KB。
    knownSongs: new Map(),

    /** 登记一首「这次会话见过的歌」，供本地扫描拼字典。 */
    noteSong(song) {
      if (!song || !song.id) return;
      this.knownSongs.set(Number(song.id), {
        id: song.id,
        name: song.name || '',
        artistText: song.artistText || '',
        artists: (song.artists || []).map((a) => ({ id: a.id, name: a.name })),
        album: song.album ? { id: song.album.id, name: song.album.name } : null,
        duration: song.duration || 0,
      });
    },

    // 设置
    quality: 'exhigh',
    volume: 0.7,
    muted: false,
    // 上次播放位置（第 6 点）：{ id, name, position, at }，来自 config.json。
    // 「记住上一次播放进度」开着时，启动后拿它把这首歌塞回队列并跳到那个位置。
    lastPlay: null,

    // 导航
    route: null,          // { name, params }
    history: [],
    historyIndex: -1,

    // 视图
    nowPlayingOpen: false,
    queueOpen: false,
    // 队列面板里当前那一页：'queue' | 'download'（第 5 点）
    queueTab: 'queue',
    currentTab: 'lyric',

    listeners: {},

    on(evt, fn) {
      (this.listeners[evt] || (this.listeners[evt] = [])).push(fn);
      return () => this.off(evt, fn);
    },
    off(evt, fn) {
      const arr = this.listeners[evt];
      if (arr) {
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
      }
    },
    emit(evt, payload) {
      for (const fn of this.listeners[evt] || []) {
        try { fn(payload); } catch (e) { console.error('[store] listener error', evt, e); }
      }
    },

    /**
     * 记一次播放。同一首歌再次播放时把它提到最前（而不是留两条），
     * 并更新 playedAt —— 这就是「最近播放」的顺序来源。
     */
    pushRecent(song) {
      if (!song || !song.id) return;
      const list = this.recent.filter((x) => x.song && x.song.id !== song.id);
      list.unshift({ song, playedAt: Date.now() });
      if (list.length > this.recentMax) list.length = this.recentMax;
      this.recent = list;
      saveRecent(list);
      this.emit('recent:changed', this.recent);
    },

    clearRecent() {
      this.recent = [];
      saveRecent(this.recent);
      this.emit('recent:changed', this.recent);
    },
  };

  global.store = store;
})(window);
