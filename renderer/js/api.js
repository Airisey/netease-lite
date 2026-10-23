/* ============================================================
   渲染进程 API 封装：缓存 + 并发去重 + 错误归一化
   ============================================================ */
(function (global) {
  'use strict';

  /** 已登录时才需要的接口，未登录直接给出友好错误 */
  const NEEDS_LOGIN = new Set([
    'userPlaylists', 'dailyRecommend', 'likedIds', 'playlistAdd', 'playlistRemove',
    'playlistCreate', 'playlistDelete', 'playlistUpdate', 'like', 'subscribePlaylist', 'scrobble',
  ]);

  class NeedLoginError extends Error {
    constructor(msg) {
      super(msg || '请先登录网易云账号');
      this.code = 301;
      this.needLogin = true;
    }
  }

  const api = {
    NeedLoginError,

    /**
     * 直接调用（不缓存）。
     *
     * 走 callSafe 而不是 ne.call，是因为 contextBridge 在桥接函数「抛出」异常时
     * 会重建一个干净的 Error，只保留 message，附加在 Error 上的 code / needLogin
     * 全部丢失。实测 `ne.call('userFollow')` 抛出的对象 ownKeys 为空、code 为
     * undefined，于是 api.explain() 永远匹配不到 -460 / -462 / 301 这些分支，
     * 用户看到的是裸的 "code -462" 而不是可读的指引。
     * callSafe 返回的是普通可序列化对象（{ok:false,error:{code,message,needLogin}}），
     * 跨桥不丢字段，因此在这里把错误对象重新拼出来。
     */
    async raw(method, ...args) {
      const res = await global.ne.callSafe(method, ...args);
      if (res && res.ok) return res.result;
      const info = (res && res.error) || {};
      const e = new Error(info.message || '操作失败');
      e.code = info.code == null ? -1 : info.code;
      e.needLogin = !!info.needLogin;
      throw e;
    },

    /** 调用并返回 {ok, result, error}，永不抛异常 */
    async safe(method, ...args) {
      const res = await global.ne.callSafe(method, ...args);
      if (res.ok) return { ok: true, result: res.result };
      return { ok: false, error: res.error, needLogin: !!res.error.needLogin };
    },

    /**
     * 带缓存的读取。同一 key 的并发请求会合并成一次。
     * @param {string} key  缓存键
     * @param {number} ttl  毫秒；0 表示不缓存
     * @param {Function} fn 真正取数的函数
     */
    async cached(key, ttl, fn) {
      const now = Date.now();
      const hit = api._cache.get(key);
      if (hit && now - hit.t < ttl) return hit.v;

      const inflight = api._inflight.get(key);
      if (inflight) return inflight;

      const p = (async () => {
        try {
          const v = await fn();
          if (ttl > 0) api._cache.set(key, { v, t: Date.now() });
          return v;
        } finally {
          api._inflight.delete(key);
        }
      })();
      api._inflight.set(key, p);
      return p;
    },

    _cache: new Map(),
    _inflight: new Map(),

    invalidate(prefix) {
      if (!prefix) { api._cache.clear(); return; }
      for (const k of [...api._cache.keys()]) {
        if (k.startsWith(prefix)) api._cache.delete(k);
      }
    },

    /** 把错误翻译成给用户看的一句话 */
    explain(err) {
      if (!err) return '未知错误';
      const code = err.code;
      if (err.needLogin || code === 301) return '请先登录网易云账号';
      if (code === -460) return '操作过于频繁，被网易云风控拦截，请稍后再试';
      // -462 是网易云的风控验证门：服务端会附带 verifyType/verifyId/verifyToken
      // 和一组 event_id + sign，要求完成手机号或短信步进验证后才能继续写操作
      // （关注、取关、发评论等）。接口本身是正确的，同一账号在浏览器里点关注
      // 也会撞上这个门，且改 header / cookie / 方言都无法绕过。正常路径会由
      // followClick 弹二维码，走到这里说明验证参数缺失，只能给文字指引。
      if (code === -462) return '网易云要求先完成手机号或短信验证，请在官方 App 中完成安全验证后重试';
      if (code === 250) return '该歌曲暂时无法播放（可能需要会员）';
      // 8821 是网易云对该账号**密码登录**的风控限制（用户 m08537 第⑤点）：
      // 同一个账号输错密码回的是 502「账号或密码错误」，只有密码正确才回 8821 ——
      // 说明密码没错，是这条路被平台关了。服务端那句「请切换其他登录方式或
      // 升级新版本再试」对本应用毫无可操作性（我们没有「升级新版本」这个动作），
      // 所以换成实际能走的两条路。
      if (code === 8821) return '网易云已限制这个账号用密码登录。请改用「短信验证码」或「Cookie」登录';
      if (code === 404) return '内容不存在或已被删除';
      if (code === -2) return '客户端内部错误：接口被拒绝';
      if (code === -1 && /fetch|network|ENOTFOUND|ECONN/i.test(err.message || '')) return '网络连接失败，请检查网络';
      return err.message || '操作失败';
    },
  };

  // ---------------------------------------------------------- 业务封装

  const svc = {
    // ---- 登录 ----
    async account() { return api.raw('account'); },
    async qrCreate() { return api.raw('qrCreate'); },
    async qrPoll(key) { return api.raw('qrPoll', key); },
    async loginPhone(phone, password, cc) { return api.raw('loginPhone', phone, password, cc); },
    async sendCaptcha(phone, cc) { return api.raw('sendCaptcha', phone, cc); },
    async loginCaptcha(phone, code, cc) { return api.raw('loginCaptcha', phone, code, cc); },
    async logout() { await api.raw('logout'); api.invalidate(); },

    // ---- 歌单 ----
    async userPlaylists(uid) {
      return api.cached('playlists:' + uid, 30000, () => api.raw('userPlaylists', uid));
    },
    async playlistDetail(id) {
      return api.cached('pl:' + id, 30000, () => api.raw('playlistDetail', id));
    },
    async playlistTracks(id, total) {
      return api.cached('pltracks:' + id, 30000, () => api.raw('playlistTracks', id, total));
    },
    async dailyRecommend(force) {
      if (force) api.invalidate('daily');
      return api.cached('daily', 300000, () => api.raw('dailyRecommend'));
    },
    async recommendPlaylists() {
      return api.cached('recpl', 600000, () => api.raw('recommendPlaylists'));
    },

    // ---- 榜单 / 播客 ----
    async toplists() {
      // 榜单每天更新，缓存 10 分钟足够，切页时不必重新拉 64 条
      return api.cached('toplists', 600000, () => api.raw('toplists'));
    },
    async podcasts(limit) {
      return api.cached('podcasts:' + limit, 600000, () => api.raw('podcasts', limit));
    },
    async podcastDetail(radioId) {
      return api.cached('podcast:' + radioId, 600000, () => api.raw('podcastDetail', radioId));
    },
    async podcastPrograms(radioId, limit, offset) {
      return api.cached(
        `podcastprogs:${radioId}:${limit}:${offset}`, 300000,
        () => api.raw('podcastPrograms', radioId, limit, offset)
      );
    },
    async likedIds(uid) {
      return api.cached('liked:' + uid, 60000, async () => {
        const ids = await api.raw('likedIds', uid);
        return new Set(Array.isArray(ids) ? ids : []);
      });
    },

    // ---- 用户 / 最近播放 ----
    async userDetail(uid) {
      return api.cached('user:' + uid, 120000, () => api.raw('userDetail', uid));
    },
    async playRecord(uid, type = 0) {
      return api.cached(`recent:${uid}:${type}`, 60000, () => api.raw('playRecord', uid, type));
    },
    async userLevel(uid) {
      return api.cached('level:' + uid, 300000, () => api.raw('userLevel', uid));
    },
    async follows(uid, limit, offset) {
      return api.cached(`follows:${uid}:${limit}:${offset}`, 60000, () => api.raw('follows', uid, limit, offset));
    },
    async followeds(uid, limit, offset) {
      return api.cached(`followeds:${uid}:${limit}:${offset}`, 60000, () => api.raw('followeds', uid, limit, offset));
    },
    /** 签到：type=1 才是真签到（type=0 会返回假的成功）；今日已签返回 already:true */
    async dailyTask() {
      const r = await api.raw('dailyTask', 1);
      api.invalidate('level:');
      return r;
    },

    // ---- 歌曲 ----
    async songDetail(ids) { return api.raw('songDetail', ids); },
    async songUrl(id, quality) { return api.raw('songUrl', id, quality); },
    async songUrlV1(id, quality) { return api.raw('songUrlV1', id, quality); },
    async songUrls(ids, quality) { return api.raw('songUrls', ids, quality); },
    async lyrics(id) { return api.cached('lrc:' + id, 3600000, () => api.raw('lyrics', id)); },
    async comments(type, id, limit, offset) { return api.raw('comments', type, id, limit, offset); },
    /**
     * 评论点赞 / 取消点赞。`threadId` 是带类型前缀的资源 id（`R_SO_4_<歌曲id>`）。
     * 故意不走缓存：点完要立刻按返回值重渲染，缓存只会把界面拉回旧状态。
     */
    async commentLike(threadId, commentId, like) {
      return api.raw('commentLike', threadId, commentId, like);
    },
    /**
     * 只要评论总数（给播放条的角标用）。
     * 实测 `limit=0` 时服务端照样返回完整 `total`，且不回任何评论条目 —— 比拉
     * 一条还省流量。缓存 10 分钟：角标是常驻显示，切歌来回跳时不该反复打接口。
     */
    async commentCount(id) {
      return api.cached('cmcount:' + id, 600000, () => api.raw('comments', 'song', id, 0, 0));
    },

    // ---- 搜索 ----
    async search(kw, type, limit, offset) {
      return api.cached(`search:${type}:${kw}:${limit}:${offset}`, 120000,
        () => api.raw('search', kw, type, limit, offset));
    },

    // ---- 写操作 ----
    async playlistAdd(pid, ids) {
      const r = await api.raw('playlistAdd', pid, ids);
      api.invalidate('pl:' + pid);
      api.invalidate('pltracks:' + pid);
      api.invalidate('playlists:');
      return r;
    },
    async playlistRemove(pid, ids) {
      const r = await api.raw('playlistRemove', pid, ids);
      api.invalidate('pl:' + pid);
      api.invalidate('pltracks:' + pid);
      api.invalidate('playlists:');
      return r;
    },
    async playlistCreate(name) {
      const r = await api.raw('playlistCreate', name);
      api.invalidate('playlists:');
      return r;
    },
    async playlistDelete(pid) {
      const r = await api.raw('playlistDelete', pid);
      api.invalidate('playlists:');
      api.invalidate('pl:' + pid);
      return r;
    },
    async like(trackId, like) {
      const r = await api.raw('like', trackId, like);
      api.invalidate('liked:');
      // The heart changes the contents of 我喜欢的音乐, whose track list is
      // cached separately under `pltracks:<id>`; without this the page keeps
      // showing the pre-heart list for the whole 30s TTL.
      const likedId = (typeof store !== 'undefined' && store.liked) ? store.liked.id : null;
      if (likedId) {
        api.invalidate('pltracks:' + likedId);
        api.invalidate('pl:' + likedId);
      }
      return r;
    },
    async artistSongs(id, limit, offset) { return api.raw('artistSongs', id, limit, offset); },
    /** 歌手全部作品的一页：{ songs, total, more }（歌手页「全部歌曲」页签用） */
    async artistAllSongs(id, limit, offset) { return api.raw('artistAllSongs', id, limit, offset); },
    async album(id) { return api.raw('album', id); },
    /**
     * 音乐云盘的一页：`{ songs, count, size, maxSize, more }`（m05071 第④点）。
     * 不走 cached：云盘内容用户随时会在手机上传/删，缓存一分钟就会显得「不对」。
     */
    async cloudSongs(limit, offset) { return api.raw('cloudSongs', limit, offset); },
    async artistDetail(id) {
      return api.cached('artist:' + id, 300000, () => api.raw('artistDetail', id));
    },
    async artistAlbums(id, limit, offset) {
      return api.cached(`artistalbums:${id}:${limit}:${offset}`, 300000,
        () => api.raw('artistAlbums', id, limit, offset));
    },
    async artistDesc(id) {
      return api.cached('artistdesc:' + id, 3600000, () => api.raw('artistDesc', id));
    },
    /** 关注 / 取关歌手；成功后让详情缓存失效，下次进入歌手页读到的 followed 才是新的 */
    async artistSub(id, sub) {
      const r = await api.raw('artistSub', id, sub);
      api.invalidate('artist:' + id);
      return r;
    },
    /** 关注 / 取关用户；同样要让 userDetail 缓存失效 */
    async userFollow(uid, follow) {
      const r = await api.raw('userFollow', uid, follow);
      api.invalidate('user:' + uid);
      return r;
    },

    /** 用 -462 带回的参数换一张安全验证二维码 */
    async riskQr(verify) { return api.raw('riskQr', verify); },
    /** 轮询扫码结果 */
    async riskQrStatus(qrCode) { return api.raw('riskQrStatus', qrCode); },

    /** 逃生口：直接调用白名单方法（不缓存、不包装） */
    raw(method, ...args) { return api.raw(method, ...args); },
  };

  global.api = api;
  global.svc = svc;
})(window);
