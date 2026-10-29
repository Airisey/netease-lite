/* ============================================================
   应用主控：路由 / 侧栏 / 播放条 / 歌词 / 队列 / 登录 / 弹窗
   ============================================================ */
(function (global) {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /**
   * Show/hide by toggling the `hidden` *attribute*.
   *
   * `el.hidden = true` is an IDL property that only exists on HTMLElement — on an
   * <svg> it silently creates a plain JS expando and never touches the DOM, so
   * the icon stays visible no matter what. Every icon in the player bar is an
   * <svg>, which is why the play/pause, repeat and mute icons never changed.
   */
  function setHidden(el, on) {
    if (!el) return;
    if (on) el.setAttribute('hidden', '');
    else el.removeAttribute('hidden');
  }

  // 用户 m36690 第④点：hi-res 档已删除 —— 它和「无损」在服务端拿到的是同一个
  // FLAC，摆两个按钮只会让人以为多花的那档真能听到更多东西。老配置里存着
  // 'hires' 的由 loadConfig / settings 页各自折成 'lossless'。
  const QUALITY_LABEL = { standard: '标准', higher: '较高', exhigh: '极高', lossless: '无损' };
  // 设置页要拿它渲染音质下拉，挂到 window 上共享
  global.QUALITY_LABEL = QUALITY_LABEL;

  let player = null;

  const App = {
    player: null,

    /** 递增令牌：重新登录/重载侧栏时，用来放弃上一轮还没跑完的缩略图任务 */
    _coverToken: 0,

    // ============================================================
    //  启动
    // ============================================================
    async init() {
      player = this.player = new global.Player();
      global.player = player;

      // 皮肤：boot.js 已经在样式表之前把 data-skin 打好了，这里接上运行时的
      // 切换通道（主进程广播 + 下拉菜单），并保证后续渲染用的是同一个值。
      global.Skins.init();

      this.bindWindowControls();
      this.bindTitlebarExtras();
      this.bindSearch();
      this.bindPlayerBar();
      this.bindLyricPane();
      this.bindQueuePanel();
      this.bindDownloads();
      this.bindLocal();
      this.bindLoginModal();
      this.bindAddModal();
      this.bindArtistModal();
      this.bindVerifyModal();
      this.bindSidebar();
      this.bindKeyboard();
      this.bindMouseButtons();
      this.bindStoreEvents();
      this.bindMiniRelay();

      await this.loadConfig();
      await this.refreshAuth();

      // 启动自动签到（每天一次，静默）
      this.autoCheckin();

      // 默认进入推荐歌单（侧栏第一项）；用户可以在设置里改（m34266 第 2 点）
      this.go(this.startRoute(), {}, { replace: true });

      // 缓存超限就清一次（第 6 点）。放在这里而不是启动最开始：它要扫一遍
      // 目录，让界面先出来比让用户对着白屏等更合适。
      this.trimCache();
      // 接着上次的进度（第 6 点），异步做，失败就算了
      this.resumeLastPlay();

      store.emit('app:ready');
      document.body.classList.add('ready');
    },

    /**
     * 启动后该进哪一页（m34266 第 2 点）。
     *
     * 设置里选的是一个路由名，只有 `'last'` 特殊：它表示"回到上次离开的页面"，
     * 于是从 `config.lastRoute` 取。那张表里能选的都是不带参数的页面（推荐歌单 /
     * 每日推荐 / 榜单 / 播客 / 我喜欢的音乐 / 最近播放），所以直接返回名字就够；
     * 万一是别的名字（配置被手改过），退回推荐歌单而不是白屏。
     *
     * 登录态也要看一眼：每日推荐和我喜欢的音乐在未登录时只有一句提示，
     * 把未登录的用户丢到那种页面等于给了个空首页。
     */
    startRoute() {
      const fallback = 'radio';
      const key = (global.Settings && global.Settings.get('startPage')) || fallback;
      const known = new Set((global.Settings ? global.Settings.START_PAGES : []).map((p) => p.key));
      if (!known.has(key)) return fallback;
      let name = key;
      if (key === 'last') {
        const last = (this._config && this._config.lastRoute) || '';
        name = known.has(last) && last !== 'last' ? last : fallback;
      }
      if (!store.loggedIn && (name === 'liked' || name === 'daily')) return fallback;
      return name;
    },

    /**
     * 超过上限就清缓存（第 6 点）。
     *
     * 只在启动时查一次：播放过程中定期扫盘会跟解码抢 IO，而用户对缓存的期待
     * 本来就是"别无限涨"，不是"实时精确停在 1024MB"。
     */
    async trimCache() {
      try {
        const max = global.Settings ? global.Settings.get('cacheMax') : 0;
        if (!max) return;
        const r = await global.ne.cache.trim(max);
        if (r && r.cleared) console.log('[cache] 已清理', r.cleared, '字节');
        if (global.Settings && global.Settings.isOpen) global.Settings.loadCacheSize();
      } catch (e) { console.warn('[cache] trim', e); }
    },

    /**
     * 启动后接着上次的进度（第 6 点 + m03577 第⑨点）。
     *
     * 老版本只恢复"那一首歌"：存的是 id，启动后 `songDetail` 取回完整对象塞成
     * 单元素队列。用户点开队列面板看到的是一片空 —— 上一轮攒的一整列歌全丢了。
     * 现在优先整队列恢复：config 里的 `queue` 就是快照，直接摆回去。
     *
     * 只有拿不到队列快照时（老配置文件、或被 `clearQueue` 明确清空过）才退回
     * 单曲恢复 —— 那条路要走 `songDetail`，所以仍然保留。
     *
     * 两种路径都**不自动播放**：打开应用就突然出声很讨厌。
     */
    async resumeLastPlay() {
      if (!global.Settings || global.Settings.get('rememberProgress') !== true) return;
      if (this._restoreQueue()) return;
      const lp = store.lastPlay;
      if (!lp || !lp.id) return;
      try {
        const arr = await svc.songDetail([lp.id]);
        const song = arr && arr[0];
        if (!song) return;
        player.restoreQueue({
          queue: [song],
          queueIndex: 0,
          queueRepeat: player.repeat,
        });
        // 底栏要显示总时长，所以先把时长喂给 UI
        store.emit('player:duration', { duration: (song.duration || 0) });
        // m38831 第③点：底栏的进度条也得跟着回到上次的位置。
        //
        // 进度条、时间文字、歌词只认 `player:time` 这一个事件，而它平时只在
        // audio 的 timeupdate 里发。冷启动时这首歌还没有 src（要等用户按下
        // 播放才去取流），所以到那一刻为止一条 timeupdate 都不会来 —— 界面
        // 于是停在 0:00，看上去就像"没记住"。这里显式补一条，让恢复出来的
        // 曲目一出现就停在它该在的位置上。
        // 位置由 `player` 说了算：贴到结尾的那条进度不算数（见 RESUME_TAIL_GUARD），
        // 这里要是照搬 config 里的原值，就会出现「进度条停在 3:05、真正放起来
        // 却从头开始」的错位。
        const pos = player.resumePositionFor(song);
        if (pos) store.emit('player:time', { current: pos * 1000, duration: (song.duration || 0) });
        // 放行这次进度恢复：只有这条路（启动接着上次听）会放行
        player.resumeArmedFor(song);
        this.syncTrackUI(song);
      } catch (e) { console.warn('[app] resumeLastPlay', e); }
    },

    /**
     * 把 config 里的队列快照摆回播放器。返回 false 表示没有可用的快照，
     * 调用方应退回单曲恢复。
     */
    _restoreQueue() {
      const cfg = this._config || {};
      const saved = cfg.queue;
      if (!Array.isArray(saved) || !saved.length) return false;
      // 隔太久就别接了：队列里那些歌可能都已经下架，恢复出来是一列点不动的红字。
      // 用比单曲恢复（3 天）更宽的一周，队列本身是"用户攒出来的东西"，删掉更可惜。
      if (cfg.queueAt && Date.now() - cfg.queueAt > 7 * 24 * 3600 * 1000) return false;
      const ok = player.restoreQueue({
        queue: saved,
        queueIndex: cfg.queueIndex,
        queueRepeat: cfg.queueRepeat,
        queueCtx: cfg.queueCtx,
        queueOrigin: cfg.queueOrigin,
      });
      if (!ok) return false;
      // 底栏那句「0:00 / 总时长」得马上有数，跟单曲恢复那条路一样补一次。
      const cur = player.current;
      if (cur) {
        store.emit('player:duration', { duration: (cur.duration || 0) });
        // 同上：位置要按 `player` 的判断来，贴到结尾的进度当没听过
        const pos = player.resumePositionFor(cur);
        if (pos) store.emit('player:time', { current: pos * 1000, duration: (cur.duration || 0) });
        player.resumeArmedFor(cur);
        this.syncTrackUI(cur);
      }
      return true;
    },

    // ============================================================
    //  配置
    // ============================================================
    async loadConfig() {
      try {
        const cfg = await global.ne.config.get();
        this._config = cfg || {};
        if (cfg) {
          // hires 档已删除（第④点）；老配置里存过它的一律升到无损，
          // 而不是回落到「极高」——用户当初主动选了更高规格，不该被降两级。
          store.quality = cfg.quality === 'hires' ? 'lossless' : (cfg.quality || 'exhigh');
          store.volume = typeof cfg.volume === 'number' ? cfg.volume : 0.7;
          store.muted = !!cfg.muted;
          // 上次播放进度（第 6 点）：只在设置开着时才拿它做恢复
          store.lastPlay = cfg.lastPlay || null;
          player.audio.volume = store.muted ? 0 : store.volume;
          // 设置项：缺的键用默认值补齐，老配置文件也能直接用
          if (global.Settings) {
            global.Settings.values = { ...global.Settings.DEFAULTS, ...(cfg.settings || {}) };
            global.Settings.sideHidden = new Set(Array.isArray(cfg.sideHidden) ? cfg.sideHidden : []);
            global.Settings.apply();
          }
          // 皮肤的权威值在磁盘上，boot.js 用的是同一个来源（主进程注入的 argv）
          if (global.Skins && cfg.skin) global.Skins.apply(cfg.skin);
        }
      } catch (e) { console.warn('[app] loadConfig', e); }
      $('#qualityLabel').textContent = QUALITY_LABEL[store.quality] || '极高';
      this.updateVolumeUI();
      this.restoreFolds();
    },

    async saveConfig(patch) {
      // 本地也合并一份：saveConfig 之后马上读 this._config 的地方（例如侧栏缩略图
      // 的 sideCovers 缓存）否则会一直读到旧值，导致每次启动都重新拉一遍。
      if (this._config) Object.assign(this._config, patch);
      try { await global.ne.config.set(patch); } catch (e) { console.warn('[app] saveConfig', e); }
    },

    // ============================================================
    //  登录状态
    // ============================================================
    async refreshAuth() {
      try {
        const st = await global.ne.auth.state();
        await this.applyAuth(st);
      } catch (e) { console.warn('[app] refreshAuth', e); }
    },

    async applyAuth(st) {
      store.loggedIn = !!(st && st.loggedIn);
      store.profile = (st && st.profile) || null;
      store.uid = (st && st.uid) || null;
      if (store.loggedIn && store.profile) {
        store.uid = store.uid || store.profile.userId;
      }
      this.renderSideFooter();
      if (store.loggedIn) {
        await this.loadLibrary();
      } else {
        store.playlists = [];
        store.liked = null;
        store.likedIds = new Set();
        this.renderPlaylists();
        $('#likedCount').textContent = '';
      }
      store.emit('auth:changed', store.loggedIn);
    },

    /** 拉取"我的所有歌单" + 我喜欢的音乐 id 集合 */
    async loadLibrary() {
      if (!store.uid) return;
      try {
        const r = await svc.userPlaylists(store.uid);
        store.playlists = r.playlists || [];
        store.liked = store.playlists.find((p) => p.specialType === 5) || null;
        this.renderPlaylists();
        this.loadSidebarCovers();

        if (store.liked) {
          $('#likedCount').textContent = store.liked.trackCount || '';
          svc.likedIds(store.uid).then((ids) => {
            store.likedIds = ids;
            store.emit('liked:loaded', ids);
          }).catch(() => {});
        }
      } catch (e) {
        console.warn('[app] loadLibrary', e);
        U.toastErr('歌单加载失败：' + api.explain(e));
      }
    },

    renderSideFooter() {
      const foot = $('#sideFoot');
      if (!store.loggedIn) {
        foot.innerHTML = `<button class="login-btn" id="btnLogin">
          <svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M12 12a5 5 0 100-10 5 5 0 000 10zm0 2c-5 0-9 2.7-9 6v2h18v-2c0-3.3-4-6-9-6z"/></svg>
          <span>登录网易云</span></button>`;
        $('#btnLogin').addEventListener('click', () => this.openLogin());
        return;
      }
      const p = store.profile || {};
      // The class names here must match the .user-chip block in styles.css —
      // they used to be `user-card`/`uc-logout`, which matched no rule at all
      // and left the logged-in footer completely unstyled.
      foot.innerHTML = `<div class="user-chip" id="userCard" title="查看个人主页">
        <div class="uc-avatar">
          <img src="${U.esc(global.ne.img(U.cover(p.avatarUrl, 80)))}" alt="">
          ${p.vipType ? `<span class="uc-vip" title="VIP">${icons('<path fill="currentColor" d="M3 7l4 3 5-6 5 6 4-3-2 11H5L3 7z"/>', 10)}</span>` : ''}
        </div>
        <div class="uc-meta">
          <div class="uc-name">${U.esc(p.nickname || '已登录')}</div>
          <div class="uc-sub" id="ucSub">${p.vipType ? 'VIP' : '普通用户'}</div>
        </div>
        <button class="uc-out" id="btnLogout" title="退出登录">
          <svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M10 3h8v18h-8v-2h6V5h-6zm-1.6 5.6L9.8 10l-2 2h6v2h-6l2 2-1.4 1.4L4 13z"/></svg>
        </button>
      </div>`;
      $('#btnLogout').addEventListener('click', async (e) => {
        e.stopPropagation();
        await svc.logout();
        await this.applyAuth({ loggedIn: false });
        U.toastOk('已退出登录');
        this.go('radio');
      });
      $('#userCard').addEventListener('click', () => {
        if (store.uid) this.go('user', { id: store.uid });
      });
      this.fillUserChip();
    },

    /**
     * 侧栏用户卡片的第二行：等级 + 累计听歌数。
     * account() 不返回这两项，得另外问 user/detail；拿不到就保持 VIP/普通用户
     * 的原样文案，不让卡片空着。
     */
    async fillUserChip() {
      if (!store.uid) return;
      try {
        const d = await svc.userDetail(store.uid);
        const sub = $('#ucSub');
        if (!sub) return;   // 期间登出或重绘了
        const parts = [];
        if (d.level) parts.push('Lv.' + d.level);
        if (d.listenSongs) parts.push('听歌 ' + U.fmtCount(d.listenSongs));
        if (store.profile && store.profile.vipType) parts.push('VIP');
        sub.textContent = parts.length ? parts.join(' · ') : (store.profile && store.profile.vipType ? 'VIP' : '普通用户');
      } catch (e) { /* 离线或接口失败时保留默认文案 */ }
    },

    /**
     * 每日签到。
     *
     * `/point/dailyTask` 的 `type` 只有 1（PC 端）会真的签到，type=0 会返回
     * `{code:200, msg:"功能暂不支持"}` —— 看着成功其实什么都没做。今天已经签过
     * 则返回 `code:-2 重复签到`，据此把按钮置为已完成而不是报错。
     */
    async doCheckin(btn, silent) {
      if (!store.loggedIn) {
        if (!silent) U.toastErr('请先登录');
        return;
      }
      const b = btn || $('#uhSign');
      const setState = (text, done) => {
        if (!b) return;
        b.textContent = text;
        b.disabled = !!done;
        b.classList.toggle('done', !!done);
      };
      if (b && b.disabled) return;   // 正在请求 / 已签到
      setState('签到中…', false);
      if (b) b.disabled = true;
      try {
        const r = await svc.dailyTask(1);
        if (r.ok) {
          setState('已签到 +' + (r.point || 0) + ' 积分', true);
          if (!silent) U.toastOk('签到成功，获得 ' + (r.point || 0) + ' 积分');
        } else if (r.already) {
          setState('今日已签到', true);
          if (!silent) U.toast('今天已经签到过了');
        } else {
          setState('每日签到', false);
          if (!silent) U.toastErr('签到失败：' + (r.message || '未知原因'));
        }
      } catch (e) {
        setState('每日签到', false);
        if (!silent) U.toastErr('签到失败：' + api.explain(e));
      }
    },

    /** 启动后自动签到一次，静默，不打扰用户 */
    autoCheckin() {
      if (!store.loggedIn) return;
      if (global.Settings && !global.Settings.get('autoCheckin')) return;
      const today = new Date().toDateString();
      if (this._config && this._config.lastCheckin === today) return;
      if (this._config) this._config.lastCheckin = today;
      this.saveConfig({ lastCheckin: today });
      this.doCheckin(null, true);
    },

    /** 渲染侧栏歌单：创建的歌单 + 收藏的歌单 */
    renderPlaylists() {
      const own = $('#ownPlaylists');
      const sub = $('#subPlaylists');
      own.innerHTML = '';
      sub.innerHTML = '';

      if (!store.loggedIn) {
        own.innerHTML = '<div class="side-hint">登录后显示你的歌单</div>';
        $('#subGroup').hidden = true;
        return;
      }

      const mine = store.playlists.filter((p) => p.specialType !== 5 && !p.subscribed);
      const subs = store.playlists.filter((p) => p.specialType !== 5 && p.subscribed);

      for (const p of mine) own.appendChild(this.playlistSideItem(p));
      if (!mine.length) own.innerHTML = '<div class="side-hint">还没有创建歌单</div>';

      $('#subGroup').hidden = subs.length === 0;
      for (const p of subs) sub.appendChild(this.playlistSideItem(p));
    },

    playlistSideItem(p) {
      // 先用歌单自己的封面顶上（本地就有，立刻可见），等第一首歌封面到了再换，
      // 中间不会出现空框。data-cover 记录当前是哪种，方便调试与验证。
      const node = U.el(`<a class="side-item side-pl" data-pid="${p.id}" title="${U.esc(p.name)}">
        <img class="side-pl-cover" alt="" data-cover="playlist" ${p.cover ? `src="${U.esc(global.ne.img(U.cover(p.cover, 60)))}"` : ''}>
        <span class="side-pl-name">${U.esc(p.name)}</span>
        <span class="side-pl-count">${p.trackCount || 0}</span>
      </a>`);
      node.addEventListener('click', () => this.go('playlist', { id: p.id, name: p.name }));
      node.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const items = [
          { label: '播放', icon: ICON.play, onClick: () => this.playPlaylist(p.id, p.name) },
          { label: '添加到播放队列', icon: ICON.next, onClick: () => this.enqueuePlaylist(p.id, p.name) },
        ];
        if (!p.subscribed) {
          items.push('sep', {
            label: '编辑歌单信息', icon: ICON.copy, onClick: () => this.editPlaylist(p),
          }, {
            label: '删除歌单', icon: ICON.trash, onClick: () => this.deletePlaylist(p),
          });
        }
        U.ctxMenu(items, e.clientX, e.clientY);
      });
      return node;
    },

    /**
     * 侧栏歌单缩略图：换成「这个歌单第一首歌」的封面。
     *
     * 几十个歌单逐个拉详情会把接口打爆，所以：
     *   - 先拿 playlistDetail 的 limit:1（只回一首，~90ms），不拉整个歌单；
     *   - 并发上限 4，其余排队；
     *   - 结果进 api.cached（30 分钟）并在本机留一份，重启后先显缓存再刷新；
     *   - 任何一个失败都不影响其余，静默保留列表里原有的歌单封面。
     */
    async loadSidebarCovers() {
      const imgs = $$('.side-pl-cover');
      if (!imgs.length) return;
      const token = ++this._coverToken;
      const cached = (this._config && this._config.sideCovers) || {};
      const queue = [];
      for (const img of imgs) {
        const pid = Number(img.closest('.side-pl').dataset.pid);
        if (cached[pid]) img.src = global.ne.img(U.cover(cached[pid], 60));
        queue.push(pid);
      }
      let i = 0;
      const worker = async () => {
        while (i < queue.length) {
          const pid = queue[i++];
          if (this._coverToken !== token) return;      // 重新登录 / 重载后放弃旧任务
          try {
            // tracks:false —— 只要第一首歌的封面，别为此把整个歌单抓下来
            // （大歌单要几十次请求才拼得齐）。
            const d = await api.cached('plcover:' + pid, 30 * 60 * 1000,
              () => api.raw('playlistDetail', pid, { limit: 1, tracks: false }));
            const cover = d && d.tracks && d.tracks[0] && d.tracks[0].cover;
            if (!cover || this._coverToken !== token) continue;
            const el = $(`.side-pl[data-pid="${pid}"] .side-pl-cover`);
            if (el) { el.src = global.ne.img(U.cover(cover, 60)); el.classList.add('loaded'); }
            cached[pid] = cover;
          } catch { /* 单个歌单失败就跳过，保留原封面 */ }
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      if (this._coverToken === token) this.saveConfig({ sideCovers: cached });
    },

    // ============================================================
    //  路由
    // ============================================================
    go(name, params = {}, opt = {}) {
      if (!views[name]) { console.warn('[app] unknown route', name); return; }
      // 用户 m15635 第①点：全屏播放页是盖在所有页面之上的一层（z-index 60），
      // 任何跳转都必须先把它收起来 —— 否则新页面渲染在它背后，用户看到的是
      // 「点了歌手名/专辑名没反应」。放在 go() 里而不是逐个调用点补，是因为
      // 跳转入口太多（播放页、播放条、右键菜单、评论里的用户名…），漏一个就复现。
      if (store.nowPlayingOpen) this.toggleNowPlaying(false);
      const route = { name, params };
      const key = name + ':' + JSON.stringify(params);

      if (!opt.replace) {
        const cur = store.history[store.historyIndex];
        if (!cur || cur.key !== key) {
          store.history = store.history.slice(0, store.historyIndex + 1);
          store.history.push({ ...route, key });
          // 限制历史长度
          if (store.history.length > 60) {
            store.history.shift();
          }
          store.historyIndex = store.history.length - 1;
        }
      } else {
        store.history = [{ ...route, key }];
        store.historyIndex = 0;
      }

      store.route = route;
      this.render();
      this.syncNavActive();
      this.syncHistoryButtons();
      this.rememberRoute(name);
    },

    /**
     * 记下当前页面，供「启动时打开的页面 = 上次离开时的页面」用（m34266 第 2 点）。
     *
     * 只记设置里能当首页的那几个（推荐歌单 / 每日推荐 / 榜单 / 播客 / 我喜欢的
     * 音乐 / 最近播放）—— 歌单详情和用户主页带参数，重启后没有合理的目标 id。
     * 也不用进历史栈：这不是一次导航，别把用户的后退键点乱。
     */
    rememberRoute(name) {
      if (!global.Settings) return;
      const known = global.Settings.START_PAGES.some((p) => p.key === name);
      if (!known || name === 'last') return;
      if (this._config && this._config.lastRoute === name) return;   // 没变就别写盘
      this.saveConfig({ lastRoute: name });
    },

    reload() {
      this.render();
    },

    back() {
      if (store.historyIndex <= 0) return;
      store.historyIndex--;
      store.route = store.history[store.historyIndex];
      this.render();
      this.syncNavActive();
      this.syncHistoryButtons();
    },

    forward() {
      if (store.historyIndex >= store.history.length - 1) return;
      store.historyIndex++;
      store.route = store.history[store.historyIndex];
      this.render();
      this.syncNavActive();
      this.syncHistoryButtons();
    },

    syncHistoryButtons() {
      $('#navBack').disabled = store.historyIndex <= 0;
      $('#navFwd').disabled = store.historyIndex >= store.history.length - 1;
    },

    async render() {
      const root = $('#mainScroll');
      const route = store.route;
      if (!route) return;
      const token = ++this._renderToken || (this._renderToken = 1);
      root.scrollTop = 0;

      try {
        await views[route.name](root, route.params || {});
      } catch (e) {
        console.error('[app] render error', route, e);
        if (token === this._renderToken) {
          root.innerHTML = `<div class="page">${uiHelpers.emptyState('页面加载出错', api.explain(e))}</div>`;
        }
      }
    },

    syncNavActive() {
      const r = store.route;
      if (!r) return;
      for (const el of $$('.side-item[data-nav]')) {
        el.classList.toggle('active', el.dataset.nav === r.name);
      }
      const pid = r.name === 'playlist' ? Number(r.params?.id) : null;
      for (const el of $$('.side-pl')) {
        el.classList.toggle('active', pid != null && Number(el.dataset.pid) === pid);
      }
    },

    // ============================================================
    //  播放辅助
    // ============================================================
    async playPlaylist(id, name) {
      try {
        U.toast('正在加载歌单…');
        const pl = await svc.playlistTracks(id, 0);
        if (!pl.tracks.length) { U.toast('这个歌单还没有歌曲'); return; }
        await player.playList(pl.tracks, 0, { id: pl.id, name: pl.name || name });
      } catch (e) { U.toastErr(api.explain(e)); }
    },

    async enqueuePlaylist(id, name) {
      try {
        const pl = await svc.playlistTracks(id, 0);
        await player.enqueue(pl.tracks);
      } catch (e) { U.toastErr(api.explain(e)); }
    },

    async playAlbum(id, name) {
      try {
        const al = await svc.album(id);
        await player.playList(al.songs, 0, { id: 'album:' + al.id, name: al.name || name });
      } catch (e) { U.toastErr(api.explain(e)); }
    },

    /** 播客电台：拉前 60 期节目，用节目里归一化出来的 song 组播放列表 */
    async playPodcast(id, name) {
      try {
        U.toast('正在加载节目…');
        const d = await svc.podcastPrograms(id, 60, 0);
        const songs = (d.programs || []).map((p) => p.song).filter(Boolean);
        if (!songs.length) { U.toast('这个电台还没有节目'); return; }
        const radioName = (d.radio && d.radio.name) || name;
        await player.playList(songs, 0, { id: 'podcast:' + id, name: radioName });
      } catch (e) { U.toastErr(api.explain(e)); }
    },

    // ============================================================
    //  窗口控制
    // ============================================================
    bindWindowControls() {
      $('#tbMinimize').addEventListener('click', () => global.ne.window.control('minimize'));
      $('#tbMaximize').addEventListener('click', () => global.ne.window.control('maximize'));
      $('#tbClose').addEventListener('click', () => global.ne.window.control('close'));
      $('#navBack').addEventListener('click', () => this.back());
      $('#navFwd').addEventListener('click', () => this.forward());
      // 双击标题栏最大化
      $('.titlebar').addEventListener('dblclick', (e) => {
        if (e.target.closest('input, select, button')) return;
        global.ne.window.control('maximize');
      });

      // 从小窗回到主界面：主进程先把窗口 show() 扣住，等我们把入场动画的起始
      // 状态挂好再回执（window:shown）。顺序反了会先闪一帧完整界面。
      global.ne.window.onAppear(() => {
        const b = document.body;
        b.classList.remove('app-appear');
        void b.offsetWidth; // 强制重排，动画才会从头开始
        b.classList.add('app-appear');
        global.ne.window.shown();
      });
      // 动画跑完摘掉类，免得残留的 transform 影响后续布局/定位
      document.body.addEventListener('animationend', (e) => {
        if (e.animationName === 'appAppear') document.body.classList.remove('app-appear');
      });
    },

    /**
     * 标题栏右侧新增的三个入口：皮肤（第 8 点）、设置（第 4 点）、
     * 两种悬浮小窗（第 6 / 7 点）。
     */
    bindTitlebarExtras() {
      global.Skins.bindMenu($('#tbSkin'), $('#skinMenu'));

      global.Settings.bind($('#settingsModal'));
      $('#tbSettings').addEventListener('click', () => global.Settings.open());

      $('#tbMiniV').addEventListener('click', () => global.ne.mini.open('v'));
      $('#tbMiniH').addEventListener('click', () => global.ne.mini.open('h'));
    },

    // ============================================================
    //  悬浮小窗中继（第 6 / 7 点）
    // ============================================================
    /**
     * 只有主窗口有 <audio>。小窗是独立进程，既没有 player 也没有队列，所以它
     * 只负责画界面 + 发命令，真正的播放状态由这里单向推过去。
     *
     * 命令方向：小窗 ne.mini.cmd → 主进程转发 → 这里执行。
     * 状态方向：这里 ne.mini.state → 主进程转发 → 小窗渲染。
     */
    bindMiniRelay() {
      const ne = global.ne;

      ne.mini.onCmd((msg) => {
        if (!msg || !msg.type) return;
        const song = player.current;
        switch (msg.type) {
          case 'toggle': player.toggle(); break;
          case 'next': player.next(); break;
          case 'prev': player.prev(); break;
          case 'seekRatio':
            if (typeof msg.value === 'number') player.seekRatio(msg.value);
            break;
          case 'cycleRepeat': player.cycleRepeat(); this.syncRepeatUI(); break;
          case 'setRepeat':
            player.setRepeat(msg.value);
            this.syncRepeatUI();
            break;
          // 小窗里"随机 / 循环 / 顺序"合成了一个按钮，点一下在三者间轮换
          case 'cycleAll': {
            const order = ['list', 'one', 'shuffle'];
            const next = order[(order.indexOf(player.repeat) + 1) % order.length];
            player.setRepeat(next);
            this.syncRepeatUI();
            U.toast(next === 'shuffle' ? '随机播放' : next === 'one' ? '单曲循环' : '列表循环');
            break;
          }
          case 'like': this.toggleLikeCurrent(); break;
          case 'playAt':
            if (typeof msg.index === 'number') player.playAt(msg.index);
            break;
          case 'openArtist': {
            // 小窗发来的「查看歌手」同样要走多歌手选择（m03577 第⑩点）：
            // 这条消息在主窗口里处理，所以弹窗能正常显示。
            if (!song || !song.artists || !song.artists.length) {
              U.toast('这首歌没有歌手信息');
              return;
            }
            // 先收起小窗：主进程会在小窗关闭时把主窗口放回来
            ne.mini.close();
            this.openArtistChoice(song);
            break;
          }
          case 'openAlbum':
            if (!song || !song.album || !song.album.id) { U.toast('这首歌没有专辑信息'); return; }
            ne.mini.close();
            this.go('album', { id: song.album.id, name: song.album.name });
            break;
          case 'showMain':
            ne.mini.close();
            break;
        }
      });

      // 小窗刚加载好就来要一次全量状态
      ne.mini.onHello(() => { this.pushMiniState(); this.pushMiniQueue(); });

      for (const evt of ['player:track', 'player:state', 'player:repeat', 'like:changed']) {
        store.on(evt, () => this.pushMiniState());
      }
      // 队列是整包数据，只在真正变化时推一次（pushMiniState 走的是 4Hz 的进度事件）
      store.on('player:queue', () => { this.pushMiniState(); this.pushMiniQueue(); });
      // 进度条 4Hz 左右，直接转发，不做节流：小窗要靠它跑歌词
      store.on('player:time', () => this.pushMiniState());
    },

    /** 队列列表单独推：小窗的队列浮层要能列出歌，光有长度不够 */
    pushMiniQueue() {
      const list = player.queue.map((s) => ({
        id: s.id,
        name: s.name,
        artistText: s.artistText || '',
        cover: s.cover || '',
        duration: s.duration || 0,
      }));
      global.ne.mini.queue({ list, index: player.index });
    },

    /** 把小窗需要的全部状态打包推过去 */
    pushMiniState() {
      const song = player.current;
      global.ne.mini.state({
        song: song
          ? {
            id: song.id,
            name: song.name,
            artistText: song.artistText || '',
            artists: (song.artists || []).map((a) => ({ id: a.id, name: a.name })),
            album: song.album ? { id: song.album.id, name: song.album.name } : null,
            cover: song.cover || '',
            duration: song.duration || 0,
          }
          : null,
        playing: !player.audio.paused && !player.audio.ended && !!song,
        position: player.position,
        duration: player.duration || (song && song.duration) || 0,
        repeat: player.repeat,
        liked: !!(song && store.likedIds.has(song.id)),
        lyric: this._lastLyricRaw || null,
        queueLen: player.queue.length,
        volume: store.volume,
        muted: store.muted,
      });
    },

    /**
     * 底栏与悬浮小窗共用的"红心"逻辑。
     *
     * 连点会双发：状态原本是在 await 之后才写进 store 的，所以第二次点击
     * 读到的还是旧值，两次都发出同一个 like（[false,false]），用户看到的是
     * "点了两下没反应/只生效一次"。这里改成先乐观翻转再发请求，失败回滚；
     * 同一首歌的请求按顺序排队，避免网络乱序把最终状态盖错。
     */
    async toggleLikeCurrent() {
      const song = player.current;
      if (!song) return;
      if (!store.loggedIn) { this.openLogin(); return; }
      const id = song.id;
      const liked = !store.likedIds.has(id);
      // 图标先动（乐观更新），但**成功提示等服务端确认之后再弹**：
      // 网易云对 like 有频控，先弹「已添加」再弹「操作过于频繁」会自相矛盾。
      this._applyLike(id, liked);
      try {
        await this._queueLike(id, liked);
        U.toastOk(liked ? '已添加到我喜欢的音乐' : '已取消喜欢');
      } catch (e) {
        this._applyLike(id, !liked); // 回滚
        U.toastErr(api.explain(e));
      }
    },

    /** 只改本地状态并广播，不发请求 */
    _applyLike(id, liked) {
      if (liked) store.likedIds.add(id); else store.likedIds.delete(id);
      store.emit('like:changed', { id, liked });
      this.syncLikeUI();
    },

    /** 同一首歌的 like 请求串行执行，保证服务端最终状态与点击顺序一致 */
    _queueLike(id, liked) {
      const prev = this._likeChain || (this._likeChain = new Map());
      const tail = prev.get(id) || Promise.resolve();
      const next = tail.catch(() => {}).then(() => svc.like(id, liked));
      prev.set(id, next);
      next.catch(() => {}).then(() => { if (prev.get(id) === next) prev.delete(id); });
      return next;
    },

    // ============================================================
    //  搜索
    // ============================================================
    bindSearch() {
      const input = $('#searchInput');
      const clear = $('#searchClear');

      const doSearch = () => {
        const kw = input.value.trim();
        if (!kw) { U.toast('请输入搜索内容'); return; }
        // 搜索范围下拉已按用户要求移除，固定按「歌曲」检索；
        // 搜索结果页内部仍可切换到歌单 / 歌手 / 专辑。
        this.go('search', { kw, type: 1 });
      };

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); doSearch(); }
        if (e.key === 'Escape') { input.value = ''; clear.hidden = true; input.blur(); }
      });
      input.addEventListener('input', () => { clear.hidden = !input.value; });
      clear.addEventListener('click', () => {
        input.value = '';
        clear.hidden = true;
        input.focus();
      });
    },

    // ============================================================
    //  播放条
    // ============================================================
    bindPlayerBar() {
      const a = player.audio;

      $('#btnPlay').addEventListener('click', () => player.toggle());
      $('#btnPrev').addEventListener('click', () => player.prev());
      $('#btnNext').addEventListener('click', () => player.next());
      $('#btnShuffle').addEventListener('click', () => {
        // 走 setRepeat 而不是直接赋值：随机模式要重建乱序队列（player.setRepeat
        // 里的 _rebuildShuffle），直接写 player.repeat 会跳过这一步。
        const on = player.repeat === Player.REPEAT.SHUFFLE;
        player.setRepeat(on ? Player.REPEAT.LIST : Player.REPEAT.SHUFFLE);
        this.syncRepeatUI();
        U.toast(player.repeat === Player.REPEAT.SHUFFLE ? '随机播放' : '顺序播放');
      });
      $('#btnRepeat').addEventListener('click', () => {
        player.cycleRepeat();
        this.syncRepeatUI();
        // cycleRepeat 只在列表 / 单曲之间切，这里不用再考虑随机
        U.toast(player.repeat === Player.REPEAT.ONE ? '单曲循环' : '列表循环');
      });

      // ---- 进度条拖动 ----
      const track = $('#pbTrack');
      let dragging = false;
      const ratioAt = (e) => {
        const r = track.getBoundingClientRect();
        return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      };
      const paint = (ratio) => {
        $('#pbTrackFill').style.width = (ratio * 100) + '%';
        $('#pbTrackKnob').style.left = (ratio * 100) + '%';
      };
      track.addEventListener('mousedown', (e) => {
        if (!player.current) return;
        dragging = true;
        track.classList.add('dragging');
        paint(ratioAt(e));
      });
      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        paint(ratioAt(e));
        const d = player.duration;
        if (d) $('#pbCur').textContent = U.fmtTime(ratioAt(e) * d);
      });
      window.addEventListener('mouseup', (e) => {
        if (!dragging) return;
        dragging = false;
        track.classList.remove('dragging');
        player.seekRatio(ratioAt(e));
      });

      // ---- 喜欢 ----
      $('#pbLike').addEventListener('click', () => { this.toggleLikeCurrent(); });

      // ---- 音量 ----
      const vol = $('#pbVol');
      let volDrag = false;
      const vRatioAt = (e) => {
        const r = vol.getBoundingClientRect();
        return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      };
      const applyVol = (r) => {
        store.volume = r;
        store.muted = false;
        player.setVolume(r);
        player.setMuted(false);
        this.updateVolumeUI();
        this.saveConfig({ volume: r, muted: false });
      };
      vol.addEventListener('mousedown', (e) => { volDrag = true; applyVol(vRatioAt(e)); });
      window.addEventListener('mousemove', (e) => { if (volDrag) applyVol(vRatioAt(e)); });
      window.addEventListener('mouseup', () => { volDrag = false; });
      vol.addEventListener('wheel', (e) => {
        e.preventDefault();
        applyVol(Math.max(0, Math.min(1, store.volume + (e.deltaY < 0 ? 0.05 : -0.05))));
      }, { passive: false });

      $('#btnMute').addEventListener('click', () => {
        store.muted = !store.muted;
        player.setMuted(store.muted);
        player.audio.volume = store.muted ? 0 : store.volume;
        this.updateVolumeUI();
        this.saveConfig({ muted: store.muted });
      });

      // ---- 音质 ----
      // `ne.quality.list()` resolves to `[{ key, label }]` (see main.js
      // `quality:list`). The old code treated each entry as a plain string, so
      // `QUALITY_LABEL[q]` was undefined and every menu row rendered as
      // "[object Object]" — and picking one stored the object as the quality.
      $('#btnQuality').addEventListener('click', async (e) => {
        // `e.currentTarget` is only valid while the event is being dispatched —
        // it is null after the first `await`, so the rect must be read up front.
        const rect = e.currentTarget.getBoundingClientRect();
        let list = [];
        try { list = await global.ne.quality.list(); } catch (err) { list = []; }
        if (!list.length) { U.toastErr('音质列表获取失败'); return; }
        const items = list.map((q) => {
          const key = q.key || q;
          const label = q.label || QUALITY_LABEL[key] || key;
          // 无损只有会员能听，菜单里直接标出来（第 5 点）。
          // 非会员选了这一档不会报错，服务端会静默回落到可用的音质，
          // 不标的话用户会以为「选了无损却还是 320k」是 bug。
          const vip = key === 'lossless' ? '  VIP' : '';
          return {
            label: label + vip + (key === store.quality ? '  ✓' : ''),
            onClick: () => this.setQuality(key),
          };
        });
        U.ctxMenu(items, rect.left - 40, rect.top - items.length * 32 - 10);
      });

      // ---- 歌词页 / 评论 / 队列 ----
      $('#pbComment').addEventListener('click', () => {
        const song = player.current;
        if (!song) { U.toast('还没有在播放歌曲'); return; }
        this.openComments(song);
      });
      $('#pbCover').addEventListener('click', () => this.toggleNowPlaying());
      $('#pbTitle').addEventListener('click', () => this.toggleNowPlaying());
      // 歌手名单独可点：跳该歌手的歌手页。styles.css 早就给了它 cursor:pointer
      // 和 hover 变色，但一直没绑事件，所以点了没有任何反应。
      // 多歌手时取第一个（歌曲行里的歌手链接也是逐个可点的，这里只有一行文字，
      // 做不到逐段命中，故取首位并在有多位时于 tooltip 里列出全部）。
      $('#pbArtist').addEventListener('click', (e) => {
        e.stopPropagation();
        // m03577 第⑩点：多歌手不再盲取第一位，交给 openArtistChoice 决定
        // （一位直接跳，两位以上弹窗选）。
        this.openArtistChoice(player.current);
      });
      $('#btnQueue').addEventListener('click', () => this.toggleQueue());
      $('#npClose').addEventListener('click', () => this.toggleNowPlaying(false));

      // 全屏播放页里的歌手名 / 专辑名可点（用户 m07698 第④点）。
      // 这两段原来是死文字：`.np-sub span` 只写了省略号，没绑事件也没给手型。
      // 点完之后必须先把播放页收起来，否则新页面被整页播放页盖在底下，
      // 用户以为「点了没反应」。
      $('#npArtist').addEventListener('click', (e) => {
        e.stopPropagation();
        const song = player.current;
        if (!song || !song.artists?.length) return;
        this.toggleNowPlaying(false);
        this.openArtistChoice(song);
      });
      $('#npAlbum').addEventListener('click', (e) => {
        e.stopPropagation();
        const song = player.current;
        if (!song || !song.album?.id) return;
        this.toggleNowPlaying(false);
        this.go('album', { id: song.album.id, name: song.album.name });
      });

      // ---- 全屏播放页歌名右键：复制（用户 m09508 第⑦点）----
      //
      // 桌面端把「长按」映射成右键 —— 这一页的右键已经承载了封面「另存为」，
      // 歌名这一格此前没有绑定，加上复制不会和别的菜单打架。
      // 两份内容分开给：「歌名」用于搜索，「歌名 - 歌手」用于贴给别人。
      $('#npTitle').addEventListener('contextmenu', (e) => {
        const song = player.current;
        if (!song) return;
        e.preventDefault();
        e.stopPropagation();
        U.ctxMenu([
          { label: '复制歌名', icon: ICON.copy, onClick: () => U.copy(song.name) },
          {
            label: '复制「歌名 - 歌手」',
            onClick: () => U.copy(`${song.name} - ${song.artistText || ''}`.trim()),
          },
        ], e.clientX, e.clientY);
      });

      // ---- 全屏播放页封面右键：另存封面（第 9 点）----
      $('#npCoverWrap').addEventListener('contextmenu', (e) => {
        const song = player.current;
        if (!song) return;
        e.preventDefault();
        U.ctxMenu([
          {
            label: '保存封面图片',
            icon: ICON.download,
            disabled: !song.cover,
            onClick: () => this.saveCover(song),
          },
        ], e.clientX, e.clientY);
      });

      // ---- 播放条标题区右键 ----
      $('.pb-meta').addEventListener('contextmenu', (e) => {
        const song = player.current;
        if (!song) return;
        e.preventDefault();
        U.ctxMenu([
          { label: '查看专辑', disabled: !song.album?.id, onClick: () => this.go('album', { id: song.album.id, name: song.album.name }) },
          { label: '查看歌手', disabled: !song.artists?.length, onClick: () => this.openArtistChoice(song) },
          { label: '添加到歌单…', icon: ICON.add, onClick: () => this.openAddToPlaylist([song]) },
          { label: '查看评论', icon: ICON.comment, onClick: () => this.openComments(song) },
        ], e.clientX, e.clientY);
      });
    },

    /**
     * 把当前歌曲的封面另存到本地（第 9 点）。
     *
     * 用原始 cover URL（不是 `ne.img()` 的 neimg:// 代理地址）——主进程那边
     * 要自己 net.fetch，不吃本地协议。文件名用「歌手 - 歌名」，主进程还会
     * 再消一次非法字符。
     */
    async saveCover(song) {
      if (!song || !song.cover) { U.toastErr('这首歌没有封面'); return; }
      try {
        const name = (song.artistText ? song.artistText + ' - ' : '') + song.name;
        const r = await global.ne.saveCover(song.cover, name);
        if (r && r.ok) U.toastOk('封面已保存');
        else if (r && r.canceled) { /* 用户自己取消的，不吵他 */ }
        else U.toastErr((r && r.error) || '保存封面失败');
      } catch (e) {
        U.toastErr('保存封面失败');
      }
    },

    updateVolumeUI() {
      const v = store.muted ? 0 : store.volume;
      $('#pbVolFill').style.width = (v * 100) + '%';
      $('#pbVolKnob').style.left = (v * 100) + '%';
      setHidden($('#iconVol'), store.muted || v === 0);
      setHidden($('#iconMute'), !(store.muted || v === 0));
      $('#btnMute').classList.toggle('active', store.muted || v === 0);
    },

    syncRepeatUI() {
      const t = player.repeat;
      const one = t === Player.REPEAT.ONE;
      // 循环按钮只有两个图标：列表循环 / 单曲循环。原来还有第三个
      // `#iconRepeatOff`（带斜杠的循环箭头），在 t===SHUFFLE 时显示。
      //
      // 那个图标正是「点随机播放后循环按钮变形」的来源：cycleRepeat() 现在只在
      // LIST ↔ ONE 之间切（随机已经拆给 #btnShuffle 了，见 player.js 的 cycleRepeat），
      // 所以循环按钮自己永远走不到 SHUFFLE，唯一能点亮它的路径就是点旁边的随机按钮 ——
      // 一点，循环按钮上就糊出一个划掉的循环箭头，看着就像图标坏了。
      // 随机模式下循环按钮保持「列表循环」这个静止形态、只是不亮，语义上也更对。
      setHidden($('#iconRepeatList'), one);
      setHidden($('#iconRepeatOne'), !one);
      // `.pb-btn.active` is the class styles.css actually colours; the old code
      // toggled `.on`, which no rule matched, so the shuffle button never lit up.
      const shuffle = t === Player.REPEAT.SHUFFLE;
      $('#btnShuffle').classList.toggle('active', shuffle);
      $('#btnShuffle').classList.toggle('on', shuffle);
      $('#btnRepeat').classList.toggle('active', one);
      $('#btnRepeat').classList.toggle('on', one);
    },

    syncLikeUI() {
      const song = player.current;
      const liked = song && store.likedIds.has(song.id);
      $('#pbLike').classList.toggle('on', !!liked);
    },

    syncPlayUI(state) {
      const playing = state && state.playing;
      setHidden($('#iconPlay'), !!playing);
      setHidden($('#iconPause'), !playing);
      $('#playerbar').classList.toggle('loading', !!(state && state.loading));
    },

    /** 切换音质；正在播放时重新取流并恢复进度 */
    async setQuality(key) {
      if (!key) return;
      const label = QUALITY_LABEL[key] || key;
      if (key === store.quality) { U.toast('当前已是 ' + label); return; }
      store.quality = key;
      $('#qualityLabel').textContent = label;
      await this.saveConfig({ quality: key });
      U.toastOk('音质已切换为 ' + label);
      // 换流不要求「正在响」（用户 m09508 第②点）：暂停中切档也要换 —— 否则
      // 下次按播放还是旧档的流，用户以为没生效。
      // 把新档位交给 `_refreshUrl`，由索引回答「本机那份够不够」（m11461 第③点）：
      // 够就继续用本地（切到低档时白下一次 128k 没有意义），不够才去网络取。
      if (player.current) {
        try {
          const ok = await player._refreshUrl(key);
          if (ok && !player.audio.paused) await player.audio.play();
        } catch (e) { /* 换流失败时保持原状 */ }
      }
    },

    syncTrackUI(song) {
      if (!song) {
        $('#pbTitle').textContent = '未在播放';
        $('#pbArtist').textContent = '—';
        $('#pbCoverImg').removeAttribute('src');
        $('#npTitle').textContent = '—';
        $('#npArtist').textContent = '';
        $('#npAlbum').textContent = '';
        $('#npCover').removeAttribute('src');
        $('#npBg').style.backgroundImage = '';
        $('#pbCommentCount').hidden = true;
        $('#pbCommentCount').textContent = '';
        return;
      }
      const img = global.ne.img(U.cover(song.cover, 200));
      const big = global.ne.img(U.cover(song.cover, 600));
      $('#pbTitle').textContent = song.name;
      $('#pbArtist').textContent = song.artistText || '';
      // 歌手名可点（跳歌手页）。一行文字无法逐段命中，多歌手时点哪里都进第一位，
      // 所以把完整名单放进 tooltip，让用户至少知道点下去会去哪。
      $('#pbArtist').title = song.artistText ? '查看歌手：' + song.artistText : '';
      $('#pbCoverImg').src = img;
      $('#npTitle').textContent = song.name;
      $('#npArtist').textContent = song.artistText || '';
      $('#npAlbum').textContent = song.album ? song.album.name : '';
      $('#npCover').src = big;
      $('#npBg').style.backgroundImage = `url("${big}")`;
      document.title = song.name + ' - ' + (song.artistText || '') + ' | 网易云音乐 Lite';
      this.syncLikeUI();
      this.loadLyrics(song);
      this.loadCommentBadge(song);
      // 评论面板开着而且看的是「歌曲」评论时才跟着切歌刷新；
      // 如果面板里装的是歌单评论（第 11 点），切歌不该把它冲掉。
      if (store.nowPlayingOpen && store.currentTab === 'comments') {
        const t = this._commentTarget;
        if (!t || t.type === 'song') this.loadComments({ type: 'song', id: song.id });
      }
    },

    /**
     * 底栏评论按钮右上角的数量角标。
     * 与 loadComments 分开：角标是常驻信息，用户没打开评论 Tab 时也要显示，
     * 所以不能挂在 loadComments 里（那个只在点开评论时才跑）。
     */
    async loadCommentBadge(song) {
      if (!song) { $('#pbCommentCount').hidden = true; return; }
      this._badgeSongId = song.id;
      try {
        const r = await svc.commentCount(song.id);
        // 期间可能已经切歌，旧结果丢弃
        if (this._badgeSongId !== song.id) return;
        const txt = U.fmtBadge(r.total);
        const el = $('#pbCommentCount');
        el.textContent = txt;
        el.hidden = !txt;
        $('#pbComment').title = r.total
          ? `查看当前歌曲评论（${U.fmtCount(r.total)} 条）`
          : '查看当前歌曲评论';
      } catch (e) {
        if (this._badgeSongId !== song.id) return;
        $('#pbCommentCount').hidden = true;
      }
    },

    // ============================================================
    //  歌词
    // ============================================================
    bindLyricPane() {
      this.lyricView = new Lrc.LyricView($('#lyricScroll'), $('#lyricList'));
      $('#lyricScroll').addEventListener('lyricseek', (e) => {
        player.seek(e.detail);
      });
      for (const tab of $$('.np-tab')) {
        tab.addEventListener('click', () => {
          for (const t of $$('.np-tab')) t.classList.toggle('active', t === tab);
          const name = tab.dataset.nptab;
          store.currentTab = name;
          $('#npLyricPane').hidden = name !== 'lyric';
          $('#npCommentPane').hidden = name !== 'comments';
          // 重新点开评论 Tab 时，如果面板里现在装的是歌单评论（第 11 点），
          // 就别用正在播放的那首歌覆盖掉它 —— 用户刚点开就是想接着看。
          if (name === 'comments') {
            const t = this._commentTarget;
            if (t && t.type !== 'song') this.loadComments(t);
            else if (player.current) this.loadComments({ type: 'song', id: player.current.id });
          }
        });
      }
    },

    async loadLyrics(song) {
      this._lyricSongId = song.id;
      // 悬浮小窗要自己渲染一份滚动歌词，它拿不到这里的 LyricView，所以把原始
      // 歌词对象缓存下来随状态一起推过去（小窗那边自己 new 一个 LyricView）。
      this._lastLyricRaw = null;
      this.lyricView.set(null);
      this.lyricView.listEl.innerHTML = '<div class="lyric-empty">歌词加载中…</div>';
      try {
        const raw = await svc.lyrics(song.id);
        if (this._lyricSongId !== song.id) return;   // 已经切歌了
        this._lastLyricRaw = raw || null;
        this.lyricView.set(raw);
        if (this.lyricView.lyrics.empty && raw && raw.nolyric) {
          this.lyricView.listEl.innerHTML = '<div class="lyric-empty">纯音乐，请欣赏</div>';
        }
        this.pushMiniState();
      } catch (e) {
        if (this._lyricSongId !== song.id) return;
        this.lyricView.listEl.innerHTML = '<div class="lyric-empty">歌词加载失败</div>';
      }
    },

    // ============================================================
    //  评论
    // ============================================================

    /**
     * 往评论面板里装一份评论。
     *
     * `target` 是 `{ type, id }`，type 取 'song' | 'playlist' | 'album' —— 三个
     * 在接口层是同一套（threadId 前缀不同，views.js 的 CommentList 会拼），
     * 所以这里只记下"当前在看谁的评论"，便于切歌时判断该不该重载。
     */
    async loadComments(target) {
      const box = $('#npComments');
      if (!target || !target.id) return;
      this._commentTarget = target;
      const key = target.type + ':' + target.id;
      this._commentKey = key;
      box.innerHTML = '<div class="cm-loading">评论加载中…</div>';
      try {
        const r = await svc.comments(target.type, target.id, 1, 0);
        if (this._commentKey !== key) return;   // 期间用户已经切走了
        $('#npCommentCount').textContent = r.total ? `(${U.fmtCount(r.total)})` : '';
        box.innerHTML = '';
        box.appendChild(CommentList(target.type, target.id, r.total));
      } catch (e) {
        if (this._commentKey !== key) return;
        box.innerHTML = `<div class="cm-loading">${U.esc(api.explain(e))}</div>`;
      }
    },

    /** 打开某首歌的评论（弹到全屏播放页的评论 Tab） */
    openComments(song) {
      if (!song) return;
      if (!player.current || player.current.id !== song.id) {
        // 不在播这首歌：只打开评论面板，不切歌
        $('#npTitle').textContent = song.name;
        $('#npArtist').textContent = song.artistText || '';
        $('#npAlbum').textContent = song.album ? song.album.name : '';
        $('#npCover').src = global.ne.img(U.cover(song.cover, 600));
        $('#npBg').style.backgroundImage = `url("${global.ne.img(U.cover(song.cover, 600))}")`;
      }
      this.toggleNowPlaying(true);
      this.showCommentsTab({ type: 'song', id: song.id });
    },

    /**
     * 打开歌单的评论（第 11 点）。
     *
     * 歌单不是"正在播放的东西"，所以不做 openComments 那套封面替换——那张大
     * 封面属于播放器，把它临时改成歌单封面会让用户以为歌单开始播了。这里只
     * 把评论面板拉出来，标题栏保持原样。
     *
     * 注：歌单页上的「查看评论」按钮已按 m34266 换成「多选」，这个入口现在只
     * 保留给内部调用（评论面板本身已经支持 playlist），不再挂在歌单页上。
     */
    openPlaylistComments(pl) {
      if (!pl || !pl.id) return;
      this.toggleNowPlaying(true);
      this.showCommentsTab({ type: 'playlist', id: pl.id });
    },

    /** 切到评论 Tab 并加载指定目标 */
    showCommentsTab(target) {
      const tab = $('.np-tab[data-nptab="comments"]');
      if (tab) tab.click();
      this.loadComments(target);
    },

    // ============================================================
    //  全屏播放页 / 队列
    // ============================================================
    toggleNowPlaying(open) {
      const on = open === undefined ? !store.nowPlayingOpen : !!open;
      store.nowPlayingOpen = on;
      const el = $('#nowplaying');
      if (on) {
        el.hidden = false;
        // 重挂入场动画：hidden 走的是 display:none，动画在重新显示时会自己
        // 重放，但如果上一次还没播完就被关掉（连点 / 快捷键），残留的
        // animation 状态会让这次显示没有过渡，所以强制重置一次。
        el.classList.remove('np-out');
        el.style.animation = 'none';
        void el.offsetWidth; // 强制重排，动画才会重新开始
        el.style.animation = '';
      } else if (!el.hidden) {
        // 收起：先播一遍向下渐隐，播完再真正藏起来。
        // 用 animationend 而不是定时器，动画时长只在 CSS 里写一份。
        const done = () => {
          el.removeEventListener('animationend', done);
          if (!store.nowPlayingOpen) el.hidden = true;
        };
        el.addEventListener('animationend', done);
        el.classList.add('np-out');
        // 兜底：动画被 body.no-anim 关掉时不会有 animationend，别把页面卡在屏幕上
        setTimeout(done, 340);
      }
      document.body.classList.toggle('np-open', on);
      if (on && player.current) {
        if (store.currentTab === 'comments') {
          // 面板里可能正装着歌单评论（第 11 点），别用当前歌曲盖上
          const t = this._commentTarget;
          if (t && t.type !== 'song') this.loadComments(t);
          else this.loadComments({ type: 'song', id: player.current.id });
        }
      }
    },

    toggleQueue(open) {
      const on = open === undefined ? !store.queueOpen : !!open;
      store.queueOpen = on;
      const el = $('#queuePanel');
      if (on) {
        el.hidden = false;
        // 和全屏播放页同一套：重挂入场动画，连点关闭再打开时也有过渡
        el.classList.remove('qp-out');
        el.style.animation = 'none';
        void el.offsetWidth;
        el.style.animation = '';
        // 面板现在只有「播放队列」一种内容：m36690 第⑤点把下载那一片挪去了
        // 侧栏的「已下载音乐」独立页，这里不再切页签，也不再画下载列表。
        this.renderQueue();
      } else if (!el.hidden) {
        // 关闭：先原路滑出渐隐，播完再真正藏起来
        const done = () => {
          el.removeEventListener('animationend', done);
          if (store.queueOpen) return;
          el.hidden = true;
          // 藏起来之后把动画类摘掉：否则面板虽然看不见，却还挂着
          // pointer-events:none 和 forwards 的末帧状态，下次打开前的重排
          // 也得靠它自己清干净。
          el.classList.remove('qp-out');
          el.style.animation = '';
        };
        el.addEventListener('animationend', done);
        el.classList.add('qp-out');
        // 兜底：body.no-anim 关掉动画时不会有 animationend，别把面板卡在屏幕上
        setTimeout(done, 300);
      }
    },

    /**
     * 面板里切「播放队列 / 下载」两页。
     *
     * m36690 第⑤点之后这里已经没有第二个页签了：下载那一片整体搬到了侧栏的
     * 「已下载音乐」独立页（见 views.downloads），面板只剩播放队列。留着一个
     * 永远为 'queue' 的切换函数只会让人以为还有别的内容，于是整段删掉。
     */

    renderQueue() {
      const list = $('#qpList');
      const q = player.queue;
      // `#qpCount` 是页签上的计数，页签删掉后它也不存在了，所以按需取。
      const cnt = $('#qpCount');
      if (cnt) cnt.textContent = q.length;
      $('#queueCount').textContent = q.length;
      list.innerHTML = '';
      if (!q.length) {
        list.innerHTML = '<div class="qp-empty">播放队列是空的</div>';
        return;
      }
      const frag = document.createDocumentFragment();
      q.forEach((song, i) => {
        const node = U.el(`<div class="qp-item${i === player.index ? ' playing' : ''}" data-i="${i}">
          <span class="qp-idx">${i === player.index ? '♪' : String(i + 1).padStart(2, '0')}</span>
          <div class="qp-meta">
            <div class="qp-name">${U.esc(song.name)}</div>
            <div class="qp-artist">${U.esc(song.artistText || '')}</div>
          </div>
          <button class="qp-del" title="从队列移除">
            <svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg>
          </button>
        </div>`);
        node.addEventListener('dblclick', () => player.playAt(i));
        node.addEventListener('click', (e) => {
          if (e.target.closest('.qp-del')) return;
          player.playAt(i);
        });
        node.querySelector('.qp-del').addEventListener('click', (e) => {
          e.stopPropagation();
          player.removeAt(i);
        });
        node.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          U.ctxMenu([
            { label: '播放', icon: ICON.play, onClick: () => player.playAt(i) },
            { label: '下一首播放', icon: ICON.next, onClick: () => { player.removeAt(i); player.playNext([song]); } },
            'sep',
            { label: '添加到歌单…', icon: ICON.add, onClick: () => this.openAddToPlaylist([song]) },
            { label: '从队列移除', icon: ICON.trash, onClick: () => player.removeAt(i) },
          ], e.clientX, e.clientY);
        });
        frag.appendChild(node);
      });
      list.appendChild(frag);
      // 当前项滚动到可见
      const cur = list.querySelector('.qp-item.playing');
      if (cur) U.scrollIntoViewIfNeeded(list, cur);
    },

    // ============================================================
    //  下载历史（第 5 点 → m36690 第⑤点搬进侧栏独立页）
    // ============================================================
    /**
     * 下载是主进程里的串行队列，进度靠 `download:list` 事件推过来。
     *
     * m36690 第⑤点之前这里画的是播放队列面板里的第二片页签；现在画的是侧栏
     * 「已下载音乐」整页（`#dlList`）。列表内容不变，仍然只画状态、进度百分比、
     * 取消、完成后「打开文件夹」。进度条用宽度而不是 CSS 动画 —— 主进程每
     * 200ms 才推一次，动画补间反而会让进度看起来比实际快。
     */
    renderDownloads(list) {
      const el = $('#dlList');
      if (!el) return;
      const tasks = list || this._dlTasks || [];
      this._dlTasks = tasks;
      this.paintDlCount();
      /* m01537 第①点：这一页只剩「在下的」。
         以前 done 的条目也画在这里，和排队中/失败/暂停的混成一条列表 —— 一边是
         百分比进度条、一边是能播的歌，两种东西挤在一起谁也不好读。现在完成的
         从这一页消失（它们已经进了「已下载音乐」，那页按本机索引画），这里只看
         得到还需要用户关心的事：等着的、在跑的、暂停的、失败的。
         已取消的也不画：取消就是「我不要了」，留在列表里只会积灰。 */
      const pending = tasks.filter((t) => t.state === 'queued' || t.state === 'running'
        || t.state === 'paused' || t.state === 'error');
      const active = pending.filter((t) => t.state === 'queued' || t.state === 'running').length;
      const paused = pending.filter((t) => t.state === 'paused').length;
      const failed = pending.filter((t) => t.state === 'error').length;
      // 队列概况写进页头副标题
      const sub = $('#dlqSub');
      if (sub) {
        const bits = [];
        if (active) bits.push(`${active} 个在下载`);
        if (paused) bits.push(`${paused} 个已暂停`);
        if (failed) bits.push(`${failed} 个失败`);
        sub.textContent = bits.length ? bits.join(' · ') : '';
      }
      /* 批量按钮（m02003 第②点）：只在真有任务时出现，文案跟着当前状态翻转 ——
         有在跑 / 在等的就是「全部暂停」，全是暂停和失败的就是「全部开始」。
         动画期间列表每 200ms 刷一次，所以这里每次都要按当前状态重新写一遍。 */
      const toggle = $('#dlqToggle');
      if (toggle) {
        toggle.hidden = !pending.length;
        toggle.textContent = active ? '全部暂停' : '全部开始';
        toggle.title = active
          ? '暂停全部任务（半截文件保留，之后可以一起接着下）'
          : '把暂停和失败的任务一起放回队列';
      }
      const clearBtn = $('#dlqClear');
      if (clearBtn) clearBtn.hidden = !pending.length;
      if (!pending.length) {
        el.innerHTML = '<div class="qp-empty">没有正在下载的歌。到歌曲的「⋯」菜单里选「下载」，或在歌单里多选后批量下载。</div>';
        return;
      }
      el.innerHTML = '';
      const frag = document.createDocumentFragment();
      // 按下载队列本身的顺序从上往下（本轮第③点）：主进程的 `tasks` 就是入队顺序，
      // 下载器从队头一个一个取，所以列表第一行就是下一个真正开下的。
      // 原来这里是 `pending.reverse()`（新的排最上面），和实际下载顺序正好相反 ——
      // 排队 20 首时，屏幕上第一个反而是最后才会轮到的那首。
      for (const t of pending) {
        const pct = t.total ? Math.min(100, Math.round((t.received / t.total) * 100)) : 0;
        const stateText = t.state === 'queued' ? '等待中'
          : t.state === 'running' ? `${pct}%`
            : t.state === 'paused' ? '已暂停'
              : t.state === 'done' ? '已完成'
                : t.state === 'canceled' ? '已取消' : '失败';
        // 封面缩略图（m38831 第②点）：任务里本来就记着 `cover`（enqueue 时从歌曲
        // 带过来），只是以前没画。这里刻意复用 TrackList 的 `.tl-cover` 类名 ——
        // 五款皮肤给它写的圆角 / 描边 / 底色规则会自动生效，不用再抄一份到
        // `.qp-dl-*` 上（`.dl-*` 与 `.qp-dl-*` 在 skins.css 里本来就是零命中）。
        const node = U.el(`<div class="qp-item qp-dl" data-key="${t.key}">
          ${t.cover
            ? `<img class="tl-cover" loading="lazy" alt="" src="${U.esc(global.ne.img(U.cover(t.cover, 60)))}">`
            : '<span class="tl-cover tl-cover-empty"></span>'}
          <div class="qp-dl-body">
            <div class="qp-name">${U.esc(t.name || '')}${t.vip ? '<span class="qp-dl-vip">VIP</span>' : ''}</div>
            <div class="qp-artist">${U.esc(t.artistText || '')}</div>
            ${t.state === 'running' || t.state === 'paused' ? `<div class="qp-dl-bar"><i style="width:${pct}%"></i></div>` : ''}
            ${t.error ? `<div class="qp-dl-err">${U.esc(t.error)}</div>` : ''}
          </div>
          <span class="qp-dl-state ${t.state}">${stateText}</span>
          ${t.state === 'done'
            ? '<button class="qp-del qp-dl-reveal" title="打开所在文件夹"><svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M10 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V8a2 2 0 00-2-2h-8z"/></svg></button>'
            : (t.state === 'queued' || t.state === 'running'
              ? '<button class="qp-del qp-dl-pause" title="暂停（保留半截文件，继续时从断点接着下）"><svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg></button>'
                + '<button class="qp-del qp-dl-cancel" title="取消下载"><svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg></button>'
              : t.state === 'paused'
                ? '<button class="qp-del qp-dl-resume" title="继续下载"><svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M8 5v14l11-7z"/></svg></button>'
                  + '<button class="qp-del qp-dl-cancel" title="取消下载"><svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg></button>'
                : t.state === 'error'
                  ? '<button class="qp-del qp-dl-retry" title="重试（有断点就从断点接着下）"><svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M12 5V1L7 6l5 5V7a5 5 0 11-5 5H5a7 7 0 107-7z"/></svg></button>'
                    + '<button class="qp-del qp-dl-cancel" title="取消下载"><svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg></button>'
                  : '')}
        </div>`);
        // 落盘路径不再画在行里（m38831 第②点）：一条绝对路径有一百多个字符，
        // 既撑高了行、又把「已完成」这一行挤成两三行文字；真正需要找文件的人
        // 点行尾的「打开所在文件夹」更快。路径仍在 `t.file` 里，只是不展示。
        const cancel = node.querySelector('.qp-dl-cancel');
        if (cancel) cancel.addEventListener('click', () => global.ne.download.cancel(t.key));
        const pause = node.querySelector('.qp-dl-pause');
        if (pause) pause.addEventListener('click', () => global.ne.download.pause(t.key));
        const resume = node.querySelector('.qp-dl-resume');
        if (resume) resume.addEventListener('click', () => global.ne.download.resume(t.key));
        const retry = node.querySelector('.qp-dl-retry');
        if (retry) retry.addEventListener('click', () => global.ne.download.resume(t.key));
        const reveal = node.querySelector('.qp-dl-reveal');
        if (reveal) reveal.addEventListener('click', () => this.revealDownload(t.key));
        frag.appendChild(node);
      }
      el.appendChild(frag);
    },

    /**
     * 主进程推送下载列表（第 5 点）。
     *
     * 侧栏那一栏的计数要一直准（用户没打开这一页时也在下），所以计数每次都刷；
     * 列表只在正停在「已下载音乐」页时才重画，避免在别的页面上白写 DOM。
     */
    bindDownloads() {
      if (!global.ne.download || !global.ne.download.onList) return;
      // m01537 第①点：队列搬到了独立的「正在下载」页，已下载音乐页不再订阅它
      const route = () => (store.route && store.route.name === 'downloading');
      global.ne.download.onList((list) => {
        this._dlTasks = list || [];
        this.paintDlCount();
        if (route()) this.renderDownloads(this._dlTasks);
      });
      global.ne.download.list().then((list) => {
        this._dlTasks = list || [];
        this.paintDlCount();
        if (route()) this.renderDownloads(this._dlTasks);
      }).catch(() => { /* 主进程还没就绪 */ });
    },

    /**
     * 侧栏两栏的计数（m01537 第①点）。
     *
     * - 「正在下载」：排队 + 进行中的条数。没在下载就把角标藏起来 —— 常驻一个
     *   0 会让这一栏看起来像坏了。
     * - 「已下载音乐」：本机索引里的歌曲数（以前是下载历史总条数，那一页现在画
     *   的是本机歌曲，数字必须和列表对得上）。
     */
    paintDlCount() {
      const tasks = this._dlTasks || [];
      const active = tasks.filter((t) => t.state === 'queued' || t.state === 'running').length;
      const act = $('#dlActiveCount');
      if (act) act.textContent = active ? String(active) : '';
      const el = $('#dlCount');
      if (el) {
        const n = (store.localInfo && store.localInfo.count) || 0;
        el.textContent = n ? String(n) : '';
      }
    },

    /**
     * 本地文件索引（m35069 第 1、2 点）。
     *
     * 索引住在主进程（扫文件夹、下载完成都往它里面加），渲染层通过
     * `local:changed` 事件拿到一份「哪些歌本机有」的 id 列表。启动时先拉一次，
     * 否则列表里的「√」要等到第一次扫描 / 下载完才会亮。
     */
    bindLocal() {
      const apply = (payload) => {
        const ids = (payload && payload.ids) || [];
        store.localIds = new Set(ids.map(Number));
        store.localInfo = (payload && payload.info) || { count: store.localIds.size, dirs: [], at: 0 };
        this.paintLocal();
        // 侧栏「已下载音乐」的计数就是索引条数，索引一变就得跟着变
        this.paintDlCount();
        // 再发一条 store 事件：主进程的 `local:changed` 是 IPC，视图层拿不到
        // （也不想让每个视图各自去订阅 IPC），所以在这里转成页面内的事件。
        store.emit('local:changed', store.localInfo);
      };
      if (global.ne.local && global.ne.local.onChanged) {
        global.ne.local.onChanged(apply);
        // 扫描进度（m00001 第②点）：主进程边扫边推，这里更新浮层
        if (global.ne.local.onProgress) {
          global.ne.local.onProgress((p) => {
            if (!p) return;
            if (p.phase === 'done') {
              // 先让进度条走满，再收浮层：立刻消失会让人以为「没扫完就断了」
              this.updateScanProgress({ pct: 100 });
              clearTimeout(this._scanDoneTimer);
              this._scanDoneTimer = setTimeout(() => this.hideScanProgress(), 260);
              return;
            }
            this.showScanProgress();
            this.updateScanProgress(p);
          });
        }
        // 启动时先拉一次：否则列表里的「√」要等到第一次扫描 / 下载完才会亮
        global.ne.local.ids().then((ids) => {
          if (!ids || !ids.length) return;
          apply({ ids, info: store.localInfo });
        }).catch(() => { /* 主进程还没就绪 */ });
        global.ne.local.info().then((info) => {
          if (!info) return;
          apply({ ids: [...store.localIds], info });
        }).catch(() => {});
      }
    },

    /**
     * 扫描进度浮层（m00001 第②点）。
     *
     * 只在扫描期间存在：`hidden` 切换而不是插删节点，避免每次扫描都重新建 DOM。
     * 进度条宽度用行内 style 直接写 —— 主进程是按文件/歌曲节流推送的，
     * 交给 CSS transition 补间反而会让「卡在 80% 匹配」看起来像假进度。
     */
    showScanProgress(text) {
      let mask = $('#scanMask');
      if (!mask) {
        mask = U.el(`<div class="scan-mask" id="scanMask" hidden>
          <div class="scan-card" role="dialog" aria-live="polite" aria-label="正在扫描本地文件">
            <div class="scan-title">正在扫描本地文件</div>
            <div class="scan-bar"><i id="scanBar"></i></div>
            <div class="scan-file" id="scanFile">准备中…</div>
            <div class="scan-count" id="scanCount"></div>
          </div>
        </div>`);
        document.body.appendChild(mask);
      }
      mask.hidden = false;
      if (text) {
        const file = $('#scanFile');
        if (file) { file.textContent = text; file.title = text; }
      }
    },

    updateScanProgress(p) {
      const mask = $('#scanMask');
      if (!mask || mask.hidden) return;
      const pct = Math.max(0, Math.min(100, Number(p.pct) || 0));
      const bar = $('#scanBar');
      if (bar) bar.style.width = pct + '%';
      const file = $('#scanFile');
      if (file && p.file) { file.textContent = p.file; file.title = p.file; }
      const count = $('#scanCount');
      if (count) {
        if (p.phase === 'tags' && p.total) count.textContent = `已扫描 ${p.done || 0} / ${p.total} 个文件`;
        else if (p.phase === 'match' && p.total) count.textContent = `正在匹配第 ${p.done || 0} / ${p.total} 首歌曲`;
        else if (p.phase === 'walk') count.textContent = `已找到 ${p.found || 0} 个音频文件`;
        else count.textContent = p.label || '';
      }
      const title = mask.querySelector('.scan-title');
      if (title) title.textContent = p.phase === 'match' ? '正在匹配歌曲' : '正在扫描本地文件';
    },

    hideScanProgress() {
      const mask = $('#scanMask');
      if (mask) mask.hidden = true;
    },

    /**
     * 本地扫描用的歌曲字典（m00001 第③点）。
     *
     * 以前扫描按钮在歌单页，字典天然就是「这个歌单的 tracks」。搬到已下载音乐页
     * 之后没有那个上下文了，只能把这次会话里见过的歌尽量凑齐：最近播放、
     * 看过的列表（store.noteSong 在每一行渲染时登记）、下载记录。凑不齐的部分
     * 由调用方再补一次「我喜欢的音乐」（见 views.downloads）。
     */
    scanDictionary() {
      const map = new Map();
      const add = (s) => { if (s && s.id) map.set(Number(s.id), s); };
      for (const x of store.recent || []) add(x && x.song);
      for (const s of (store.knownSongs ? store.knownSongs.values() : [])) add(s);
      for (const t of this._dlTasks || []) {
        if (t && t.songId) {
          add({
            id: t.songId,
            name: t.name || '',
            artistText: t.artistText || '',
            artists: [],
            album: t.album ? { name: t.album } : null,
          });
        }
      }
      return [...map.values()];
    },

    /**
     * 把「已下载 / 本地有」的状态刷到当前列表的「√」列上。
     *
     * 直接扫 `#mainScroll` 里的行，和 like:changed 那条路一致 —— 列表根节点
     * 上虽然有 `_refreshLocal`，但 App 这边拿不到那个引用（views 每次渲染都
     * 新建一个），按 DOM 扫反而更简单也更不容易漏。
     */
    paintLocal() {
      const root = $('#mainScroll');
      if (!root) return;
      for (const row of root.querySelectorAll('.tl-row')) {
        const btn = row.querySelector('.tl-dl');
        if (!btn) continue;
        const on = store.localIds.has(Number(row.dataset.id));
        btn.classList.toggle('on', on);
        btn.title = on ? '已下载到本地（点击在文件夹中显示）' : '未下载（点击下载）';
        btn.innerHTML = icons(on ? ICON.check : ICON.download, 13);
      }
    },

    bindQueuePanel() {
      $('#qpClear').addEventListener('click', () => {
        player.clearQueue();
        this.renderQueue();
        U.toast('已清空播放队列');
      });
      // 面板里的两片页签（播放队列 / 下载）在 m36690 第⑤点整体删掉了，下载挪
      // 去了侧栏。m01537 第①点又把它拆成两页：「正在下载」只放队列，「已下载音乐」
      // 只放本机索引里的歌，所以「清除记录」按钮整体去掉了 —— 完成的条目不再出现
      // 在队列页，历史记不记录已经不影响界面。这里只剩队列自己的操作。
    },

    // ============================================================
    //  侧栏
    // ============================================================
    bindSidebar() {
      for (const el of $$('.side-item[data-nav]')) {
        el.addEventListener('click', () => this.go(el.dataset.nav));
      }
      // 折叠「创建的歌单」/「收藏的歌单」；状态记在本机，重启后保持
      const folds = [
        { btn: '#ownFold', group: '#ownGroup', list: '#ownPlaylists', key: 'foldOwn' },
        { btn: '#subFold', group: '#subGroup', list: '#subPlaylists', key: 'foldSub' },
      ];
      for (const f of folds) {
        const btn = $(f.btn);
        if (!btn) continue;
        btn.addEventListener('click', () => {
          const group = $(f.group);
          const collapsed = !group.classList.contains('collapsed');
          this.applyFold(f, collapsed);
          this.saveConfig({ [f.key]: collapsed });
        });
      }
      $('#btnCreatePlaylist').addEventListener('click', async () => {
        if (!store.loggedIn) { this.openLogin(); return; }
        // Electron 里没有 prompt()，用自绘弹窗（见 App.askText）
        const name = await this.askText('新建歌单名称', '我的歌单');
        if (!name) return;
        try {
          const r = await svc.playlistCreate(name);
          U.toastOk('歌单已创建');
          await this.loadLibrary();
          if (r && r.playlist && r.playlist.id) this.go('playlist', { id: r.playlist.id, name: r.playlist.name });
        } catch (e) { U.toastErr(api.explain(e)); }
      });
    },

    /** 应用折叠状态：列表隐藏、箭头旋转、aria 同步 */
    applyFold(f, collapsed) {
      const group = $(f.group);
      const list = $(f.list);
      const btn = $(f.btn);
      if (group) group.classList.toggle('collapsed', collapsed);
      if (list) list.classList.toggle('collapsed', collapsed);
      if (btn) btn.setAttribute('aria-expanded', String(!collapsed));
    },

    /** 从配置恢复两个折叠状态 */
    restoreFolds() {
      const cfg = this._config || {};
      this.applyFold({ btn: '#ownFold', group: '#ownGroup', list: '#ownPlaylists' }, !!cfg.foldOwn);
      this.applyFold({ btn: '#subFold', group: '#subGroup', list: '#subPlaylists' }, !!cfg.foldSub);
    },

    async deletePlaylist(p) {
      if (!confirm(`确定删除歌单「${p.name}」吗？此操作不可恢复。`)) return;
      try {
        await svc.playlistDelete(p.id);
        U.toastOk('歌单已删除');
        if (store.route?.name === 'playlist' && Number(store.route.params?.id) === p.id) this.go('radio');
        await this.loadLibrary();
      } catch (e) { U.toastErr(api.explain(e)); }
    },

    async editPlaylist(p) {
      const name = await this.askText('修改歌单名称', p.name);
      if (!name || name === p.name) return;
      try {
        await svc.raw('playlistUpdate', p.id, { name });
        U.toastOk('已更新');
        await this.loadLibrary();
      } catch (e) { U.toastErr(api.explain(e)); }
    },

    // ============================================================
    //  输入弹窗
    // ============================================================

    /**
     * 自绘的单行输入弹窗，替代 `window.prompt`。
     *
     * Electron 的渲染进程没有实现 prompt：调用会直接抛
     * `prompt() is not supported.`，点击处理函数当场中断，
     * 「新建歌单」「重命名歌单」因此完全没有反应。
     *
     * @param {string} title      弹窗标题
     * @param {string} [value]    初始值
     * @param {string} [placeholder]
     * @returns {Promise<string|null>} 去掉首尾空白的文本；取消 / 空值返回 null
     */
    askText(title, value, placeholder) {
      return new Promise((resolve) => {
        const mask = $('#askModal');
        const input = $('#askInput');
        const err = $('#askErr');
        const okBtn = $('#askOk');
        const cancelBtn = $('#askCancel');

        $('#askTitle').textContent = title || '请输入名称';
        input.value = value || '';
        input.placeholder = placeholder || '';
        err.textContent = '';

        let settled = false;
        const done = (result) => {
          if (settled) return;
          settled = true;
          mask.hidden = true;
          document.removeEventListener('keydown', onKey, true);
          okBtn.removeEventListener('click', onOk);
          cancelBtn.removeEventListener('click', onCancel);
          mask.removeEventListener('mousedown', onMask);
          resolve(result);
        };

        const submit = () => {
          const v = input.value.trim();
          if (!v) { err.textContent = '名称不能为空'; input.focus(); return; }
          done(v);
        };
        const onOk = (e) => { e.preventDefault(); submit(); };
        const onCancel = (e) => { e.preventDefault(); done(null); };
        const onMask = (e) => { if (e.target === mask) done(null); };
        const onKey = (e) => {
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); }
          else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); submit(); }
        };

        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        mask.addEventListener('mousedown', onMask);
        // 捕获阶段：避免全局快捷键（空格播放/暂停等）抢走回车
        document.addEventListener('keydown', onKey, true);

        mask.hidden = false;
        input.focus();
        input.select();
      });
    },

    // ============================================================
    //  登录弹窗
    // ============================================================
    openLogin() {
      $('#loginModal').hidden = false;
      const active = $('.login-tab.active');
      const tab = active ? active.dataset.ltab : 'qr';
      this.switchLoginTab(tab);
    },

    closeLogin() {
      $('#loginModal').hidden = true;
      this.stopQrPoll();
    },

    // ============================================================
    //  安全验证弹窗（关注被 -462 拦截时）
    // ============================================================

    /**
     * 展示安全验证二维码。
     *
     * `-462` 是账号级风控门：服务端会带回 verifyType / verifyId / verifyToken
     * 和一组 event_id + sign，用它们去 /frontrisk/verify/getqrcode 换一张
     * 二维码，用官方 App 扫一次即完成手机号/短信步进验证。这个门无法靠改
     * header / cookie / 方言绕过（对照参考实现发同样的请求同样撞门），所以
     * 客户端能做的就是把这唯一一条出路摆到用户面前。
     *
     * @param {object} verify  -462 带回的验证参数
     * @param {Function} [retry] 验证完成后重试的动作（再点一次关注 / 再登录一次）
     * @param {string} [tip] 没有 blockText 时显示的说明（登录与关注的说法不一样）
     * @param {object} [opts] `allowQrLogin: true` 时多给一个「改用扫码登录」的出口
     */
    openVerify(verify, retry, tip, opts = {}) {
      this._verify = (verify && verify.verifyToken) ? verify : null;
      this._verifyRetry = retry || null;
      this._verifyAllowQrLogin = !!opts.allowQrLogin;
      $('#verifyQrLogin').hidden = !this._verifyAllowQrLogin;
      $('#verifyQrMask').hidden = false;
      $('#verifyQrMaskText').textContent = '二维码加载中…';
      $('#verifyQrCanvas').hidden = true;
      $('#verifyQrImg').hidden = true;
      const tipEl = $('#verifyTip');
      // 以前这里在 `!verify.verifyToken` 时直接 return —— 弹窗压根不出来，而调用方
      // 已经先写了「需要安全验证：扫码…」的提示，用户面对的就是一个不存在的二维码。
      // 没有参数是「换一张二维码」也换不出来的，只能把原因说清楚并给出别的路。
      if (!this._verify) {
        tipEl.textContent = '这次服务端没带回安全验证参数（常见于当前网络环境被判为有风险）。'
          + '可以直接关掉这个窗，改用「扫码登录」，或过一会儿再试。';
        $('#verifyQrMaskText').textContent = '没有拿到验证二维码';
        $('#verifyRefresh').hidden = true;
      } else {
        $('#verifyRefresh').hidden = false;
        tipEl.textContent = verify.blockText
          ? verify.blockText
          : (tip || '用手机上的网易云音乐 App 扫描下方二维码，完成验证后即可继续。');
      }
      $('#verifyModal').hidden = false;
      if (this._verify) this.loadVerifyQr();
    },

    closeVerify() {
      $('#verifyModal').hidden = true;
      if (this._verifyTimer) { clearTimeout(this._verifyTimer); this._verifyTimer = null; }
      this._verify = null;
      this._verifyRetry = null;
      this._verifyAllowQrLogin = false;
      $('#verifyRefresh').hidden = false;
    },

    /**
     * 用扫码登录兜底。
     *
     * 手机号登录撞 -462 时，服务端给的验证二维码本身就是「拿官方 App 扫一下」；
     * 而扫码登录（`/login/qr/key`）不需要验证码、也不需要风控参数，是同一个账号
     * 更短的一条路。拿不到验证二维码时把它摆出来，比让用户干等有用。
     */
    switchToQrLogin() {
      // 已经换成另一种登录方式了，不要再回头重试手机号那一次（验证码是一次性的）。
      this._verifyRetry = null;
      this.closeVerify();
      this.openLogin();
      this.switchLoginTab('qr');
    },

    async loadVerifyQr() {
      if (!this._verify) return;
      if (this._verifyTimer) { clearTimeout(this._verifyTimer); this._verifyTimer = null; }
      $('#verifyQrMask').hidden = false;
      $('#verifyQrMaskText').textContent = '二维码加载中…';
      try {
        const r = await svc.riskQr(this._verify);
        if (!r.ok) throw new Error(r.message || '二维码获取失败');
        this._verifyQrCode = r.qrCode;
        this._verifyUrl = r.verifyUrl;
        // 桌面版没有可扫的「第二台设备」很常见（换手机登录时手上只有一台），
        // 所以把服务端给的 H5 验证链接也摆出来，点一下就用系统浏览器打开。
        const urlBtn = $('#verifyOpenUrl');
        if (urlBtn) {
          if (this._verifyUrl) {
            urlBtn.hidden = false;
            urlBtn.onclick = () => { if (this._verifyUrl) global.ne.openExternal(this._verifyUrl); };
          } else {
            urlBtn.hidden = true;
          }
        }
        // 优先在本地自己画：`qrCode` 就是二维码的**内容**（一条官方短链），渲染层
        // 本来就有二维码生成器（登录二维码用的就是它）。CDN 那张图带防盗链、联网
        // 环境被判风险时也可能取不到 —— 取不到时用户看到的就是「加载不出二维码」，
        // 而内容其实一直在我们手里。
        const canvas = $('#verifyQrCanvas');
        const img = $('#verifyQrImg');
        let drawn = false;
        try {
          if (r.qrCode && typeof QR !== 'undefined') {
            QR.draw(canvas, r.qrCode, { size: 180, margin: 4 });
            canvas.hidden = false;
            img.hidden = true;
            drawn = true;
          }
        } catch (e) {
          console.warn('[app] verify qr draw', e);
        }
        if (!drawn) {
          // 退路：CDN 图片，走 neimg:// 代理以避开防盗链
          img.onload = () => { $('#verifyQrMask').hidden = true; img.hidden = false; };
          img.onerror = () => {
            $('#verifyQrMaskText').textContent = this._verifyUrl
              ? '二维码图片加载失败，可点「在浏览器里打开验证页」或「刷新二维码」'
              : '二维码图片加载失败，可点「刷新二维码」重试';
          };
          img.src = global.ne.img(r.imageUrl);
        } else {
          $('#verifyQrMask').hidden = true;
        }
        this.pollVerifyQr();
      } catch (e) {
        $('#verifyQrMaskText').textContent = '二维码获取失败：' + api.explain(e)
          + (this._verifyAllowQrLogin ? '（可点下面的「改用扫码登录」）' : '');
      }
    },

    /** 轮询扫码状态，扫完自动关闭并重试刚才那次关注 */
    pollVerifyQr() {
      const tick = async () => {
        if (!this._verifyQrCode || $('#verifyModal').hidden) return;
        try {
          const r = await svc.riskQrStatus(this._verifyQrCode);
          if (r.done) {
            const retry = this._verifyRetry;
            this.closeVerify();
            U.toastOk('验证已完成');
            if (retry) await retry();
            return;
          }
        } catch (e) {
          console.warn('[app] verify poll', e);
        }
        this._verifyTimer = setTimeout(tick, 2500);
      };
      this._verifyTimer = setTimeout(tick, 2500);
    },

    bindVerifyModal() {
      for (const x of $$('#verifyModal [data-close]')) {
        x.addEventListener('click', () => this.closeVerify());
      }
      $('#verifyModal').addEventListener('mousedown', (e) => {
        if (e.target.id === 'verifyModal') this.closeVerify();
      });
      $('#verifyRefresh').addEventListener('click', () => {
        // verifyToken 是绑定那次 -462 事件的，会过期。重新走一遍关注请求既能拿到
        // 新鲜的参数，又顺带再试一次 —— 如果门已经开了，这一步就直接关注成功。
        const retry = this._verifyRetry;
        this.closeVerify();
        if (retry) retry();
      });
      $('#verifyDone').addEventListener('click', async () => {
        const retry = this._verifyRetry;
        this.closeVerify();
        if (retry) await retry();
      });
      $('#verifyQrLogin').addEventListener('click', () => this.switchToQrLogin());
    },

    bindLoginModal() {
      for (const t of $$('.login-tab')) {
        t.addEventListener('click', () => this.switchLoginTab(t.dataset.ltab));
      }
      for (const x of $$('#loginModal [data-close]')) {
        x.addEventListener('click', () => this.closeLogin());
      }
      $('#loginModal').addEventListener('mousedown', (e) => {
        if (e.target.id === 'loginModal') this.closeLogin();
      });

      $('#qrRefresh').addEventListener('click', () => this.startQrLogin());

      $('#btnSendCaptcha').addEventListener('click', async () => {
        const phone = $('#phoneInput').value.trim();
        const cc = $('#phoneCC').value;
        const err = $('#phoneErr');
        err.textContent = '';
        if (!/^\d{6,15}$/.test(phone)) { err.textContent = '请输入正确的手机号'; return; }
        const btn = $('#btnSendCaptcha');
        btn.disabled = true;
        try {
          await svc.sendCaptcha(phone, cc);
          U.toastOk('验证码已发送');
          let left = 60;
          btn.textContent = `${left}s`;
          const t = setInterval(() => {
            left--;
            if (left <= 0) { clearInterval(t); btn.disabled = false; btn.textContent = '获取验证码'; }
            else btn.textContent = `${left}s`;
          }, 1000);
        } catch (e) {
          btn.disabled = false;
          err.textContent = api.explain(e);
        }
      });

      $('#btnPhoneLogin').addEventListener('click', async () => {
        const phone = $('#phoneInput').value.trim();
        const password = $('#passwordInput').value;
        const captcha = $('#captchaInput').value.trim();
        const cc = $('#phoneCC').value;
        const err = $('#phoneErr');
        err.textContent = '';
        if (!/^\d{6,15}$/.test(phone)) { err.textContent = '请输入正确的手机号'; return; }
        if (!password && !captcha) { err.textContent = '请输入密码或短信验证码'; return; }
        const btn = $('#btnPhoneLogin');
        btn.disabled = true;
        btn.textContent = '登录中…';
        try {
          const r = captcha
            ? await svc.loginCaptcha(phone, captcha, cc)
            : await svc.loginPhone(phone, password, cc);
          if (r && r.needVerify) {
            // -462：网易云要求先做账号级安全验证（换设备登录、短信验证码登录最常见）。
            // 桌面端对「关注」早就会弹二维码，登录这条路原来只丢一句
            // api.explain 出来的「需要先完成手机号或短信验证」，用户不知道该去哪儿验证。
            this.openVerify(r.verify, () => $('#btnPhoneLogin').click(),
              '网易云要求先确认是本人登录（换设备、短信验证码登录时常见）。用手机上的网易云音乐 App 扫码，或点弹窗里的验证链接，完成后会自动重试登录。',
              { allowQrLogin: true });
            err.textContent = '需要安全验证：扫码或点验证链接完成，然后会自动重试登录；拿不到二维码就点弹窗里的「改用扫码登录」。';
            return;
          }
          await this.afterLoginSuccess();
        } catch (e) {
          err.textContent = api.explain(e);
        } finally {
          btn.disabled = false;
          btn.textContent = '登录';
        }
      });

      $('#btnCookieLogin').addEventListener('click', async () => {
        const raw = $('#cookieInput').value.trim();
        const err = $('#cookieErr');
        err.textContent = '';
        if (!raw) { err.textContent = '请粘贴 Cookie'; return; }
        const btn = $('#btnCookieLogin');
        btn.disabled = true;
        btn.textContent = '验证中…';
        try {
          const st = await global.ne.auth.setCookie(raw);
          if (!st.loggedIn) {
            throw new Error('Cookie 无效或已过期。请确认其中包含有效的 MUSIC_U（该字段是 HttpOnly，'
              + '需从浏览器开发者工具的「网络 → 请求标头 → Cookie」中复制，document.cookie 读不到）');
          }
          await this.applyAuth(st);
          U.toastOk('登录成功');
          this.closeLogin();
          this.go('daily');
        } catch (e) {
          err.textContent = api.explain(e);
        } finally {
          btn.disabled = false;
          btn.textContent = '使用 Cookie 登录';
        }
      });
    },

    switchLoginTab(name) {
      for (const t of $$('.login-tab')) t.classList.toggle('active', t.dataset.ltab === name);
      $('#paneQr').hidden = name !== 'qr';
      $('#panePhone').hidden = name !== 'phone';
      $('#paneCookie').hidden = name !== 'cookie';
      if (name === 'qr') this.startQrLogin();
      else this.stopQrPoll();
    },

    // ---- 二维码登录 ----
    async startQrLogin() {
      this.stopQrPoll();
      const canvas = $('#qrCanvas');
      const mask = $('#qrMask');
      const tip = $('#qrTip');
      mask.hidden = false;
      $('#qrMaskText').textContent = '二维码加载中…';
      tip.textContent = '打开网易云音乐 App，扫描二维码登录';

      try {
        const r = await svc.qrCreate();
        this._qrKey = r.key;
        // 画布尺寸必须等于 `.qr-wrap` 的**内容盒**，不能等于它的外框（m03577 第⑧点）。
        // `.qr-wrap` 是 200×200 + padding 10（`* { box-sizing: border-box }`），内容盒只有
        // 180×180；早先这里按 200 画，`QR.draw` 又会把 canvas 的 style 宽高写成 200，
        // 于是二维码往右下各溢出 10px，看起来就是「二维码不居中」。
        QR.draw(canvas, r.url, { size: 180, margin: 4 });
        mask.hidden = true;
        this._qrExpire = Date.now() + 3 * 60 * 1000;
        this._pollQr();
      } catch (e) {
        $('#qrMaskText').textContent = '二维码获取失败：' + api.explain(e);
      }
    },

    stopQrPoll() {
      if (this._qrTimer) { clearTimeout(this._qrTimer); this._qrTimer = null; }
      this._qrKey = null;
    },

    _pollQr() {
      const tick = async () => {
        if (!this._qrKey) return;
        if (Date.now() > this._qrExpire) {
          $('#qrMask').hidden = false;
          $('#qrMaskText').textContent = '二维码已过期';
          $('#qrTip').textContent = '点击下方按钮刷新二维码';
          return;
        }
        try {
          const r = await svc.qrPoll(this._qrKey);
          if (r.code === 800) {
            $('#qrMask').hidden = false;
            $('#qrMaskText').textContent = '二维码已过期';
            return;
          }
          if (r.code === 802) {
            $('#qrMask').hidden = false;
            $('#qrMaskText').textContent = '扫描成功，请在手机上确认';
            $('#qrTip').textContent = '请在手机上点击「确认登录」';
          }
          if (r.code === 803) {
            $('#qrMask').hidden = false;
            $('#qrMaskText').textContent = '登录成功';
            this.stopQrPoll();
            await this.afterLoginSuccess();
            return;
          }
        } catch (e) {
          // 网络抖动就继续轮询
          console.warn('[app] qr poll', e);
        }
        this._qrTimer = setTimeout(tick, 1800);
      };
      this._qrTimer = setTimeout(tick, 1200);
    },

    async afterLoginSuccess() {
      this.stopQrPoll();
      const st = await global.ne.auth.state();
      await this.applyAuth(st);
      this.closeLogin();
      U.toastOk('登录成功，欢迎回来');
      this.go('daily');
    },

    // ============================================================
    //  下载（第 5 点）
    // ============================================================

    /**
     * 把若干首歌丢进下载队列。
     *
     * 真正的落盘在主进程做（渲染层沙箱里没有 fs），这里只负责挑歌、报数量和
     * 把结果如实说出来。
     *
     * 这里曾经按 `fee === 1` 过滤掉会员歌（m35069 第 3 点就是来修这个的）：
     * 那个判断假设「付费歌拿不到直链」，但账号本身是会员时，接口给的就是
     * 完整曲目 —— 于是会员用户反而下不了自己有权听的歌。现在一律交给主进程，
     * 由它按 level 逐级回退去取直链；真取不到（无版权 / 下架 / 只能试听）时
     * 由下载任务自己报出具体原因，比在这里一刀切准确。
     */
    async downloadSongs(songs) {
      const list = (songs || []).filter(Boolean);
      if (!list.length) return;
      try {
        const r = await global.ne.download.add(list);
        if (!r || !r.ok) { U.toastErr((r && r.error) || '加入下载队列失败'); return; }
        const n = r.count || 0;
        // 主进程会把「本机已经有了」「队列里已经在办」的歌挑掉（m02599 第①点：
        // 歌单多选下载时不再重复下载已存在的歌），这里如实把跳过的数量说出来，
        // 否则用户勾了 50 首只看到「32 首已加入下载」，会以为是漏了。
        const why = [];
        if (r.skippedLocal) why.push(`${r.skippedLocal} 首本地已有`);
        if (r.skippedQueued) why.push(`${r.skippedQueued} 首已在队列`);
        const tail = why.length ? `（${why.join('、')}，已跳过）` : '';
        if (r.skippedLocal) {
          // 用户 m05942 第①点要求的原文：把「去哪儿补下」说清楚，
          // 而不是只丢一句「已存在」。桌面端只要一句话，不再弹二次确认。
          U.toast(
            `有 ${r.skippedLocal} 首歌在歌单中已存在，若仍要下载，请点击顶部提示的文件夹按钮到已下载音乐中右键点击歌曲下载无损`
          );
          if (n) U.toastOk(`${n} 首已加入下载`);
          return;
        }
        if (!n) {
          if (why.length) U.toast(`这些歌都已经在本地或队列里了${tail}`);
          else U.toast('没有可加入下载的歌曲');
          return;
        }
        U.toastOk(`${n} 首已加入下载${tail}`);
        // 用户 m05942 第④点：歌单里混着无版权的歌时，事后统一说一声「几首没下成」。
        // 不在这里逐首判版权（那要多打一轮接口，还会误伤会员曲），
        // 而是等这批任务落地后按真实报错统计。
        this.watchBatchErrors(list);
      } catch (e) {
        U.toastErr('加入下载队列失败');
      }
    },

    /**
     * 盯一批刚加入队列的歌，等它们全部落地后统计「因为没版权/只有试听」失败的条数。
     *
     * 只在整批都结束（done / error / canceled）时才说话，中途暂停不算 —— 用户
     * 自己按的暂停不是「下不了」。轮询读 `store.dlTasks`（`download:list` 事件
     * 一直在维护它），不额外开监听，页面切走也不会漏。
     */
    async watchBatchErrors(songs) {
      const want = new Set((songs || []).map((s) => Number(s && s.id)).filter(Boolean));
      if (!want.size) return;
      const deadline = Date.now() + 30 * 60 * 1000;
      while (Date.now() < deadline) {
        const tasks = (this._dlTasks || []).filter((t) => want.has(Number(t.songId)));
        const live = tasks.some((t) => t.state === 'queued' || t.state === 'running');
        if (tasks.length && !live) {
          const bad = tasks.filter(
            (t) => t.state === 'error' && /无版权|下架|试听|会员|付费/.test(String(t.error || ''))
          ).length;
          if (bad) U.toast(`${bad} 首因无版权无法下载`);
          return;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    },

    /** 打开下载所在目录（队列面板里的「打开文件夹」用） */
    revealDownload(key) {
      if (global.ne.download && global.ne.download.reveal) global.ne.download.reveal(key);
    },

    // ============================================================
    //  歌单页多选（m34266 第 1 点）
    // ============================================================

    /**
     * 多选工具条上的批量操作。
     *
     * `act` 由 views.js 的 TrackList 发出：move / add / like / download / remove。
     * 每个动作做完都清掉选区并让当前页重绘 —— 歌单内容变了（移动、删除），
     * 停在旧列表上继续勾选只会让人对着已经不存在的位置点。
     */
    onTrackSelectAction(act, songs, ctx) {
      const list = (songs || []).filter(Boolean);
      if (!list.length) return;
      switch (act) {
        case 'add':
          this.openAddToPlaylist(list);
          break;
        case 'move':
          if (!store.loggedIn) { this.openLogin(); return; }
          if (!ctx.playlistId) { U.toastErr('这个歌单不能移动歌曲'); return; }
          this.openMoveToPlaylist(list, ctx.playlistId);
          break;
        case 'like':
          this.likeSongs(list);
          break;
        case 'download':
          this.downloadSongs(list);
          break;
        case 'remove':
          if (!ctx.playlistId) { U.toastErr('这个歌单不能删除歌曲'); return; }
          this.removeFromPlaylist(ctx.playlistId, list);
          break;
        default:
          break;
      }
    },

    /** 批量喜欢：逐首串行，最后只报一次总数 */
    async likeSongs(songs) {
      if (!store.loggedIn) { this.openLogin(); return; }
      const todo = songs.filter((s) => !store.likedIds.has(s.id));
      if (!todo.length) { U.toast('选中的歌曲都已经喜欢过了'); return; }
      U.toast(`正在添加 ${todo.length} 首…`);
      let ok = 0;
      for (const s of todo) {
        try {
          await this._queueLike(s.id, true);
          this._applyLike(s.id, true);
          ok++;
        } catch (e) {
          // 网易云对 like 有频控，一首失败通常意味着后面也会失败，
          // 那就别继续刷了，如实报出成功几首。
          U.toastErr(`添加了 ${ok} 首后失败：${api.explain(e)}`);
          return;
        }
      }
      api.invalidate('pl:');
      api.invalidate('liked:');
      U.toastOk(`已添加 ${ok} 首到我喜欢的音乐`);
    },

    // ============================================================
    //  添加到歌单
    // ============================================================
    _addSongs: [],
    // 'add' = 添加到（保留原歌单）；'move' = 移动（添加后从来源歌单移除）
    _addMode: 'add',
    _moveFrom: 0,

    openAddToPlaylist(songs) {
      if (!store.loggedIn) { this.openLogin(); return; }
      this._addMode = 'add';
      this._moveFrom = 0;
      this._addSongs = (songs || []).filter(Boolean);
      if (!this._addSongs.length) return;
      $('#addModalTitle').textContent = this._addSongs.length > 1
        ? `添加 ${this._addSongs.length} 首歌曲到歌单`
        : `添加「${this._addSongs[0].name}」到歌单`;
      $('#addModal').hidden = false;
      $('#newPlaylistName').value = '';
      this.renderAddList();
    },

    /** 移动：从 `fromPid` 移到选中的歌单（添加成功后再从来源移除） */
    openMoveToPlaylist(songs, fromPid) {
      this._addMode = 'move';
      this._moveFrom = Number(fromPid) || 0;
      this._addSongs = (songs || []).filter(Boolean);
      if (!this._addSongs.length) return;
      $('#addModalTitle').textContent = `移动 ${this._addSongs.length} 首歌曲到`;
      $('#addModal').hidden = false;
      $('#newPlaylistName').value = '';
      this.renderAddList();
    },

    closeAddModal() {
      $('#addModal').hidden = true;
      this._addSongs = [];
      this._addMode = 'add';
      this._moveFrom = 0;
    },

    /**
     * 一首歌有多个歌手时，让用户选一位再跳（m03577 第⑩点）。
     *
     * 之前播放条、右键菜单、小窗都是直接取 `artists[0]`：合唱曲目点下去永远
     * 只到第一位歌手，其余几位等于不存在。这里改成：一位歌手直接跳（不弹
     * 多余的窗），两位以上才弹窗让用户挑。
     */
    openArtistChoice(song) {
      const artists = ((song && song.artists) || []).filter((a) => a && a.id);
      if (!artists.length) { U.toast('这首歌没有歌手信息'); return; }
      // 用户 m15635 第①点：播放条上的歌手名点下去会弹「选择歌手」，弹窗虽然在
      // 播放页之上，但选完之后要跳歌手页 —— 那一步得先把整页播放页收起来，
      // 否则用户看到的是播放页还在、歌手页被压在底下。统一在这里收，
      // 播放页内（#npArtist）和播放条（#pbArtist）两条入口行为一致。
      if (store.nowPlayingOpen) this.toggleNowPlaying(false);
      if (artists.length === 1) {
        this.go('artist', { id: artists[0].id, name: artists[0].name || '' });
        return;
      }
      this._artistChoices = artists;
      $('#artistModalTitle').textContent = '选择歌手';
      $('#artistModal').hidden = false;
      this.renderArtistList();
    },

    closeArtistModal() {
      $('#artistModal').hidden = true;
      this._artistChoices = [];
    },

    /**
     * 先把名字渲染出来立即能点，头像再异步补 —— 头像接口要一个个发，
     * 全等齐再显示会让弹窗空白几百毫秒。
     */
    renderArtistList() {
      const box = $('#amList');
      box.innerHTML = '';
      const artists = this._artistChoices || [];
      for (const a of artists) {
        const node = U.el(`<div class="add-item" data-aid="${a.id}">
          <img src="${U.esc(global.ne.img(U.cover(a.avatar, 120)))}" alt="">
          <div class="ai-meta">
            <div class="ai-name">${U.esc(a.name || '')}</div>
            <div class="ai-count" data-role="count"></div>
          </div>
        </div>`);
        node.addEventListener('click', () => {
          this.closeArtistModal();
          this.go('artist', { id: a.id, name: a.name || '' });
        });
        box.appendChild(node);
        this.fillArtistRow(node, a);
      }
    },

    async fillArtistRow(node, a) {
      try {
        // 走 svc 而不是 ne.callSafe：svc 自带缓存（artist:ID 五分钟）与错误归一化，
        // 同一个歌手在弹窗里被点开第二次不会再发一遍请求。
        const d = await svc.artistDetail(a.id);
        if (!d) return;
        const img = node.querySelector('img');
        if (img && d.avatar) img.src = U.esc(global.ne.img(U.cover(d.avatar, 120)));
        const meta = node.querySelector('[data-role="count"]');
        if (meta && d.musicSize) meta.textContent = `${d.musicSize} 首作品`;
      } catch (e) {
        // 头像和作品数都是锦上添花，取不到就只留名字。
      }
    },

    renderAddList() {
      const box = $('#addList');
      box.innerHTML = '';
      const move = this._addMode === 'move';
      // 添加模式：我创建的歌单 + 收藏的歌单 + 我喜欢的音乐（都能往里加）。
      // 移动模式：只有「我创建的歌单」—— 收藏的歌单是别人的，往里加歌本就不合
      // 规矩；而来源歌单自己出现在列表里毫无意义（移到自己身上等于什么都没做）。
      const items = store.playlists.filter((p) => (move
        ? !p.subscribed && p.specialType !== 5 && Number(p.id) !== this._moveFrom
        : (!p.subscribed || p.specialType === 5)));

      // 我喜欢的音乐放最上面（仅添加模式）
      const liked = move ? null : items.find((p) => p.specialType === 5);
      const others = items.filter((p) => p.specialType !== 5);
      const ordered = liked ? [liked, ...others] : others;

      if (!ordered.length) {
        box.innerHTML = move
          ? '<div class="side-hint" style="padding:14px">没有别的歌单可以移动过去，先在下面新建一个吧</div>'
          : '<div class="side-hint" style="padding:14px">还没有可用的歌单，在下面新建一个吧</div>';
        return;
      }

      for (const p of ordered) {
        const isLiked = p.specialType === 5;
        const node = U.el(`<div class="add-item" data-pid="${p.id}">
          <div class="add-cover">
            ${isLiked
              ? '<div class="add-liked"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 21s-8-5.1-8-11a4.6 4.6 0 018-3.1A4.6 4.6 0 0120 10c0 5.9-8 11-8 11z"/></svg></div>'
              : `<img src="${U.esc(global.ne.img(U.cover(p.cover, 100)))}" alt="">`}
          </div>
          <div class="add-meta">
            <div class="add-name">${U.esc(p.name)}</div>
            <div class="add-count">${p.trackCount || 0} 首</div>
          </div>
        </div>`);
        node.addEventListener('click', () => this.doAdd(p));
        box.appendChild(node);
      }
    },

    async doAdd(p) {
      const ids = this._addSongs.map((s) => s.id);
      const move = this._addMode === 'move';
      const from = this._moveFrom;
      if (move && Number(p.id) === from) { U.toastErr('来源歌单和目标歌单是同一个'); return; }
      try {
        if (p.specialType === 5) {
          // 我喜欢的音乐：逐首 like
          for (const id of ids) {
            if (store.likedIds.has(id)) continue;
            await svc.like(id, true);
            store.likedIds.add(id);
            store.emit('like:changed', { id, liked: true });
          }
          U.toastOk('已添加到我喜欢的音乐');
        } else {
          await svc.playlistAdd(p.id, ids);
          // 移动：加过去成功之后才从来源删除。反过来的话，一旦添加失败，
          // 歌就凭空消失在两个歌单之间了。
          if (move && from) {
            await svc.playlistRemove(from, ids);
            U.toastOk(`已移动 ${ids.length} 首到「${p.name}」`);
          } else {
            U.toastOk(`已添加到「${p.name}」`);
          }
        }
        this.syncLikeUI();
        api.invalidate('pl:');
        api.invalidate('pltracks:');
        // m38831 第④点：加完歌必须把侧栏歌单的曲目数刷新一遍。
        //
        // 侧栏那一列数字来自 `store.playlists`，它只在 `loadLibrary()` 里被服务端
        // 数据覆盖。上面两句 invalidate 只是把缓存清了，没人重新去拉 —— 于是歌单
        // 里明明多了歌，左边的数字还停在旧值上，直到下次重启或手动重新登录才变。
        // 直接补一次 loadLibrary()：它顺手也会重画侧栏（歌单名、封面、计数一起刷新）。
        // 上面那两句 invalidate 清不到 `playlists:<uid>`（前缀是 `playlists:`，不是
        // `pl:`），而 loadLibrary 正是走这条路取数的 —— 不清就会拿到 30 秒内的旧
        // 列表，计数照样不动。所以这里补一句。
        api.invalidate('playlists:');
        await this.loadLibrary();
        const here = store.route?.name === 'playlist' ? Number(store.route.params?.id) : 0;
        this.closeAddModal();
        // 来源或目标正好是当前页，都得重绘：一个是少了几首，一个是多了几首
        if (here && (here === Number(p.id) || (move && here === from))) this.reload();
      } catch (e) {
        U.toastErr(api.explain(e));
      }
    },

    bindArtistModal() {
      for (const x of $$('#artistModal [data-close]')) {
        x.addEventListener('click', () => this.closeArtistModal());
      }
      $('#artistModal').addEventListener('mousedown', (e) => {
        if (e.target.id === 'artistModal') this.closeArtistModal();
      });
    },

    bindAddModal() {
      for (const x of $$('#addModal [data-close]')) {
        x.addEventListener('click', () => this.closeAddModal());
      }
      $('#addModal').addEventListener('mousedown', (e) => {
        if (e.target.id === 'addModal') this.closeAddModal();
      });
      $('#btnNewPlaylist').addEventListener('click', async () => {
        const name = $('#newPlaylistName').value.trim();
        if (!name) { U.toast('请输入歌单名称'); return; }
        try {
          const r = await svc.playlistCreate(name);
          await this.loadLibrary();
          const created = (r && r.playlist) || store.playlists.find((p) => p.name === name);
          if (!created) { U.toastErr('创建成功但未找到歌单'); return; }
          await this.doAdd(created);
        } catch (e) { U.toastErr(api.explain(e)); }
      });
    },

    // ============================================================
    //  从歌单移除
    // ============================================================
    /**
     * 从歌单里移除歌曲。`songs` 可以是单首，也可以是多选出来的一批
     * （m34266 第 1 点）—— 批量时只弹一次确认，逐首确认会点到手酸。
     */
    async removeFromPlaylist(pid, songs) {
      const list = (Array.isArray(songs) ? songs : [songs]).filter(Boolean);
      if (!list.length) return;
      const ask = list.length > 1
        ? `从歌单中删除这 ${list.length} 首歌曲？`
        : `从歌单中删除「${list[0].name}」？`;
      if (!confirm(ask)) return;
      try {
        await svc.playlistRemove(pid, list.map((s) => s.id));
        U.toastOk(list.length > 1 ? `已从歌单删除 ${list.length} 首` : '已从歌单删除');
        api.invalidate('pl:');
        api.invalidate('pltracks:');
        // 第④点是「加歌之后侧栏数字不动」，删歌是同一个毛病（store.playlists 里
        // 的 trackCount 没人去更新），一起修掉。
        api.invalidate('playlists:');
        await this.loadLibrary();
        if (store.route?.name === 'playlist' && Number(store.route.params?.id) === Number(pid)) this.reload();
      } catch (e) { U.toastErr(api.explain(e)); }
    },

    // ============================================================
    //  鼠标侧键（第 8 点）
    // ============================================================

    /**
     * 把鼠标侧键接到前进 / 后退上。
     *
     * 侧键在浏览器里对应 `button === 3`（后退）和 `4`（前进），只在 `mousedown`
     * / `mouseup` 里出现 —— `click` 只报左中右三档。用 `mousedown` 而不是
     * `auxclick`：后者在部分 Chromium 版本上对侧键不触发。
     *
     * 只判断键位、不 preventDefault 会有一个副作用：Chromium 自己可能把侧键
     * 当成「历史前进/后退」，与我们的路由叠在一起。这里 `preventDefault()`
     * 掉，把行为完全握在自己手里。
     */
    bindMouseButtons() {
      document.addEventListener('mousedown', (e) => {
        if (e.button !== 3 && e.button !== 4) return;
        // 输入框里不该触发导航
        const tag = (e.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
        e.preventDefault();
        if (e.button === 3) this.back();
        else this.forward();
      });
    },

    // ============================================================
    //  快捷键
    // ============================================================
    bindKeyboard() {
      document.addEventListener('keydown', (e) => {
        const tag = (e.target.tagName || '').toLowerCase();
        const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;

        if (e.ctrlKey && e.key.toLowerCase() === 'f') {
          e.preventDefault();
          $('#searchInput').focus();
          $('#searchInput').select();
          return;
        }
        if (typing) return;

        switch (e.key) {
          case ' ':
            e.preventDefault();
            player.toggle();
            break;
          case 'ArrowRight':
            if (e.ctrlKey) { e.preventDefault(); player.next(); }
            else if (e.shiftKey) { e.preventDefault(); player.next(); }
            else { player.seek(player.position + 5000); }
            break;
          case 'ArrowLeft':
            if (e.ctrlKey || e.shiftKey) { e.preventDefault(); player.prev(); }
            else { player.seek(player.position - 5000); }
            break;
          case 'ArrowUp':
            e.preventDefault();
            store.volume = Math.min(1, store.volume + 0.05);
            player.setVolume(store.volume);
            this.updateVolumeUI();
            this.saveConfig({ volume: store.volume });
            break;
          case 'ArrowDown':
            e.preventDefault();
            store.volume = Math.max(0, store.volume - 0.05);
            player.setVolume(store.volume);
            this.updateVolumeUI();
            this.saveConfig({ volume: store.volume });
            break;
          case 'Escape':
            if (store.queueOpen) this.toggleQueue(false);
            else if (store.nowPlayingOpen) this.toggleNowPlaying(false);
            break;
          case 'l': case 'L':
            this.toggleNowPlaying();
            break;
          case 'q': case 'Q':
            this.toggleQueue();
            break;
          case 'F12':
            global.ne.window.control('toggleDevTools');
            break;
        }
      });
    },

    // ============================================================
    //  store 事件
    // ============================================================
    bindStoreEvents() {
      store.on('player:track', (song) => {
        this.syncTrackUI(song);
        // 刷新列表里的高亮
        for (const fn of this._trackRefreshers || []) fn(song);
        const el = $('#mainScroll');
        for (const row of el.querySelectorAll('.tl-row.playing')) row.classList.remove('playing');
        if (song) {
          for (const row of el.querySelectorAll('.tl-row')) {
            if (Number(row.dataset.id) === song.id) row.classList.add('playing');
          }
        }
        if (store.queueOpen) this.renderQueue();
      });

      store.on('player:state', (s) => {
        this.syncPlayUI(s);
      });

      store.on('player:time', ({ current, duration }) => {
        const d = duration || player.duration;
        if (d > 0) {
          const r = current / d;
          $('#pbTrackFill').style.width = (r * 100) + '%';
          $('#pbTrackKnob').style.left = (r * 100) + '%';
          $('#pbDur').textContent = U.fmtTime(d);
        }
        $('#pbCur').textContent = U.fmtTime(current);
        this.lyricView.update(current);
      });

      store.on('player:duration', ({ duration }) => {
        $('#pbDur').textContent = U.fmtTime(duration);
      });

      store.on('player:queue', () => {
        this.renderQueue();
      });

      store.on('player:repeat', () => this.syncRepeatUI());

      store.on('like:changed', ({ id, liked }) => {
        const el = $('#mainScroll');
        for (const row of el.querySelectorAll('.tl-row')) {
          if (Number(row.dataset.id) !== id) continue;
          const btn = row.querySelector('.tl-like');
          if (!btn) continue;
          btn.classList.toggle('on', liked);
          btn.innerHTML = icons(liked ? ICON.heart : ICON.heartOutline, 13);
        }
        this.syncLikeUI();
        // Keep the sidebar badge in step with the heart, both ways: it used to
        // only ever increment, so un-hearting left the count too high.
        if (store.liked) {
          const n = Number($('#likedCount').textContent || 0);
          $('#likedCount').textContent = Math.max(0, n + (liked ? 1 : -1));
        }
      });

      store.on('liked:loaded', () => {
        const el = $('#mainScroll');
        for (const row of el.querySelectorAll('.tl-row')) {
          const btn = row.querySelector('.tl-like');
          if (!btn) continue;
          const liked = store.likedIds.has(Number(row.dataset.id));
          btn.classList.toggle('on', liked);
          btn.innerHTML = icons(liked ? ICON.heart : ICON.heartOutline, 13);
        }
        this.syncLikeUI();
      });

      store.on('auth:changed', () => {
        $('#likedCount').textContent = store.liked ? store.liked.trackCount : '';
      });

      // 全局 error 兜底
      window.addEventListener('error', (e) => {
        console.error('[renderer] error', e.error || e.message);
      });
      window.addEventListener('unhandledrejection', (e) => {
        console.error('[renderer] unhandled rejection', e.reason);
      });
    },
  };

  global.App = App;
  window.addEventListener('DOMContentLoaded', () => {
    App.init().catch((e) => {
      console.error('[app] init failed', e);
      document.body.innerHTML = `<div style="padding:40px;color:#eee;font-family:sans-serif">
        <h2>启动失败</h2><pre>${U.esc(e && e.stack || String(e))}</pre></div>`;
    });
  });
})(window);
