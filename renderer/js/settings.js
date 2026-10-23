'use strict';
/**
 * 设置（第 4 点）
 *
 * 四页：播放 / 外观 / 侧边栏 / 关于。每一页是一组 `.set-row`，行里的控件只做
 * 两件事——写进 `Settings.values` 再 `App.saveConfig({ settings })`。所有开关
 * 的"生效"都在 `apply()` 里通过给 <body> 加类名完成，CSS 负责具体表现，这样
 * 设置项和样式表之间没有来回调用。
 *
 * 侧边栏个性化（第 4 点后半段）单独存 `config.sideHidden`，是一组 data-side 键名。
 */
(function (global) {
  const DEFAULTS = {
    autoCheckin: true,      // 启动时自动签到
    autoSkip: true,         // 播放失败自动跳下一首
    listCover: true,        // 歌曲列表标题前显示封面（第 1 点）
    sideCover: true,        // 左侧栏歌单显示首曲封面（第 3 点）
    commentBadge: true,     // 底栏评论按钮上的数量角标
    animations: true,       // 界面动效
    miniOnTop: true,        // 悬浮小窗始终置顶
    // 第 6 点新增的三项
    fade: true,             // 音乐淡出淡入（切歌 / 暂停时做短斜坡，避免爆音）
    // 启动时接着上次的进度继续。m38831 第③点把它从 false 翻成 true：
    // 「重启后接着听」是播放器的常识行为，藏在设置里等于默认没有这个功能 ——
    // 用户遇到的表现就是「进度条永远从开头开始」。不想接续的人可以自己关掉。
    rememberProgress: true,
    cacheMax: 1024,         // 缓存上限（MB），超过就清一次；0 = 不限制
    // m34266 第 2 点：启动后打开哪一页。'last' 是特殊值，表示回到上次离开的页面
    startPage: 'radio',
  };

  /**
   * 「启动时打开的页面」候选。
   *
   * 只列侧栏里那些真正可以当首页的页面：带上 id / 歌单的页面（用户主页、
   * 歌单详情）没法在启动时凭空打开，所以不进这张表。'last' 是特殊项，
   * 由 App 读 config.lastRoute 决定具体去哪。
   */
  const START_PAGES = [
    { key: 'radio', label: '推荐歌单' },
    { key: 'daily', label: '每日推荐' },
    { key: 'charts', label: '榜单' },
    { key: 'podcast', label: '播客' },
    { key: 'liked', label: '我喜欢的音乐' },
    { key: 'recent', label: '最近播放' },
    { key: 'downloads', label: '已下载音乐' },
    { key: 'last', label: '上次离开时的页面' },
  ];

  // 左侧栏可自定义的条目。key 对应 index.html 里的 data-side（own / sub 是分组）。
  const SIDE_ITEMS = [
    { key: 'daily', label: '每日推荐', icon: 'chart' },
    { key: 'radio', label: '推荐歌单', icon: 'radio' },
    { key: 'charts', label: '榜单', icon: 'chart' },
    { key: 'podcast', label: '播客', icon: 'podcast' },
    // 音乐云盘（m05071 第④点）跟着播客走：侧栏里它就在播客下面。
    { key: 'cloud', label: '音乐云盘', icon: 'download' },
    { key: 'liked', label: '我喜欢的音乐', icon: 'heart' },
    { key: 'recent', label: '最近播放', icon: 'album' },
    // 「正在下载」与「已下载音乐」是一对（m02003 第①点把前者挪到后者上面）：
    // 侧边栏个性化里必须两条都在，否则用户能藏掉下面那条、上面那条却永远留着。
    { key: 'downloading', label: '正在下载', icon: 'download' },
    { key: 'downloads', label: '已下载音乐', icon: 'download' },
    { key: 'own', label: '创建的歌单', icon: 'add' },
    { key: 'sub', label: '收藏的歌单', icon: 'layers' },
  ];

  const PAGES = [
    { id: 'play', label: '播放', icon: 'play' },
    { id: 'download', label: '下载', icon: 'download' },
    { id: 'look', label: '外观', icon: 'palette' },
    { id: 'side', label: '侧边栏', icon: 'layers' },
    { id: 'about', label: '关于', icon: 'info' },
  ];

  const Settings = {
    DEFAULTS,
    SIDE_ITEMS,
    PAGES,
    START_PAGES,
    values: { ...DEFAULTS },
    sideHidden: new Set(),
    page: 'play',
    _modal: null,
    // 缓存目录由主进程持有（Chromium 必须在 app ready 之前就定好它），
    // 这里只缓存一份显示用的字符串，设置页打开时异步取一次。
    cachePath: '',
    cacheCustom: false,
    // 当前缓存实际占用（字节），由主进程算，用来显示在「缓存最大大小」旁边
    cacheBytes: 0,
    // 下载设置（第 5 点）。主进程才是权威，这里只是渲染用的副本。
    dl: { dir: '', effectiveDir: '', quality: 'exhigh', organize: 'none', template: '{歌手名} - {歌曲名}' },

    get(key) {
      const v = this.values[key];
      return v === undefined ? DEFAULTS[key] : v;
    },

    /** 读一次当前生效的缓存目录，写进 #setCacheDir（设置页可能还没渲染出来） */
    async loadCache() {
      try {
        const r = await global.ne.cache.get();
        this.cachePath = r.dir || '';
        this.cacheCustom = !!r.custom;
      } catch { /* 主进程还没就绪时保持原值 */ }
      this.syncCacheRow();
      // 占用大小要递归扫盘，慢，所以不阻塞上面那条
      this.loadCacheSize();
    },

    /** 扫一次缓存目录算占用（第 6 点）。 */
    async loadCacheSize() {
      try {
        const r = await global.ne.cache.size();
        this.cacheBytes = (r && r.bytes) || 0;
      } catch { /* 算不出来就显示"—" */ }
      this.syncCacheSizeRow();
    },

    syncCacheSizeRow() {
      if (!this._modal) return;
      const el = this._modal.querySelector('#setCacheSize');
      if (el) el.textContent = this.cacheBytes ? global.U.fmtSize(this.cacheBytes) : '0 B';
    },

    /** 读一次下载设置（第 5 点）。主进程是权威。 */
    async loadDownload() {
      try {
        const r = await global.ne.download.settings();
        if (r) this.dl = { ...this.dl, ...r };
      } catch { /* 主进程还没就绪 */ }
      this.syncDownloadRow();
    },

    syncDownloadRow() {
      if (!this._modal) return;
      const code = this._modal.querySelector('#setDlDir');
      if (code) {
        const txt = this.dl.effectiveDir || '读取中…';
        code.textContent = txt;
        code.title = txt;
      }
      const reset = this._modal.querySelector('#setDlDirReset');
      if (reset) reset.hidden = !this.dl.custom;
      this.syncDownloadInputs();
    },

    /**
     * 把主进程的下载设置回填到输入框。
     *
     * 为什么不能只靠 render()：render() 用的是内存里的 this.dl，而 open() 的顺序是
     * 「先 render() 再 loadDownload()」—— 渲染时手上那份还是上一次的值。
     * 主进程又有归一化（空白模板会被改回默认值），所以用户清空输入框之后
     * 内存值与真实值会分叉，输入框就会显示一个并不生效的旧值。
     * 这里以主进程为权威回填，但正在打字的那个框不碰（别把光标抢走）。
     */
    syncDownloadInputs() {
      if (!this._modal) return;
      const tpl = this._modal.querySelector('[data-dlkey="template"]');
      const want = this.dl.template || '{歌手名} - {歌曲名}';
      if (tpl && document.activeElement !== tpl && tpl.value !== want) tpl.value = want;
    },

    syncCacheRow() {
      if (!this._modal) return;
      const code = this._modal.querySelector('#setCacheDir');
      if (code) {
        const txt = this.cachePath || '读取中…';
        code.textContent = txt;
        code.title = txt;
      }
      const reset = this._modal.querySelector('#setCacheReset');
      if (reset) reset.hidden = !this.cacheCustom;
    },

    // ---------------------------------------------------------- 生效
    /**
     * 把设置反映到界面上。只碰类名和 hidden，不重建 DOM，所以可以随便重复调用。
     */
    apply() {
      const b = document.body;
      if (!b) return;
      b.classList.toggle('no-anim', !this.get('animations'));
      b.classList.toggle('no-list-cover', !this.get('listCover'));
      b.classList.toggle('no-side-cover', !this.get('sideCover'));
      b.classList.toggle('no-badge', !this.get('commentBadge'));
      this.applySidebar();
    },

    /** 侧边栏个性化：隐藏没勾的条目，并顺手收掉整组都空了的组标题 */
    applySidebar() {
      for (const it of SIDE_ITEMS) {
        const on = !this.sideHidden.has(it.key);
        if (it.key === 'own' || it.key === 'sub') {
          const group = document.getElementById(it.key === 'own' ? 'ownGroup' : 'subGroup');
          const list = document.getElementById(it.key === 'own' ? 'ownPlaylists' : 'subPlaylists');
          if (group) group.hidden = !on;
          if (list) list.hidden = !on;
        } else {
          for (const el of document.querySelectorAll(`.side-item[data-side="${it.key}"]`)) {
            el.hidden = !on;
          }
        }
      }
      // 「在线音乐」组：daily/radio/charts/podcast 全关时整组标题也没意义了
      const online = ['daily', 'radio', 'charts', 'podcast'];
      // 「我的音乐」组现在有三条（liked / recent / downloads），原来只列了两条，
      // 关掉 liked 与 recent 之后 downloads 还亮着、组标题却先收了。
      const mine = ['liked', 'recent', 'downloads'];
      const head = document.querySelectorAll('.side-nav .side-group');
      if (head[0]) head[0].hidden = online.every((k) => this.sideHidden.has(k));
      if (head[1]) head[1].hidden = mine.every((k) => this.sideHidden.has(k));
    },

    async save() {
      await global.App.saveConfig({ settings: { ...this.values }, sideHidden: [...this.sideHidden] });
    },

    // ---------------------------------------------------------- 弹窗
    bind(modal) {
      this._modal = modal;
      for (const x of modal.querySelectorAll('[data-close]')) {
        x.addEventListener('click', () => this.close());
      }
      modal.addEventListener('mousedown', (e) => {
        if (e.target === modal) this.close();
      });
      // 页签与行内控件都用事件委托，重渲染后不用重新绑
      modal.querySelector('#setTabs').addEventListener('click', (e) => {
        const tab = e.target.closest('.set-tab');
        if (!tab) return;
        this.showPage(tab.dataset.setpage);
      });
      modal.querySelector('#setPanes').addEventListener('click', (e) => {
        // 顺序要紧：侧边栏那一排的开关同时带 .set-switch 和 .set-side-toggle，
        // 先判 .set-switch 会把 key 当成普通设置项写进 settings（历史 bug）。
        const side = e.target.closest('.set-side-toggle');
        if (side) { this.toggleSide(side.dataset.key); return; }
        const sw = e.target.closest('.set-switch');
        if (sw) { this.toggle(sw.dataset.key); return; }
        const link = e.target.closest('[data-act]');
        if (link) this.act(link.dataset.act);
      });
      modal.querySelector('#setPanes').addEventListener('change', (e) => {
        // 下载页的控件走 data-dlkey（写主进程的 config.download），
        // 其余走 data-key（写本地的 Settings.values）—— 两套不能混。
        const dl = e.target.closest('[data-dlkey]');
        if (dl) { this.setDownload(dl.dataset.dlkey, dl.value); return; }
        const sel = e.target.closest('.set-select[data-key]');
        if (sel) { this.setValue(sel.dataset.key, sel.value); return; }
        const rng = e.target.closest('.set-range[data-key]');
        if (rng) { this.setValue(rng.dataset.key, Number(rng.value) / 100); return; }
        const num = e.target.closest('.set-num[data-key]');
        if (num) { this.setValue(num.dataset.key, Number(num.value) || 0); return; }
      });
      modal.querySelector('#setPanes').addEventListener('input', (e) => {
        const rng = e.target.closest('.set-range[data-key]');
        if (rng) this.previewValue(rng.dataset.key, Number(rng.value) / 100);
      });
      // 缓存目录只有主进程知道，绑定时先拉一次，免得第一次打开设置页是空的
      this.loadCache();
      this.loadDownload();
    },

    open(page) {
      if (!this._modal) return;
      this.render();
      this.showPage(page || this.page);
      this._modal.hidden = false;
      // 渲染用的是缓存值，进页面时再拉一次，防止用户在别处改过
      this.loadCache();
      this.loadDownload();
    },

    close() {
      if (this._modal) this._modal.hidden = true;
    },

    get isOpen() { return !!this._modal && !this._modal.hidden; },

    showPage(id) {
      this.page = id;
      for (const t of this._modal.querySelectorAll('.set-tab')) {
        t.classList.toggle('on', t.dataset.setpage === id);
      }
      for (const p of this._modal.querySelectorAll('.set-page')) {
        p.hidden = p.dataset.setpage !== id;
      }
    },

    toggle(key) {
      this.setValue(key, !this.get(key));
    },

    setValue(key, val) {
      this.values[key] = val;
      // 少数几项不能只存值，还要立刻作用到正在播放的东西上
      if (key === 'quality') { global.App.setQuality(val); return; }
      if (key === 'volume') {
        global.store.volume = val;
        global.store.muted = false;
        global.player.setVolume(val);
        global.player.setMuted(false);
        global.App.updateVolumeUI();
      }
      this.apply();
      this.save();
      // 只重绘控件状态，不整页重渲染，避免开关点一下闪一下
      this.syncControls();
    },

    previewValue(key, val) {
      // 拖动音量时先实时生效，松手（change）才落盘
      if (key === 'volume') {
        this.values.volume = val;
        global.store.volume = val;
        global.player.setVolume(val);
        global.App.updateVolumeUI();
      }
    },

    toggleSide(key) {
      if (this.sideHidden.has(key)) this.sideHidden.delete(key);
      else this.sideHidden.add(key);
      this.apply();
      this.save();
      this.syncControls();
    },

    /**
     * 写一项下载设置（第 5 点）。值由主进程校验后回传，这里拿回显结果覆盖副本，
     * 所以脏值（比如空的命名模板）会当场被纠正成默认值，而不是留在界面上骗人。
     */
    async setDownload(key, val) {
      // 先把值记到本地副本上，再去问主进程。主进程有归一化（空模板落回默认值），
      // 回来的那份才是权威，但**不能**让它在往返期间被别的 setDownload 覆盖 ——
      // 历史 bug：改完模板立刻去点音质，音质那次 render() 用的是还没回填的旧模板，
      // 重建出来的输入框又把用户刚打的字显示回旧值（m03577 第⑦点「只能删不能加」）。
      this.dl = { ...this.dl, [key]: val };
      // 串行化：两次写并发时后发先至会让 this.dl 退回到更旧的一份
      const run = async () => {
        try {
          const r = await global.ne.download.set({ [key]: val });
          if (r && r.settings) this.dl = { ...this.dl, ...r.settings };
        } catch (e) {
          global.U.toastErr('保存失败：' + (e && e.message ? e.message : e));
        }
        // 模板是文本框，用户还在打字，重渲染会把光标顶掉；只有下拉才需要同步
        if (key !== 'template') this.render();
        this.syncDownloadRow();
      };
      this._dlChain = (this._dlChain || Promise.resolve()).then(run, run);
      return this._dlChain;
    },

    act(name) {
      if (name === 'devtools') global.ne.window.control('toggleDevTools');
      if (name === 'repo') global.ne.openExternal('https://github.com/Airisey/netease-lite');
      if (name === 'repo-android') global.ne.openExternal('https://github.com/Airisey/netease-lite-android');
      if (name === 'cacheDir') this.pickCacheDir();
      if (name === 'cacheReset') this.resetCacheDir();
      if (name === 'refresh') this.refreshApp();
      if (name === 'dlDir') this.pickDlDir();
      if (name === 'dlDirReset') this.resetDlDir();
      if (name === 'reset') {
        if (!confirm('恢复全部默认设置？（不会影响登录状态与歌单）')) return;
        this.values = { ...DEFAULTS };
        this.sideHidden = new Set();
        this.apply();
        this.save();
        this.render();
        global.U.toastOk('已恢复默认设置');
      }
    },

    /**
     * 换缓存目录。目录由主进程挑（只有它能开系统对话框），并且必须重启才真正
     * 生效 —— Chromium 的磁盘缓存路径只能在 app ready 之前定，`app.setPath`
     * 事后调用不会把已经建好的缓存搬过去。所以这里改完提示一句"重启后生效"，
     * 不骗用户说立刻就好了。
     */
    async pickCacheDir() {
      try {
        const r = await global.ne.cache.choose();
        if (!r || r.canceled) return;
        if (!r.ok) { global.U.toastErr(r.error || '目录不可用'); return; }
        this.cachePath = r.dir || '';
        this.cacheCustom = true;
        this.syncCacheRow();
        global.U.toastOk('缓存目录已切换，重启后生效');
      } catch (e) {
        global.U.toastErr('切换失败：' + (e && e.message ? e.message : e));
      }
    },

    async resetCacheDir() {
      try {
        const r = await global.ne.cache.reset();
        this.cachePath = (r && r.dir) || '';
        this.cacheCustom = false;
        this.syncCacheRow();
        global.U.toastOk('已恢复默认缓存目录，重启后生效');
      } catch (e) {
        global.U.toastErr('恢复失败：' + (e && e.message ? e.message : e));
      }
    },

    /**
     * 刷新：清缓存 + 重启（主进程做，这里只负责确认）。
     * 重启是 app.relaunch()，所以调用之后这个窗口马上就会没，别再往下写后续逻辑。
     */
    async refreshApp() {
      if (!confirm('清空所有缓存并重新启动？\n\n登录状态、歌单和设置都会保留。')) return;
      global.U.toastOk('正在清空缓存并重启…');
      try {
        await global.ne.cache.refresh();
      } catch (e) {
        global.U.toastErr('刷新失败：' + (e && e.message ? e.message : e));
      }
    },

    /** 换下载目录（第 5 点）。跟缓存目录不同，下载改完立刻生效，不用重启。 */
    async pickDlDir() {
      try {
        const r = await global.ne.download.chooseDir();
        if (!r || r.canceled) return;
        if (!r.ok) { global.U.toastErr(r.error || '目录不可用'); return; }
        this.dl.dir = r.dir || '';
        this.dl.effectiveDir = r.effectiveDir || r.dir || '';
        this.dl.custom = true;
        this.syncDownloadRow();
        global.U.toastOk('下载目录已切换');
      } catch (e) {
        global.U.toastErr('切换失败：' + (e && e.message ? e.message : e));
      }
    },

    async resetDlDir() {
      try {
        const r = await global.ne.download.resetDir();
        this.dl.dir = '';
        this.dl.effectiveDir = (r && r.dir) || '';
        this.dl.custom = false;
        this.syncDownloadRow();
        global.U.toastOk('已恢复默认下载目录');
      } catch (e) {
        global.U.toastErr('恢复失败：' + (e && e.message ? e.message : e));
      }
    },

    /** 只同步已有控件的开/关，不重建 DOM */
    syncControls() {
      if (!this._modal) return;
      for (const sw of this._modal.querySelectorAll('.set-switch[data-key]')) {
        sw.classList.toggle('on', !!this.get(sw.dataset.key));
        sw.setAttribute('aria-checked', String(!!this.get(sw.dataset.key)));
      }
      for (const row of this._modal.querySelectorAll('.set-side-item')) {
        const on = !this.sideHidden.has(row.dataset.key);
        row.classList.toggle('off', !on);
        const sw = row.querySelector('.set-switch');
        if (sw) { sw.classList.toggle('on', on); sw.setAttribute('aria-checked', String(on)); }
      }
    },

    // ---------------------------------------------------------- 渲染
    render() {
      if (!this._modal) return;
      const tabs = this._modal.querySelector('#setTabs');
      const panes = this._modal.querySelector('#setPanes');
      tabs.innerHTML = PAGES.map((p) => `
        <button class="set-tab" data-setpage="${p.id}">
          ${global.icons(global.ICON[p.icon], 15)}<span>${p.label}</span>
        </button>`).join('');
      panes.innerHTML = PAGES.map((p) => `
        <div class="set-page" data-setpage="${p.id}" hidden>${this['page_' + p.id]()}</div>`).join('');
      // 模板里每个 pane 都写死 hidden（避免首帧把所有页同时铺出来），所以
      // 重渲染之后必须自己把当前页显回来。以前只有 open() 记得调 showPage()，
      // 而改下载音质走的是 `setDownload() → render()` 这条路 —— 渲染完所有
      // pane 都还是 hidden，设置页就整片空白，也就是用户报的「黑屏」。
      // 兜在这里，以后谁再调 render() 都不会踩。
      this.showPage(this.page || PAGES[0].id);
    },

    row(label, desc, ctl) {
      return `<div class="set-row">
        <div class="set-text">
          <div class="set-label">${label}</div>
          ${desc ? `<div class="set-desc">${desc}</div>` : ''}
        </div>
        <div class="set-ctl">${ctl}</div>
      </div>`;
    },

    switchCtl(key, on) {
      return `<button class="set-switch${on ? ' on' : ''}" data-key="${key}" role="switch" aria-checked="${on}" aria-label="开关"></button>`;
    },

    page_play() {
      const quals = Object.entries(global.QUALITY_LABEL || {});
      const cur = global.store.quality;
      const opts = quals.map(([k, v]) => `<option value="${k}"${k === cur ? ' selected' : ''}>${v}</option>`).join('');
      // 音量滑杆已按用户要求移除：底栏本身就有音量条，设置里再放一个是重复的。
      return `<div class="set-page-title">播放</div>
        ${this.row('默认音质', '切换后正在播放的歌曲会立刻换流', `<select class="set-select" data-key="quality">${opts}</select>`)}
        ${this.row('启动时自动签到', '每天一次，静默完成', this.switchCtl('autoCheckin', this.get('autoCheckin')))}
        ${this.row('播放失败自动跳过', '连续多首失败时会暂停，避免刷完整个队列', this.switchCtl('autoSkip', this.get('autoSkip')))}
        ${this.row('音乐淡出淡入', '切歌与暂停时做一小段音量斜坡，避免爆音', this.switchCtl('fade', this.get('fade')))}
        ${this.row('记住上一次播放进度', '下次启动时接着上次的进度继续播', this.switchCtl('rememberProgress', this.get('rememberProgress')))}
        ${this.row('启动时打开的页面', '应用启动后先展示哪一页；选「上次离开时的页面」就接着关机前那一页', this.startPageCtl())}
        ${this.row('缓存最大大小', '超过上限时会在启动后清空一次缓存', this.cacheMaxCtl())}
        ${this.row('缓存目录', '歌曲缓存与图片缓存的存放位置，改完立即生效', this.cacheCtl())}
        ${this.row('刷新', '清空所有缓存并重新启动，登录状态和设置都保留', `<button class="btn-side set-path-btn" data-act="refresh">刷新</button>`)}`;
    },

    /**
     * 启动页选择器（m34266 第 2 点）。
     *
     * 存的是路由名（'radio' / 'daily' / …）或 'last'。这里只写值，真正跳转由
     * App.init() 读 `Settings.get('startPage')` 完成 —— 换页立即生效对用户没
     * 意义（设置弹窗就盖在当前页上），下次启动才看得到结果。
     */
    startPageCtl() {
      const cur = this.get('startPage') || 'radio';
      const opts = START_PAGES.map((p) =>
        `<option value="${p.key}"${p.key === cur ? ' selected' : ''}>${p.label}</option>`).join('');
      return `<select class="set-select set-select-wide" data-key="startPage">${opts}</select>`;
    },

    /** 缓存上限：数字输入 + 单位 + 当前占用（第 6 点） */
    cacheMaxCtl() {
      return `<div class="set-path set-path-num">
        <input class="set-num" id="setCacheMax" data-key="cacheMax" type="number" min="0" max="102400" step="128" value="${Number(this.get('cacheMax')) || 0}" aria-label="缓存上限（MB）">
        <span class="set-unit">MB</span>
        <span class="set-size">当前 <b id="setCacheSize">${this.cacheBytes ? global.U.fmtSize(this.cacheBytes) : '…'}</b></span>
      </div>`;
    },

    /** 缓存目录行：一行路径 + 更改按钮（自定义过才出现"恢复默认"）。 */
    cacheCtl() {
      const dir = this.cachePath;
      const label = dir || '读取中…';
      return `<div class="set-path">
        <code id="setCacheDir" title="${global.U.esc(label)}">${global.U.esc(label)}</code>
        <button class="btn-side set-path-btn" data-act="cacheDir">更改</button>
        <button class="btn-side set-path-btn" id="setCacheReset" data-act="cacheReset"${this.cacheCustom ? '' : ' hidden'}>恢复默认</button>
      </div>`;
    },

    /**
     * 下载页（第 5 点）。
     *
     * 下载设置存在主进程（config.download），这里只是渲染一份副本再回写，
     * 所以每一项都用 data-dlkey 而不是 data-key —— data-key 走的是
     * `settings` 那一套（写进 Settings.values 再 App.saveConfig），
     * 两套混在一起会让 `download.quality` 和 `settings.quality` 打架。
     */
    page_download() {
      // 下载可下全部四档（用户 m36467 更正过口径：MP3 或 FLAC 都行，
      // 只要不是网易云的私有格式）。容器由 level 决定 —— 前三档出 MP3，
      // 无损出 FLAC；encodeType 被服务端忽略，所以这里列的档位就是用户能
      // 拿到的容器档位，不再封顶。
      //
      // 没有 Hi-Res：用户 m36690 第④点指出它与无损实际是同一个音质
      // （服务端对两者都回同一个 FLAC），留着只是多一个骗人的选项。
      const TIERS = ['standard', 'higher', 'exhigh', 'lossless'];
      const label = global.QUALITY_LABEL || {};
      // 老配置里可能还存着已下架的 hires，折成无损而不是掉回极高。
      const cur = this.dl.quality === 'hires' ? 'lossless' : (TIERS.includes(this.dl.quality) ? this.dl.quality : 'exhigh');
      const opts = TIERS.map((k) =>
        `<option value="${k}"${k === cur ? ' selected' : ''}>${label[k] || k}${k === 'lossless' ? '  VIP' : ''}</option>`).join('');
      const orgs = [
        ['none', '不分文件夹'],
        ['artist', '按歌手分文件夹'],
        ['album', '按专辑分文件夹'],
      ].map(([k, v]) => `<option value="${k}"${k === (this.dl.organize || 'none') ? ' selected' : ''}>${v}</option>`).join('');
      const dir = this.dl.effectiveDir || '读取中…';
      return `<div class="set-page-title">下载</div>
        ${this.row('默认下载音质', '前 3 档是 MP3，无损是 FLAC（需要会员）', `<select class="set-select" data-dlkey="quality">${opts}</select>`)}
        ${this.row('下载地址', '文件保存位置，默认是系统的音乐文件夹', this.dlDirCtl(dir))}
        ${this.row('分类方式', '决定文件是直接放在下载目录还是先建一层文件夹', `<select class="set-select" data-dlkey="organize">${orgs}</select>`)}
        ${this.row('文件命名格式', '可用占位符：{首歌手名} {歌曲名} {歌手名} {专辑名} {音质}', `<input class="set-input set-input-wide" data-dlkey="template" type="text" value="${global.U.esc(this.dl.template || '{歌手名} - {歌曲名}')}" spellcheck="false">`)}
        <div class="set-desc" style="margin-top:10px">下载的文件是标准 MP3 或 FLAC，不是网易云的私有格式。会员能听的歌就能下载；取不到完整曲目时任务里会写明原因（无版权 / 已下架 / 只能试听）。</div>`;
    },

    /** 下载地址行：一行路径 + 更改按钮（自定义过才出现"恢复默认"）。 */
    dlDirCtl(dir) {
      return `<div class="set-path">
        <code id="setDlDir" title="${global.U.esc(dir)}">${global.U.esc(dir)}</code>
        <button class="btn-side set-path-btn" data-act="dlDir">更改</button>
        <button class="btn-side set-path-btn" id="setDlDirReset" data-act="dlDirReset"${this.dl.custom ? '' : ' hidden'}>恢复默认</button>
      </div>`;
    },

    page_look() {
      // 皮肤那一项已按用户要求删掉：标题栏右上角那枚调色板按钮（#tbSkin +
      // .skin-menu）是唯一切换入口，设置里再放一个下拉是重复入口。
      return `<div class="set-page-title">外观</div>
        ${this.row('界面动效', '关闭后所有过渡与动画立即完成', this.switchCtl('animations', this.get('animations')))}
        ${this.row('歌曲列表显示封面', '每首歌标题前的方形缩略图', this.switchCtl('listCover', this.get('listCover')))}
        ${this.row('侧栏歌单显示封面', '用歌单第一首歌的封面替换歌单封面', this.switchCtl('sideCover', this.get('sideCover')))}
        ${this.row('底栏显示评论数', '评论按钮右上角的数量角标', this.switchCtl('commentBadge', this.get('commentBadge')))}
        ${this.row('悬浮小窗始终置顶', '关掉后小窗会被其他窗口盖住', this.switchCtl('miniOnTop', this.get('miniOnTop')))}`;
    },

    page_side() {
      const rows = SIDE_ITEMS.map((it) => {
        const on = !this.sideHidden.has(it.key);
        return `<div class="set-side-item${on ? '' : ' off'}" data-key="${it.key}">
          <span class="set-side-grip">${global.icons(global.ICON.grip, 14)}</span>
          <span class="set-side-name">${it.label}</span>
          <button class="set-switch set-side-toggle${on ? ' on' : ''}" data-key="${it.key}" role="switch" aria-checked="${on}" aria-label="显示"></button>
        </div>`;
      }).join('');
      return `<div class="set-page-title">左侧栏显示哪些项</div>
        <div class="set-desc" style="margin-bottom:8px">关掉的项会从左侧栏移除，随时可以打开。</div>
        <div class="set-side-list">${rows}</div>`;
    },

    page_about() {
      // 版本号来自 package.json（主进程经 argv 传进来，见 preload 的注释）。
      // 拿不到时退回 '—'，绝不硬编码——硬编码的结果就是升级后还写着旧版本。
      const ver = global.ne.appVersion || '—';
      const repo = global.ne.repo || {};
      const el = (navigator.userAgent.match(/Electron\/[\d.]+/) || [''])[0].replace('Electron/', '') || '—';
      return `<div class="set-page-title">关于</div>
        <div class="set-about">
          <div><b>网易云音乐 Lite</b> — Windows 第三方轻量客户端</div>
          <div>版本 <code>${U.esc(ver)}</code> · Electron <code>${U.esc(el)}</code></div>
          <div>快捷键：<code>空格</code> 播放 / 暂停 · <code>← →</code> 快退快进 5 秒 · <code>Ctrl+← →</code> 上一首 / 下一首 · <code>↑ ↓</code> 音量 · <code>L</code> 歌词页 · <code>Q</code> 播放列表 · <code>Ctrl+F</code> 搜索 · <code>F12</code> 开发者工具</div>
          <div>源码：<span class="set-link" data-act="repo">${U.esc(repo.desktop || 'github.com/Airisey/netease-lite')}</span>（点击用浏览器打开）</div>
          <div>安卓版：<span class="set-link" data-act="repo-android">${U.esc(repo.android || 'github.com/Airisey/netease-lite-android')}</span></div>
          <div>数据来自网易云音乐公开接口，仅用于学习与个人使用。</div>
          <div><span class="set-link" data-act="devtools">打开开发者工具</span> · <span class="set-link" data-act="reset">恢复默认设置</span></div>
        </div>`;
    },
  };

  global.Settings = Settings;
})(window);
