/* ============================================================
   视图渲染：页面 / 歌曲列表 / 评论 / 卡片
   ============================================================ */
(function (global) {
  'use strict';

  const ICON = {
    play: '<path fill="currentColor" d="M7 4l13 8-13 8z"/>',
    add: '<path fill="currentColor" d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/>',
    // 取消收藏用减号，跟收藏的加号成对
    minus: '<path fill="currentColor" d="M5 11h14v2H5z"/>',
    heart: '<path fill="currentColor" d="M12 21s-8-5.1-8-11a4.6 4.6 0 018-3.1A4.6 4.6 0 0120 10c0 5.9-8 11-8 11z"/>',
    heartOutline: '<path fill="none" stroke="currentColor" stroke-width="1.7" d="M12 19.5C9.7 18 5.5 14.6 5.5 10.4A3.9 3.9 0 0112 7.7a3.9 3.9 0 016.5 2.7c0 4.2-4.2 7.6-6.5 9.1z"/>',
    download: '<path fill="currentColor" d="M11 3h2v9h3l-4 4-4-4h3zM5 18h14v2H5z"/>',
    // 云盘页右上角的搜索、底部上传条（用户 m05718）
    search: '<path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" d="M10.5 4a6.5 6.5 0 014.9 10.8l4.4 4.4-1.4 1.4-4.4-4.4A6.5 6.5 0 1110.5 4zm0 2a4.5 4.5 0 100 9 4.5 4.5 0 000-9z"/>',
    upload: '<path fill="currentColor" d="M11 16h2V8.8l3 3 1.4-1.4L12 5l-5.4 5.4 1.4 1.4 3-3zM5 18h14v2H5z"/>',
    next: '<path fill="currentColor" d="M15 6h2v12h-2zM5 18V6l9 6z"/>',
    comment: '<path fill="currentColor" d="M4 4h16v12H8l-4 4z"/>',
    album: '<path fill="currentColor" d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 13a3 3 0 110-6 3 3 0 010 6z"/>',
    artist: '<path fill="currentColor" d="M12 12a5 5 0 100-10 5 5 0 000 10zm0 2c-5 0-9 2.7-9 6v2h18v-2c0-3.3-4-6-9-6z"/>',
    copy: '<path fill="currentColor" d="M8 3h9v2H8zm-3 3h12v15H5zm2 2v11h8V8z"/>',
    trash: '<path fill="currentColor" d="M9 3h6v2H9zM4 6h16v2H4zm2 3h12v12H6zm3 2v8h2V11zm4 0v8h2V11z"/>',
    radio: '<path fill="currentColor" d="M3 6h18v3H3zm0 5h18v9H3zm3 3v3h5v-3z"/>',
    // 与底栏随机播放按钮同一套双箭头交叉图形，保证两处图标一致
    shuffle: '<path fill="currentColor" d="M17 3l4 4-4 4V8h-2.2l-2.3 3-1.3-1.7L13.4 6H17V3zM3 6h4.3l2.5 3.3-1.3 1.7L6.6 8H3V6zm14 8v-3l4 4-4 4v-3h-3.6l-2.2-3 1.3-1.7L14.8 14H17zM3 16h3.6l2.2-3 1.3 1.7-2.5 3.3H3v-2z"/>',
    // 榜单 / 播客 / 皮肤 / 设置 等新增入口
    chart: '<path fill="currentColor" d="M4 20h3V10H4zm6.5 0h3V4h-3zM17 20h3v-6h-3z"/>',
    podcast: '<path fill="currentColor" d="M12 2a10 10 0 00-4 19.2V19a8 8 0 1110 0v2.2A10 10 0 0012 2zm0 5a5 5 0 00-2 9.6V21a1 1 0 002 0v-4.4A5 5 0 0012 7zm0 3a2 2 0 100 4 2 2 0 000-4z"/>',
    palette: '<path fill="currentColor" d="M12 3a9 9 0 000 18c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.2 0-1.1.9-2 2-2h2.3A4.7 4.7 0 0022 9.8C22 6 17.5 3 12 3zM7.5 12a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm3-4a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm5 0a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm3 4a1.5 1.5 0 110-3 1.5 1.5 0 010 3z"/>',
    gear: '<path fill="currentColor" d="M12 8a4 4 0 100 8 4 4 0 000-8zm0 6a2 2 0 110-4 2 2 0 010 4zm8.9-2c0-.5-.05-1-.14-1.47l2.02-1.5-2-3.46-2.35.94a7.9 7.9 0 00-2.55-1.48L15.5 2h-4l-.38 2.53a7.9 7.9 0 00-2.55 1.48l-2.35-.94-2 3.46 2.02 1.5a7.9 7.9 0 000 2.94l-2.02 1.5 2 3.46 2.35-.94a7.9 7.9 0 002.55 1.48L11.5 22h4l.38-2.53a7.9 7.9 0 002.55-1.48l2.35.94 2-3.46-2.02-1.5c.09-.47.14-.97.14-1.47z"/>',
    miniV: '<path fill="currentColor" d="M7 3h10a4 4 0 014 4v10a4 4 0 01-4 4H7a4 4 0 01-4-4V7a4 4 0 014-4zm0 2a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2H7zm3 3h4a2 2 0 012 2v3a2 2 0 01-2 2h-4a2 2 0 01-2-2V10a2 2 0 012-2z"/>',
    miniH: '<path fill="currentColor" d="M3 7a4 4 0 014-4h10a4 4 0 014 4v10a4 4 0 01-4 4H7a4 4 0 01-4-4V7zm2 0v10a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2zm3 3h4a2 2 0 012 2v1a2 2 0 01-2 2H8a2 2 0 01-2-2v-1a2 2 0 012-2z"/>',
    // 设置弹窗里用到的小图标
    check: '<path fill="currentColor" d="M9.6 16.2L5.4 12l-1.4 1.4 5.6 5.6L20.4 8.2 19 6.8z"/>',
    slider: '<path fill="currentColor" d="M4 11h9v2H4zm13-6h3v2h-3zM4 5h9v2H4zm13 12h3v2h-3zM4 17h9v2H4zm11-8a2 2 0 11-4 0 2 2 0 014 0zm0 12a2 2 0 11-4 0 2 2 0 014 0z"/>',
    layers: '<path fill="currentColor" d="M12 3l9 5-9 5-9-5zm0 2.3L6.4 8 12 10.7 17.6 8zM3 13l9 5 9-5-1.8-1-7.2 4-7.2-4z"/>',
    info: '<path fill="currentColor" d="M12 2a10 10 0 100 20 10 10 0 000-20zm1 15h-2v-6h2zm0-8h-2V7h2z"/>',
    eye: '<path fill="none" stroke="currentColor" stroke-width="1.8" d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12zm9.5 3a3 3 0 110-6 3 3 0 010 6z"/>',
    grip: '<path fill="currentColor" d="M9 6h2v2H9zm4 0h2v2h-2zM9 11h2v2H9zm4 0h2v2h-2zM9 16h2v2H9zm4 0h2v2h-2z"/>',
    // 多选（m34266 第 1 点）
    folder: '<path fill="currentColor" d="M3 5h6l2 2h10v12H3zm2 4v8h14V9z"/>',
    checkAll: '<path fill="currentColor" d="M3 5h6l2 2h10v12H3zm2 4v8h14V9zM5.5 12l1.4-1.4 2.1 2.1 4.6-4.6L15 9.5l-6 6z"/>',
  };

  // ============================================================
  //  通用片段
  // ============================================================

  function skeletonTracks(n) {
    let h = '<div class="tracklist"><div class="tl-body">';
    for (let i = 0; i < n; i++) h += '<div class="skeleton sk-row"></div>';
    return h + '</div></div>';
  }

  function skeletonGrid(n) {
    let h = '<div class="grid">';
    for (let i = 0; i < n; i++) {
      h += '<div><div class="skeleton sk-card"></div><div class="skeleton" style="height:12px;margin-top:9px;width:82%"></div></div>';
    }
    return h + '</div>';
  }

  function emptyState(text, hint) {
    return `<div class="empty">
      <svg viewBox="0 0 24 24" width="46" height="46"><path fill="currentColor" d="M12 3v10.6A4 4 0 1014 17V7h4V3z"/></svg>
      <div class="empty-text">${U.esc(text)}</div>
      ${hint ? `<div class="empty-hint">${U.esc(hint)}</div>` : ''}
    </div>`;
  }

  /** 歌单卡片 */
  function playlistCard(p) {
    const cover = U.cover(p.cover, 300);
    const node = U.el(`<div class="card">
      <div class="card-cover">
        <img loading="lazy" src="${U.esc(global.ne.img(cover))}" alt="">
        <div class="card-play" title="播放">${icon(ICON.play, 15)}</div>
        ${p.playCount ? `<div class="card-count">${icon('<path fill="currentColor" d="M8 5v14l11-7z"/>', 11)}${U.fmtCount(p.playCount)}</div>` : ''}
      </div>
      <div class="card-name">${U.esc(p.name)}</div>
      ${p.artist || p.creator ? `<div class="card-sub">${U.esc(p.artist || p.creator.name)}</div>` : ''}
    </div>`);
    node.addEventListener('click', () => App.go('playlist', { id: p.id, name: p.name }));
    const playBtn = node.querySelector('.card-play');
    playBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      App.playPlaylist(p.id, p.name);
    });
    return node;
  }

  function artistCard(a) {
    const node = U.el(`<div class="card">
      <div class="card-cover" style="border-radius:50%">
        <img loading="lazy" src="${U.esc(global.ne.img(U.cover(a.cover, 300)))}" alt="">
      </div>
      <div class="card-name" style="text-align:center">${U.esc(a.name)}</div>
      ${a.albumSize != null ? `<div class="card-sub" style="text-align:center">${a.albumSize} 张专辑</div>` : ''}
    </div>`);
    node.addEventListener('click', () => App.go('artist', { id: a.id, name: a.name }));
    return node;
  }

  function albumCard(a) {
    const node = U.el(`<div class="card">
      <div class="card-cover">
        <img loading="lazy" src="${U.esc(global.ne.img(U.cover(a.cover, 300)))}" alt="">
        <div class="card-play" title="播放">${icon(ICON.play, 15)}</div>
      </div>
      <div class="card-name">${U.esc(a.name)}</div>
      ${a.artist ? `<div class="card-sub">${U.esc(a.artist)}</div>` : ''}
    </div>`);
    node.addEventListener('click', () => App.go('album', { id: a.id, name: a.name }));
    node.querySelector('.card-play').addEventListener('click', (e) => {
      e.stopPropagation();
      App.playAlbum(a.id, a.name);
    });
    return node;
  }

  /** 榜单卡片：点进去就是普通歌单页（榜单 id 本身是歌单 id） */
  function chartCard(t) {
    const node = U.el(`<div class="card">
      <div class="card-cover">
        <img loading="lazy" src="${U.esc(global.ne.img(U.cover(t.cover, 300)))}" alt="">
        <div class="card-play" title="播放">${icon(ICON.play, 15)}</div>
        ${t.updateFrequency ? `<div class="card-count">${U.esc(t.updateFrequency)}</div>` : ''}
      </div>
      <div class="card-name">${U.esc(t.name)}</div>
      <div class="card-sub">${t.trackCount ? t.trackCount + ' 首' : ''}</div>
    </div>`);
    node.addEventListener('click', () => App.go('playlist', { id: t.id, name: t.name }));
    node.querySelector('.card-play').addEventListener('click', (e) => {
      e.stopPropagation();
      App.playPlaylist(t.id, t.name);
    });
    return node;
  }

  /** 播客电台卡片 */
  function radioCard(r) {
    const node = U.el(`<div class="card">
      <div class="card-cover">
        <img loading="lazy" src="${U.esc(global.ne.img(U.cover(r.cover, 300)))}" alt="">
        <div class="card-play" title="播放">${icon(ICON.play, 15)}</div>
        ${r.programCount ? `<div class="card-count">${r.programCount} 期</div>` : ''}
      </div>
      <div class="card-name">${U.esc(r.name)}</div>
      <div class="card-sub">${U.esc(r.dj ? r.dj.name : (r.category || ''))}</div>
    </div>`);
    node.addEventListener('click', () => App.go('podcastDetail', { id: r.id, name: r.name }));
    node.querySelector('.card-play').addEventListener('click', (e) => {
      e.stopPropagation();
      App.playPodcast(r.id, r.name);
    });
    return node;
  }

  /** 用户卡片（关注 / 粉丝列表用） */
  /**
   * 关注按钮的共用点击逻辑（歌手页与用户主页都用它）。
   *
   * 关注类写操作会撞上账号级风控门 `-462`：服务端返回的是一包验证参数而不是
   * 一句可读的错误，直接 toast 用户完全无从下手。这里把 `needVerify` 分流到
   * 安全验证二维码弹窗，并把它绑成「验证完成后自动重试这次关注」。
   *
   * @param {object} o {btn, want, call, sync, okMsg}
   */
  async function followClick(o) {
    const { btn, want, call, sync, okMsg } = o;
    btn.disabled = true;
    try {
      const r = await call(want);
      if (r && r.needVerify) {
        App.openVerify(r.verify, () => followClick(o));
        return;
      }
      if (!r || !r.ok) throw new Error((r && r.message) || '操作失败');
      sync(want);
      U.toastOk(okMsg(want));
    } catch (e) {
      U.toastErr('操作失败：' + api.explain(e));
    } finally {
      btn.disabled = false;
    }
  }

  function userCard(u) {
    const node = U.el(`<div class="ucard">
      <div class="ucard-avatar">
        <img loading="lazy" src="${U.esc(global.ne.img(U.cover(u.avatar, 200)))}" alt="">
      </div>
      <div class="ucard-meta">
        <div class="ucard-name">${U.esc(u.name)}${u.vipType ? '<span class="ucard-vip">VIP</span>' : ''}</div>
        <div class="ucard-sub">${u.follows} 关注 · ${u.followeds} 粉丝</div>
        ${u.signature ? `<div class="ucard-sign">${U.esc(u.signature)}</div>` : ''}
      </div>
      ${u.mutual ? '<span class="ucard-mutual">互关</span>' : ''}
    </div>`);
    node.addEventListener('click', () => App.go('user', { id: u.id, name: u.name }));
    return node;
  }

  function icon(path, size) {
    return `<svg viewBox="0 0 24 24" width="${size || 16}" height="${size || 16}">${path}</svg>`;
  }

  // ============================================================
  //  歌曲列表
  // ============================================================

  /**
   * 渲染一个歌曲列表。
   * @param {Array} songs
   * @param {object} opt { context: {id,name}, showAlbum: bool, showIndex: bool, playlistId }
   */
  // ---------------- 后缀（别名）循环滚动 ----------------
  // 歌名永远优先显示，后缀只吃剩下的空间。三种状态：
  //   1) 后缀放得下      → 静态显示，完整可读
  //   2) 后缀放不下      → 加 .scrolling 循环滚动（每段自带 padding-right 留出间隙，
  //                        复制成两份后动画平移 -50% 正好走完一段，首尾无缝）
  //   3) 歌名自己都放不下 → 加 .yielded 让后缀整块让位，空间全给歌名
  const ALIAS_MIN = 72;  // 与 styles.css 的 .tl-alias min-width 保持一致
  const TITLE_GAP = 8;   // 与 .tl-title 的 gap 保持一致

  function measureAliasBox(box) {
    const title = box.parentElement;
    if (!title) return;
    const name = title.querySelector('.tl-name');
    const seg = box.querySelector('.tl-alias-seg');
    if (!name || !seg) return;

    // MV / VIP 标签不参与收缩，算歌名可用宽度时必须先扣掉。
    // 整块量 .tl-tags（内部已含标签之间的 gap），不要再逐个加 TITLE_GAP，否则重复计算
    const tags = title.querySelector('.tl-tags');
    const tagsW = tags ? tags.getBoundingClientRect().width + TITLE_GAP : 0;

    const nameFull = name.scrollWidth;   // 歌名完整宽度（overflow:hidden 不影响 scrollWidth）
    const cellW = title.clientWidth;
    const availForName = cellW - ALIAS_MIN - TITLE_GAP - tagsW;

    // 判定只用 nameFull 与 cellW —— 两者都与「后缀此刻是否显示」无关，
    // 所以不会出现「隐藏后缀→歌名放得下→又显示后缀」的来回抖动
    if (nameFull > availForName + 1) {
      box.classList.add('yielded');
      box.classList.remove('scrolling');
      box.style.removeProperty('--alias-dur');
      return;
    }
    box.classList.remove('yielded');

    // 只量「一段」的宽度（含其 padding-right 间隙）：这正是动画要平移的距离
    const need = seg.getBoundingClientRect().width;
    const has = box.clientWidth;
    if (has > 0 && need > has + 1) {
      // 约 34px/s，最快 6s；平移 -50% 恰好走完一整段
      const dur = Math.max(6, Math.round(need / 34));
      box.style.setProperty('--alias-dur', dur + 's');
      box.classList.add('scrolling');
    } else {
      box.classList.remove('scrolling');
      box.style.removeProperty('--alias-dur');
    }
  }

  function measureAlias(scope) {
    for (const box of scope.querySelectorAll('.tl-alias')) measureAliasBox(box);
  }

  let aliasResizeBound = false;
  function bindAliasResize() {
    if (aliasResizeBound) return;
    aliasResizeBound = true;
    window.addEventListener('resize', U.debounce(() => measureAlias(document), 180));
  }

  function TrackList(songs, opt = {}) {
    const state = {
      songs,
      opt,
      likedIds: store.likedIds,
    };

    // 多选模式（m34266 第 1 点）。只有传了 selectable 的调用方（歌单页）会开，
    // 其它页面（搜索 / 专辑 / 歌手 / 每日推荐…）行为与从前完全一致。
    const selectable = !!opt.selectable;
    let selectMode = false;
    const selected = new Set();   // 存歌曲 id：行是分块渲染的，按 id 比按索引稳

    // 多选工具条只在可多选的列表里存在：其它页面连这道 DOM 都没有，
    // 不必靠 hidden 兜着，也省得它们误绑事件。
    const selBar = selectable ? `
      <div class="tl-selbar" hidden>
        <span class="tl-sel-count">未选择歌曲</span>
        <div class="tl-selacts">
          <button class="btn-outline" data-selact="all">全选</button>
          <button class="btn-outline" data-selact="move">${icon(ICON.folder, 14)}移动到</button>
          <button class="btn-outline" data-selact="add">${icon(ICON.add, 14)}添加到</button>
          <button class="btn-outline" data-selact="like">${icon(ICON.heartOutline, 14)}喜欢</button>
          <button class="btn-outline" data-selact="download">${icon(ICON.download, 14)}下载</button>
          <button class="btn-outline btn-danger" data-selact="remove">${icon(ICON.trash, 14)}从歌单删除</button>
          <button class="btn-outline" data-selact="exit">取消</button>
        </div>
      </div>` : '';

    const root = U.el(`<div class="tracklist">
      <div class="tl-head">
        <div class="tl-c">#</div>
        <div class="tl-c">标题</div>
        <div class="tl-c">歌手</div>
        <div class="tl-c">专辑</div>
        <div class="tl-c" style="text-align:right">时长</div>
      </div>
      ${selBar}
      <div class="tl-body"></div>
    </div>`);

    const body = root.querySelector('.tl-body');

    function renderRow(song, i) {
      // 本地扫描要用的字典：任何列表只要画过一行，这首歌就进登记表
      // （m00001 第③点：扫描按钮搬到已下载音乐页后，没有「当前歌单」可用了）。
      store.noteSong(song);
      const liked = state.likedIds.has(song.id);
      const isPlaying = player.current && player.current.id === song.id;
      const picked = selected.has(song.id);
      // 本地文件（m35069 第 1 点）：这首在本机已经有音频了就点亮「√」。
      // 数据源是 store.localIds（主进程扫描出来的索引），不在这里查文件系统。
      const local = store.localIds.has(song.id);

      const row = U.el(`<div class="tl-row${song.unavailable ? ' disabled' : ''}${isPlaying ? ' playing' : ''}${picked ? ' selected' : ''}" data-id="${song.id}" data-i="${i}">
        <div class="tl-idx">
          <span class="tl-slot">
            <span class="tl-check">${icon(ICON.check, 12)}</span>
            <span class="tl-num">${String(i + 1).padStart(2, '0')}</span>
            <span class="tl-acts">
              <button class="tl-act tl-play" title="播放">${icon(ICON.play, 13)}</button>
            </span>
          </span>
          <button class="tl-act tl-like${liked ? ' on' : ''}" title="${liked ? '取消喜欢' : '喜欢'}">${icon(liked ? ICON.heart : ICON.heartOutline, 13)}</button>
          <button class="tl-act tl-dl${local ? ' on' : ''}" title="${local ? '已下载到本地（点击在文件夹中显示）' : '未下载（点击下载）'}">${icon(local ? ICON.check : ICON.download, 13)}</button>
        </div>
        <div class="tl-title">
          ${song.cover
            ? `<img class="tl-cover" loading="lazy" alt="" src="${U.esc(global.ne.img(U.cover(song.cover, 60)))}">`
            : '<span class="tl-cover tl-cover-empty"></span>'}
          <span class="tl-name" title="${U.esc(song.name)}">${U.esc(song.name)}</span>
          ${song.alias && song.alias.length
            ? `<span class="tl-alias" title="${U.esc(song.alias[0])}"><span class="tl-alias-in">`
              + `<span class="tl-alias-seg">${U.esc(song.alias[0])}</span>`
              + `<span class="tl-alias-seg" aria-hidden="true">${U.esc(song.alias[0])}</span>`
              + `</span></span>`
            : ''}
          <span class="tl-tags">${song.mvid ? '<span class="tl-tag mv" title="含 MV">MV</span>' : ''
            }${song.fee === 1 ? '<span class="tl-tag vip" title="需要会员">VIP</span>' : ''
            }${song.reason ? `<span class="tl-tag rec" title="推荐理由">${U.esc(song.reason)}</span>` : ''}</span>
        </div>
        <div class="tl-artist">${song.artists.map((a) =>
          // 没有 id 的歌手（本地扫描/文件名兜底造出来的行）渲染成纯文本：给它一个
          // 假 id 就是一条点进去 404 的死链。
          a.id
            ? `<a data-artist="${a.id}" title="${U.esc(a.name)}">${U.esc(a.name)}</a>`
            : `<span title="${U.esc(a.name)}">${U.esc(a.name)}</span>`).join(' / ')}</div>
        <div class="tl-album">${song.album && song.album.id
          ? `<a data-album="${song.album.id}" title="${U.esc(song.album.name)}">${U.esc(song.album.name)}</a>`
          : U.esc(song.album ? song.album.name : '')}</div>
        <div class="tl-dur">${U.fmtTime(song.duration)}</div>
      </div>`);

      // ---- 行交互 ----
      // 多选模式下整行就是复选框：单击选中 / 取消，双击与右键都让位，
      // 免得想连点三首却触发了播放或弹出菜单。
      row.addEventListener('click', (e) => {
        if (!selectMode) return;
        if (e.target.closest('a, button')) return;
        toggleSelect(song.id, row);
      });

      row.addEventListener('dblclick', (e) => {
        if (selectMode) return;
        if (e.target.closest('a, button')) return;
        playFrom(i);
      });

      row.querySelector('.tl-play').addEventListener('click', (e) => {
        e.stopPropagation();
        if (selectMode) { toggleSelect(song.id, row); return; }
        playFrom(i);
      });

      row.querySelector('.tl-like').addEventListener('click', (e) => {
        e.stopPropagation();
        if (selectMode) { toggleSelect(song.id, row); return; }
        toggleLike(song, row.querySelector('.tl-like'));
      });

      // 「√」按钮（m35069 第 1 点）：本机已有就定位文件，没有就丢进下载队列。
      // 不做「点一下删掉本地文件」—— 那个动作不可撤销，不该藏在一个行内小图标里。
      row.querySelector('.tl-dl').addEventListener('click', (e) => {
        e.stopPropagation();
        if (selectMode) { toggleSelect(song.id, row); return; }
        if (store.localIds.has(song.id)) global.ne.local.reveal(song.id);
        else App.downloadSongs([song]);
      });

      for (const a of row.querySelectorAll('a[data-artist]')) {
        a.addEventListener('click', (e) => {
          e.stopPropagation();
          if (selectMode) { toggleSelect(song.id, row); return; }
          App.go('artist', { id: Number(a.dataset.artist), name: a.textContent });
        });
      }
      for (const a of row.querySelectorAll('a[data-album]')) {
        a.addEventListener('click', (e) => {
          e.stopPropagation();
          if (selectMode) { toggleSelect(song.id, row); return; }
          App.go('album', { id: Number(a.dataset.album), name: a.textContent });
        });
      }

      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        // 多选模式下右键选中行是「加入选区」，不给单曲菜单 —— 用户此时
        // 想做的是一批操作，弹一个只对一首生效的菜单是误导。
        if (selectMode) { toggleSelect(song.id, row, true); return; }
        songContextMenu(song, i, state, e);
      });

      return row;
    }

    function toggleSelect(id, row, forceOn) {
      const next = forceOn ? true : !selected.has(id);
      if (next) selected.add(id); else selected.delete(id);
      row.classList.toggle('selected', next);
      syncSelection();
    }

    /** 多选工具条上的计数与按钮可用性 */
    function syncSelection() {
      const bar = root.querySelector('.tl-selbar');
      if (!bar) return;
      const n = selected.size;
      const label = bar.querySelector('.tl-sel-count');
      if (label) label.textContent = n ? `已选 ${n} 首` : '未选择歌曲';
      bar.classList.toggle('has', n > 0);
      for (const b of bar.querySelectorAll('[data-selact]')) {
        const act = b.dataset.selact;
        // 「全选」「取消」永远可用；其余按钮没选中就是灰的。
        // 「移动到」「从歌单删除」还额外要求这个歌单是可改的（自己的歌单）——
        // 收藏来的歌单是别人的，往里删歌服务端会拒，不如一开始就置灰。
        if (act === 'all' || act === 'exit') continue;
        const needOwn = act === 'move' || act === 'remove';
        b.disabled = n === 0 || (needOwn && !opt.canRemove);
      }
      if (opt.onSelectionChange) opt.onSelectionChange(selected);
    }

    /** 选出当前列表里被勾中的歌曲对象（保持列表原顺序） */
    function pickedSongs() {
      return state.songs.filter((s) => selected.has(s.id));
    }

    function exitSelect() {
      selectMode = false;
      selected.clear();
      root.classList.remove('selecting');
      for (const row of body.querySelectorAll('.tl-row')) row.classList.remove('selected');
      const bar = root.querySelector('.tl-selbar');
      if (bar) bar.hidden = true;
      syncSelection();
      // 让页面把「多选」按钮的高亮一起撤掉 —— 工具条上的「取消」也能退出，
      // 只在按钮自己的 click 里清 .on 会留下一个亮着但已退出的按钮。
      if (opt.onSelectModeChange) opt.onSelectModeChange(false);
    }

    function enterSelect() {
      selectMode = true;
      root.classList.add('selecting');
      const bar = root.querySelector('.tl-selbar');
      if (bar) bar.hidden = false;
      syncSelection();
      if (opt.onSelectModeChange) opt.onSelectModeChange(true);
    }

    function playFrom(i) {
      const list = state.songs;
      const ctx = state.opt.context || { id: 0, name: '列表' };
      player.playList(list, i, ctx);
    }

    // 长列表分块渲染：先出前 CHUNK 行，滚到底部再补下一块
    const CHUNK = 200;
    let rendered = 0;

    function appendChunk() {
      const end = Math.min(rendered + CHUNK, songs.length);
      const frag = document.createDocumentFragment();
      for (let i = rendered; i < end; i++) frag.appendChild(renderRow(songs[i], i));
      body.appendChild(frag);
      rendered = end;
      // 必须等元素挂进文档后才有真实宽度，故下一帧再测量
      requestAnimationFrame(() => { if (root.isConnected) measureAlias(root); });
    }

    body.innerHTML = '';
    appendChunk();
    // 窗口尺寸变化后可用宽度会变，需要重新决定哪些后缀要滚动
    bindAliasResize();

    let scrollBound = false;
    if (songs.length > CHUNK) {
      const scroller = document.getElementById('mainScroll');
      if (scroller) {
        scroller.addEventListener('scroll', U.throttle(() => {
          if (rendered >= songs.length) return;
          // 页面已经被替换掉时停止补渲染
          if (!root.isConnected) return;
          if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 500) appendChunk();
        }, 120), { passive: true });
        scrollBound = true;
      }
    }

    root._refreshPlaying = (song) => {
      for (const row of body.querySelectorAll('.tl-row')) {
        row.classList.toggle('playing', !!song && Number(row.dataset.id) === song.id);
      }
    };
    root._refreshLike = (id, liked) => {
      state.likedIds = store.likedIds;
      for (const row of body.querySelectorAll('.tl-row')) {
        if (Number(row.dataset.id) !== id) continue;
        const btn = row.querySelector('.tl-like');
        if (!btn) continue;
        btn.classList.toggle('on', liked);
        btn.innerHTML = icon(liked ? ICON.heart : ICON.heartOutline, 13);
      }
    };
    // 「√」列不在这里刷：本地索引变化是主进程广播出来的，App.bindLocal 收到
    // 之后统一扫 DOM 重画（见 app.js 的 paintLocal）。放在那边只需要一份实现，
    // 也覆盖「当前页不是歌单页」的情况。


    // 多选模式的对外接口：歌单页的「多选」按钮、以及批量操作完成后由
    // App 侧调用。非可多选列表上这些方法不存在，调用方要判一下。
    if (selectable) {
      root._enterSelect = enterSelect;
      root._exitSelect = exitSelect;
      root._pickedSongs = () => pickedSongs();
      root._clearSelection = () => {
        selected.clear();
        for (const r of body.querySelectorAll('.tl-row')) r.classList.remove('selected');
        syncSelection();
      };
      root._getSelectMode = () => selectMode;

      const bar = root.querySelector('.tl-selbar');
      bar.addEventListener('click', (e) => {
        const b = e.target.closest('[data-selact]');
        if (!b) return;
        const act = b.dataset.selact;
        if (act === 'exit') { exitSelect(); return; }
        if (act === 'all') {
          // 全选要连还没渲染出来的分块一起算上 —— 用户在歌单页点「全选」，
          // 期待的是整个歌单，不是当前屏幕上这几十行。
          // 注意不能为了打勾就把剩下的几千行都补出来：那会有几千次 DOM 插入，
          // 界面直接卡住。所以只更新数据层，然后把「已经在 DOM 里」的行打勾；
          // 后面的分块补渲染时 renderRow 会读 selected 自己带上 .selected。
          const on = selected.size < songs.length;
          selected.clear();
          if (on) for (const s of songs) selected.add(s.id);
          for (const r of body.querySelectorAll('.tl-row')) {
            r.classList.toggle('selected', on && selected.has(Number(r.dataset.id)));
          }
          syncSelection();
          return;
        }
        const picked = pickedSongs();
        if (!picked.length) return;
        if (opt.onSelectAction) opt.onSelectAction(act, picked, root);
      });
    }
    return root;
  }

  /**
   * 喜欢 / 取消喜欢（列表行、右键菜单用）。
   * 和底栏红心同样的道理：状态先乐观翻转再发请求，失败回滚，
   * 否则连点两下会读到同一个旧值、发出两条相同的 like。
   */
  async function toggleLike(song, btn) {
    if (!store.loggedIn) { App.openLogin(); return; }
    const next = !store.likedIds.has(song.id);
    const paint = (on) => {
      if (!btn) return;
      btn.classList.toggle('on', on);
      btn.innerHTML = icon(on ? ICON.heart : ICON.heartOutline, 13);
    };
    if (next) store.likedIds.add(song.id); else store.likedIds.delete(song.id);
    paint(next);
    store.emit('like:changed', { id: song.id, liked: next });
    try {
      await App._queueLike(song.id, next);
      // 我喜欢的音乐列表需要刷新
      api.invalidate('pl:');
      api.invalidate('liked:');
      // 成功提示等服务端确认之后再弹：先弹「已添加」再弹「操作过于频繁」会自相矛盾
      U.toastOk(next ? '已添加到我喜欢的音乐' : '已取消喜欢');
    } catch (e) {
      if (next) store.likedIds.delete(song.id); else store.likedIds.add(song.id);
      paint(!next);
      store.emit('like:changed', { id: song.id, liked: !next });
      U.toastErr(api.explain(e));
    }
  }

  /** 歌曲右键菜单 */
  function songContextMenu(song, index, state, ev) {
    const liked = store.likedIds.has(song.id);
    const items = [
      { label: '播放', icon: ICON.play, onClick: () => player.playList(state.songs, index, state.opt.context) },
      { label: '下一首播放', icon: ICON.next, onClick: () => player.playNext([song]) },
      'sep',
      {
        label: liked ? '取消喜欢' : '喜欢',
        icon: liked ? ICON.heart : ICON.heartOutline,
        onClick: () => toggleLike(song, null),
      },
      { label: '添加到歌单…', icon: ICON.add, onClick: () => App.openAddToPlaylist([song]) },
      {
        label: song.fee === 1 ? '下载（VIP）' : '下载',
        icon: ICON.download,
        onClick: () => App.downloadSongs([song]),
      },
      'sep',
      { label: '查看专辑', icon: ICON.album, disabled: !song.album?.id, onClick: () => App.go('album', { id: song.album.id, name: song.album.name }) },
      { label: '查看歌手', icon: ICON.artist, disabled: !song.artists?.length, onClick: () => App.openArtistChoice(song) },
      { label: '查看评论', icon: ICON.comment, onClick: () => App.openComments(song) },
      'sep',
      { label: '复制歌曲链接', icon: ICON.copy, onClick: () => { navigator.clipboard.writeText(`https://music.163.com/song?id=${song.id}`); U.toastOk('链接已复制'); } },
    ];
    // 在歌单里时可以移除
    if (state.opt.playlistId) {
      items.push('sep', {
        label: '从本歌单中删除',
        icon: ICON.trash,
        onClick: () => App.removeFromPlaylist(state.opt.playlistId, song),
      });
    }
    U.ctxMenu(items, ev ? ev.clientX : 200, ev ? ev.clientY : 200);
  }

  // ============================================================
  //  评论
  // ============================================================

  function CommentList(type, id, total) {
    const root = U.el(`<div class="comments"></div>`);
    // 评论点赞接口要的是带类型前缀的 threadId：歌曲是 `R_SO_4_<id>`，
    // 歌单是 `A_PL_0_<id>`，专辑是 `R_AL_3_<id>`。前缀给错服务端直接回 250。
    const threadId = type === 'playlist' ? `A_PL_0_${id}`
      : type === 'album' ? `R_AL_3_${id}`
      : `R_SO_4_${id}`;
    let offset = 0;
    let loading = false;
    let done = false;
    const seen = new Set();
    const LIMIT = 20;

    root.appendChild(U.el(`<div class="cm-summary">精彩评论 <em>共 ${U.fmtCount(total)} 条</em></div>`));

    async function loadMore() {
      if (loading || done) return;
      loading = true;
      const btn = root.querySelector('.cm-loadmore');
      if (btn) { btn.textContent = '加载中…'; btn.disabled = true; }
      try {
        const r = await svc.comments(type, id, LIMIT, offset);
        const list = offset === 0 ? [...r.hot, ...r.latest] : r.latest;
        let added = 0;
        for (const c of list) {
          if (seen.has(c.id)) continue;
          seen.add(c.id);
          root.insertBefore(commentNode(c, threadId), btn || null);
          added++;
        }
        offset += LIMIT;
        if (btn) btn.remove();
        if (added === 0 && offset > LIMIT) { done = true; return; }
        if (offset < r.total && r.latest.length >= LIMIT) {
          const more = U.el(`<button class="cm-loadmore">加载更多评论</button>`);
          more.addEventListener('click', loadMore);
          root.appendChild(more);
        } else {
          done = true;
        }
      } catch (e) {
        if (btn) { btn.textContent = api.explain(e); btn.disabled = false; }
      } finally {
        loading = false;
      }
    }

    loadMore();
    return root;
  }

  function commentNode(c, threadId) {
    const node = U.el(`<div class="cm-item">
      <img class="cm-avatar" loading="lazy" src="${U.esc(global.ne.img(U.cover(c.user?.avatar, 80)))}" alt="">
      <div class="cm-body">
        <div class="cm-top">
          <span class="cm-user"${c.user?.id ? ` data-uid="${c.user.id}" title="查看 TA 的主页"` : ''}>${U.esc(c.user?.name || '匿名用户')}</span>
          ${c.user?.vip ? '<span class="cm-vip">VIP</span>' : ''}
          <span class="cm-time">${U.esc(U.fmtRelative(c.time))}</span>
        </div>
        <div class="cm-text">${U.esc(c.content)}</div>
        ${c.replied ? `<div class="cm-reply"><b>@${U.esc(c.replied.user || '')}：</b>${U.esc(c.replied.content)}</div>` : ''}
        <div class="cm-foot">
          <span class="cm-like${c.liked ? ' on' : ''}" role="button" tabindex="0" title="${c.liked ? '取消点赞' : '点赞'}">${icon(c.liked ? ICON.heart : ICON.heartOutline, 12)}<span>${c.likedCount || ''}</span></span>
        </div>
      </div>
    </div>`);

    // 昵称：点进用户主页。原来这里是个光秃秃的 <span>，没有任何监听，点了没反应。
    // 评论页其实是全屏播放页里的一层（openComments 会先 toggleNowPlaying(true)
    // 再切到评论 Tab），所以跳转前得先把它收起来；否则用户页渲染在它背后，
    // 看上去还是「点了没反应」。
    const name = node.querySelector('.cm-user');
    if (name && c.user?.id) {
      name.addEventListener('click', () => {
        if (store.nowPlayingOpen) App.toggleNowPlaying(false);
        App.go('user', { id: c.user.id, name: c.user.name });
      });
    }

    // 点赞：乐观更新 + 失败回滚 + 如实提示。
    //
    // 之所以要回滚，是因为当前账号的「点赞」被网易云账号级风控门挡着
    // （weapi / App / eapi 三种方言一律回 250 点赞异常，歌曲喜欢回 524 环境异常），
    // 客户端绕不过去。所以这里绝不能假装成功：先按用户的意图把心点亮，等服务端
    // 真回 200 才留下；回 250 就把心还原、数字还原，并告诉用户真实原因。
    // 「取消点赞」是通的，所以点过赞的评论能正常取消。
    const like = node.querySelector('.cm-like');
    if (like) {
      const count = like.querySelector('span');
      const paint = (liked, n) => {
        like.classList.toggle('on', liked);
        like.title = liked ? '取消点赞' : '点赞';
        // 心形图标必须作为「元素」塞回去，不能传字符串：replaceWith('<svg…>')
        // 插入的是一个文本节点，SVG 源码会原样显示在评论下方（那段红色代码
        // 就是这么来的）。这里直接重建 [图标, 数字] 两个子节点，顺带把已经
        // 产生的文本节点清干净。
        like.textContent = '';
        like.append(U.el(icon(liked ? ICON.heart : ICON.heartOutline, 12)), count);
        count.textContent = n || '';
      };
      const baseCount = c.likedCount || 0;
      const baseLiked = !!c.liked;
      let busy = false;

      const onLike = async () => {
        if (busy) return;
        busy = true;
        const want = !like.classList.contains('on');
        // 乐观更新：立刻给出反馈，数字先按 ±1 走
        paint(want, Math.max(0, baseCount + (want === baseLiked ? 0 : (want ? 1 : -1))));
        like.classList.add('busy');
        try {
          const r = await svc.commentLike(threadId, c.id, want);
          if (r && r.ok) {
            // 以服务端返回为准，避免和别的端点的计数漂移
            c.liked = want;
            c.likedCount = Math.max(0, baseCount + (want === baseLiked ? 0 : (want ? 1 : -1)));
            paint(want, c.likedCount);
          } else {
            paint(baseLiked, baseCount);
            U.toastErr((r && r.message) || '操作失败');
          }
        } catch (e) {
          paint(baseLiked, baseCount);
          U.toastErr(api.explain(e));
        } finally {
          busy = false;
          like.classList.remove('busy');
        }
      };

      like.addEventListener('click', onLike);
      like.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onLike(); }
      });
    }

    return node;
  }

  // ============================================================
  //  本机歌曲（「已下载音乐」页的数据）
  // ============================================================
  /**
   * 本地索引里只有 `songId -> 文件路径`，歌名 / 歌手 / 封面一概没有 —— 因为写索引的
   * 是扫描器，它只认文件名和标签。要把这一页画成能读、能播的歌曲行，必须拿 id 回
   * 接口补齐（m01537 第②点：用户报的「扫描能扫出来但不显示」根因不在这里，但补齐
   * 是让扫描结果真的出现在界面上的必要一步）。
   *
   * 缓存放在会话里：歌曲详情基本不变，而进出这一页很频繁，每次都重打一遍接口会
   * 明显卡一下。取不到的（下架 / 需要会员 / 接口抽风）用文件名兜底 —— 列表里宁可
   * 显示一行「某歌手 - 某歌」，也不能整行空白或者干脆少一首。
   */
  const dlSongCache = new Map();

  function songFromFileName(entry) {
    const base = String(entry.name || '').replace(/\.[a-z0-9]+$/i, '');
    const cut = base.indexOf(' - ');
    return {
      id: entry.id,
      name: cut > 0 ? base.slice(cut + 3) : base,
      // id 给 0：TrackList 只把有 id 的歌手渲染成链接，0 会退化成纯文本 ——
      // 编一个不存在的歌手 id 点进去就是 404。
      artists: cut > 0 ? [{ id: 0, name: base.slice(0, cut) }] : [{ id: 0, name: '未知歌手' }],
      album: { id: 0, name: '', cover: null },
      duration: 0,
      cover: null,
      alias: [],
    };
  }

  async function songsFromLocalEntries(entries) {
    const byId = new Map();
    const need = [];
    for (const e of entries) {
      const hit = dlSongCache.get(e.id);
      if (hit) byId.set(e.id, hit);
      else need.push(e.id);
    }
    // 200 一批：songDetail 走 `?ids=[...]`，一次上千个 id 会把 URL 撑爆
    for (let i = 0; i < need.length; i += 200) {
      try {
        const got = await svc.songDetail(need.slice(i, i + 200));
        for (const s of got || []) {
          if (s && s.id) { dlSongCache.set(s.id, s); byId.set(s.id, s); }
        }
      } catch { /* 这一批取不到就全部走文件名兜底 */ }
    }
    return entries.map((e) => byId.get(e.id) || songFromFileName(e));
  }

  // ============================================================
  //  页面
  // ============================================================

  const views = {
    // ---------------- 音乐云盘 ----------------
    /**
     * 音乐云盘（用户 m05071 第④点）。
     *
     * 数据只有一条 `/api/cloud/get`（见 endpoints.cloudSongs），列表就是云盘里
     * 用户上传的歌。这里**只读**：上传/删除都不做，云盘里是用户自己的音频，
     * 一个误触就可能删掉原文件，代价远大于「少一个按钮」的方便。
     *
     * 头部用 `.daily-head` 那套现成样式（日期块 + 文案 + 播放全部），和每日推荐
     * 长得一致，不额外加 CSS；统计里给「已用 / 总容量」，这两项只有云盘接口
     * 会回（`size` / `maxSize`）。
     */
    async cloud(root) {
      if (!store.loggedIn) {
        root.innerHTML = `<div class="page">${emptyState('登录后查看音乐云盘', '云盘里是你上传到网易云的音乐，登录后就能在这里播放')}</div>`;
        const btn = U.el('<button class="btn-primary" style="width:180px;margin:0 auto;display:block">立即登录</button>');
        btn.addEventListener('click', () => App.openLogin());
        root.querySelector('.empty').appendChild(btn);
        return;
      }

      root.innerHTML = `<div class="page">
        <div class="page-head"><div class="page-title">音乐云盘</div></div>
        ${skeletonTracks(8)}
      </div>`;

      try {
        const d = await svc.cloudSongs(500, 0);
        const songs = d.songs || [];
        const badge = document.getElementById('cloudCount');
        if (badge) badge.textContent = d.count ? U.fmtCount(d.count) : '';

        const used = U.fmtSize(d.size || 0);
        const total = d.maxSize ? U.fmtSize(d.maxSize) : '';
        const count = d.count || songs.length;
        // 和「已下载音乐」页同一套口径：共 n 首 · 云盘占用 a / b（用户 m05942 第③点）
        const sub = `共 ${count} 首 · 云盘占用 ${used}${total ? ` / ${total}` : ''}`;

        // 右上角搜索、下方上传条（用户 m05718）。搜索是**在已经取回来的列表里过滤**，
        // 不再打接口：云盘一次最多也就几千首，本地过滤即时出结果，也不会因为
        // 关键词被当成搜索歌名而跑到「搜索页」去。
        root.querySelector('.page').innerHTML = `
          <div class="page-head cloud-head">
            <div class="page-title">音乐云盘</div>
            <button class="btn-outline cloud-search-btn" id="cloudSearchBtn" title="在云盘里搜索">${icon(ICON.search, 16)}<span>搜索</span></button>
          </div>
          <div class="daily-head">
            <div class="daily-date">
              <div class="daily-day">${songs.length ? d.count || songs.length : '—'}</div>
              <div class="daily-mon">首 · 云盘</div>
            </div>
            <div class="daily-txt">
              <h2>你上传到云端的音乐</h2>
              <p>${U.esc(sub)}</p>
            </div>
            <div class="cloud-actions">
              <span class="cloud-up-state" id="cloudUploadText"></span>
              <button class="btn-play-all" id="cloudPlayAll"${songs.length ? '' : ' disabled'}>${icon(ICON.play, 14)}播放全部</button>
              <button class="btn-outline cloud-upload-btn" id="cloudUploadBtn" title="选择本地音频上传到云盘">${icon(ICON.upload, 15)}<span>上传</span></button>
            </div>
          </div>
          <!-- 搜索栏在大框框下面一行（用户 m05942 第⑤点）：点右上角「搜索」才展开 -->
          <div class="cloud-search" id="cloudSearchWrap" hidden>
            <input class="cloud-search-input" id="cloudSearchInput" type="text" placeholder="在云盘里搜索歌名 / 歌手 / 专辑" autocomplete="off" spellcheck="false">
            <span class="cloud-search-count" id="cloudSearchCount"></span>
          </div>
          <div id="cloudList"></div>`;

        const listBox = root.querySelector('#cloudList');
        const playAll = root.querySelector('#cloudPlayAll');

        /** 把一组歌画进列表；空的时候给一句能看懂的空态。 */
        const paint = (list) => {
          listBox.innerHTML = '';
          if (!list.length) {
            listBox.innerHTML = songs.length
              ? emptyState('没有匹配的歌', '换个关键词试试，也可以清空搜索框看全部')
              : emptyState('云盘是空的', '点下面的「上传到云盘」把本机的歌传上去');
          } else {
            listBox.appendChild(
              TrackList(list, { context: { id: 'cloud', name: '音乐云盘' } })
            );
          }
          playAll.disabled = !list.length;
        };

        paint(songs);
        playAll.addEventListener('click', () => {
          const list = root.querySelector('#cloudList .tl-row') ? songs : [];
          if (list.length) player.playList(list, 0, { id: 'cloud', name: '音乐云盘' });
        });

        // ---------------- 搜索（右上角） ----------------
        const searchBtn = root.querySelector('#cloudSearchBtn');
        const searchWrap = root.querySelector('#cloudSearchWrap');
        const searchInput = root.querySelector('#cloudSearchInput');
        const searchCount = root.querySelector('#cloudSearchCount');

        /** 按关键词过滤：歌名 / 歌手 / 专辑，「不分大小写」。 */
        const applyFilter = () => {
          const q = searchInput.value.trim().toLowerCase();
          if (!q) {
            searchCount.textContent = '';
            paint(songs);
            return;
          }
          const hit = songs.filter((s) => {
            const album = s.album && typeof s.album === 'object' ? s.album.name || '' : s.album || '';
            const hay = `${s.name || ''} ${(s.artists || []).map((a) => a.name).join(' ')} ${album}`.toLowerCase();
            return hay.includes(q);
          });
          searchCount.textContent = `${hit.length} / ${songs.length}`;
          paint(hit);
        };

        searchBtn.addEventListener('click', () => {
          const open = searchWrap.hidden;
          searchWrap.hidden = !open;
          searchBtn.classList.toggle('on', open);
          if (open) searchInput.focus();
          else {
            searchInput.value = '';
            applyFilter();
          }
        });
        searchInput.addEventListener('input', applyFilter);
        searchInput.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') searchBtn.click();
        });

        // ---------------- 上传（大框框最右侧，m06183 第①点） ----------------
        const upBtn = root.querySelector('#cloudUploadBtn');
        const upText = root.querySelector('#cloudUploadText');
        const alive = () => document.body.contains(upText);

        const unsub = global.ne.cloud && global.ne.cloud.onProgress
          ? global.ne.cloud.onProgress((p) => {
              if (!alive()) return;
              const prefix = p.count > 1 ? `（${p.index + 1}/${p.count}）` : '';
              if (p.stage === 'check') upText.textContent = `${prefix}正在校验 ${p.name}…`;
              else if (p.stage === 'token') upText.textContent = `${prefix}正在准备上传 ${p.name}…`;
              else if (p.stage === 'upload') {
                const pct = p.total ? Math.round((p.sent / p.total) * 100) : 0;
                upText.textContent = `${prefix}正在上传 ${p.name}${pct ? ` ${pct}%` : ''}…`;
              } else if (p.stage === 'finalize') upText.textContent = `${prefix}正在入库 ${p.name}…`;
            })
          : null;

        upBtn.addEventListener('click', async () => {
          if (!global.ne.cloud) return;
          upBtn.disabled = true;
          const oldLabel = upBtn.innerHTML;
          upBtn.innerHTML = `${icon(ICON.upload, 14)}<span>上传中…</span>`;
          try {
            const r = await global.ne.cloud.upload();
            if (r.canceled) {
              upText.textContent = '';
            } else if (!r.ok) {
              upText.textContent = '';
              U.toast(r.error || '上传失败');
            } else {
              const ok = (r.added || []).length;
              const bad = (r.failed || []).length;
              const skip = r.skipped || 0;
              // 云盘里「标题 + 歌手」都一样的歌不再重复上传（用户 m05942 第②点）
              if (skip) U.toast(`有 ${skip} 首歌在云盘歌单中已存在，上传时已跳过`);
              else U.toast(bad ? `已上传 ${ok} 首，失败 ${bad} 首` : `已上传 ${ok} 首`);
              if (bad) {
                upText.textContent = `${bad} 首失败：${r.failed.map((f) => `${f.name}（${f.message}）`).join('；')}`;
              }
              // 传完自动刷新云盘界面（m06183 第④点）。云盘列表接口有缓存，
              // 新传的歌偶尔要一两秒才出现，所以过一会儿再补刷一次。
              if (ok || skip) {
                unsub && unsub();
                await views.cloud(root);
                setTimeout(() => {
                  if (globalThis.store.route.name === 'cloud') views.cloud(root);
                }, 1500);
                return;
              }
            }
          } catch (e) {
            U.toast('上传失败：' + ((e && e.message) || e));
          }
          upBtn.disabled = false;
          upBtn.innerHTML = oldLabel;
        });
      } catch (e) {
        root.querySelector('.page').innerHTML = `<div class="page-head"><div class="page-title">音乐云盘</div></div>${emptyState('音乐云盘加载失败', api.explain(e))}`;
      }
    },

    // ---------------- 每日推荐 ----------------
    async daily(root) {
      if (!store.loggedIn) {
        root.innerHTML = `<div class="page">${emptyState('登录后查看每日推荐', '每日推荐会根据你的口味生成 30 首歌曲')}</div>`;
        const btn = U.el('<button class="btn-primary" style="width:180px;margin:0 auto;display:block">立即登录</button>');
        btn.addEventListener('click', () => App.openLogin());
        root.querySelector('.empty').appendChild(btn);
        return;
      }

      root.innerHTML = `<div class="page">
        <div class="page-head"><div class="page-title">每日推荐</div></div>
        ${skeletonTracks(10)}
      </div>`;

      try {
        const d = await svc.dailyRecommend();
        const now = new Date();
        const days = ['日', '一', '二', '三', '四', '五', '六'];
        root.querySelector('.page').innerHTML = `
          <div class="page-head"><div class="page-title">每日推荐</div></div>
          <div class="daily-head">
            <div class="daily-date">
              <div class="daily-day">${now.getDate()}</div>
              <div class="daily-mon">${now.getMonth() + 1}月 · 周${days[now.getDay()]}</div>
            </div>
            <div class="daily-txt">
              <h2>根据你的口味生成</h2>
              <p>${d.reason ? U.esc(d.reason) : `每天 6:00 更新，为你推荐 ${d.songs.length} 首歌曲`}</p>
            </div>
            <button class="btn-play-all" id="dPlayAll">${icon(ICON.play, 14)}播放全部</button>
          </div>
          <div id="dList"></div>`;

        const list = TrackList(d.songs, { context: { id: 'daily', name: '每日推荐' } });
        root.querySelector('#dList').appendChild(list);
        root.querySelector('#dPlayAll').addEventListener('click', () => {
          player.playList(d.songs, 0, { id: 'daily', name: '每日推荐' });
        });
      } catch (e) {
        root.querySelector('.page').innerHTML = `<div class="page-head"><div class="page-title">每日推荐</div></div>` +
          emptyState('每日推荐加载失败', api.explain(e));
      }
    },

    // ---------------- 推荐歌单 ----------------
    async radio(root) {
      root.innerHTML = `<div class="page">
        <div class="page-head"><div class="page-title">推荐歌单</div><div class="page-sub">根据你的口味挑选</div></div>
        ${skeletonGrid(12)}
      </div>`;
      try {
        const list = await svc.recommendPlaylists();
        root.querySelector('.page').innerHTML = `<div class="page-head"><div class="page-title">推荐歌单</div><div class="page-sub">根据你的口味挑选</div></div>`;
        const grid = U.el('<div class="grid"></div>');
        list.forEach((p) => grid.appendChild(playlistCard(p)));
        root.querySelector('.page').appendChild(grid);
      } catch (e) {
        root.querySelector('.page').innerHTML = `<div class="page-head"><div class="page-title">推荐歌单</div></div>` +
          emptyState('加载失败', api.explain(e));
      }
    },

    // ---------------- 榜单 ----------------
    async charts(root) {
      root.innerHTML = `<div class="page">
        <div class="page-head"><div class="page-title">榜单</div><div class="page-sub">实时更新的官方排行榜</div></div>
        ${skeletonGrid(12)}
      </div>`;
      try {
        const list = await svc.toplists();
        const page = root.querySelector('.page');
        page.innerHTML = `<div class="page-head">
          <div class="page-title">榜单</div>
          <div class="page-sub">共 ${list.length} 个榜单，点击查看</div>
        </div>`;
        const grid = U.el('<div class="grid"></div>');
        list.forEach((t) => grid.appendChild(chartCard(t)));
        page.appendChild(grid);
      } catch (e) {
        root.querySelector('.page').innerHTML = `<div class="page-head"><div class="page-title">榜单</div></div>` +
          emptyState('榜单加载失败', api.explain(e));
      }
    },

    // ---------------- 播客 ----------------
    async podcast(root) {
      root.innerHTML = `<div class="page">
        <div class="page-head"><div class="page-title">播客</div><div class="page-sub">精选电台节目</div></div>
        ${skeletonGrid(12)}
      </div>`;
      try {
        const list = await svc.podcasts(30);
        const page = root.querySelector('.page');
        page.innerHTML = `<div class="page-head">
          <div class="page-title">播客</div>
          <div class="page-sub">共 ${list.length} 个电台，点击进入</div>
        </div>`;
        if (!list.length) {
          page.innerHTML += emptyState('暂时没有推荐的播客');
          return;
        }
        const grid = U.el('<div class="grid"></div>');
        list.forEach((r) => grid.appendChild(radioCard(r)));
        page.appendChild(grid);
      } catch (e) {
        root.querySelector('.page').innerHTML = `<div class="page-head"><div class="page-title">播客</div></div>` +
          emptyState('播客加载失败', api.explain(e));
      }
    },

    // ---------------- 电台详情（节目列表） ----------------
    async podcastDetail(root, params) {
      root.innerHTML = `<div class="page">${skeletonTracks(10)}</div>`;
      try {
        const d = await svc.podcastPrograms(params.id, 60, 0);
        const radio = d.radio || { name: params.name || '播客', cover: '', desc: '', programCount: 0, subCount: 0, dj: null };
        const songs = d.programs.map((p) => p.song).filter(Boolean);

        root.innerHTML = `<div class="page">
          <div class="pl-head">
            <div class="pl-cover"><img src="${U.esc(global.ne.img(U.cover(radio.cover, 400)))}" alt=""></div>
            <div class="pl-info">
              <div class="pl-tag">${icon(ICON.podcast, 11)}播客</div>
              <div class="pl-name">${U.esc(radio.name)}</div>
              ${radio.dj ? `<div class="pl-creator">
                <img src="${U.esc(global.ne.img(U.cover(radio.dj.avatar, 60)))}" alt="">
                <span class="pl-cname" data-uid="${radio.dj.id}">${U.esc(radio.dj.name)}</span>
                <span class="pl-time">主播</span>
              </div>` : ''}
              ${radio.desc ? `<div class="pl-desc">${U.esc(radio.desc)}</div>` : ''}
              <div class="pl-stats">
                <span><b>${d.count || radio.programCount || songs.length}</b> 期节目</span>
                ${radio.subCount ? `<span>订阅 <b>${U.fmtCount(radio.subCount)}</b></span>` : ''}
              </div>
              <div class="pl-actions">
                <button class="btn-play-all" id="pdPlayAll">${icon(ICON.play, 14)}播放全部</button>
              </div>
            </div>
          </div>
          <div id="pdTracks"></div>
        </div>`;

        const desc = root.querySelector('.pl-desc');
        if (desc) desc.addEventListener('click', () => desc.classList.toggle('open'));

        if (!songs.length) {
          root.querySelector('#pdTracks').innerHTML = emptyState('这个电台还没有节目');
          root.querySelector('#pdPlayAll').disabled = true;
          return;
        }

        const list = TrackList(songs, { context: { id: 'podcast:' + radio.id, name: radio.name } });
        root.querySelector('#pdTracks').appendChild(list);
        root.querySelector('#pdPlayAll').addEventListener('click', () => {
          player.playList(songs, 0, { id: 'podcast:' + radio.id, name: radio.name });
        });
      } catch (e) {
        root.querySelector('.page').innerHTML =
          `<div class="page-head"><div class="page-title">${U.esc(params.name || '播客')}</div></div>` +
          emptyState('节目加载失败', api.explain(e));
      }
    },

    // ---------------- 我喜欢的音乐 ----------------
    async liked(root) {
      if (!store.loggedIn) {
        root.innerHTML = `<div class="page">${emptyState('登录后查看我喜欢的音乐')}</div>`;
        return;
      }
      // The library may still be in flight when this page is opened directly
      // (deep link, or a session restored from disk), so give it one chance.
      if (!store.liked && store.uid) await App.loadLibrary();
      const pid = store.liked?.id;
      if (!pid) { root.innerHTML = `<div class="page">${emptyState('未找到我喜欢的音乐歌单')}</div>`; return; }
      return views.playlist(root, { id: pid, name: '我喜欢的音乐' });
    },

    // ---------------- 歌单详情 ----------------
    async playlist(root, params) {
      root.innerHTML = `<div class="page">${skeletonTracks(12)}</div>`;
      try {
        const pl = await svc.playlistTracks(params.id, 0);
        const isLiked = pl.specialType === 5 || (store.liked && pl.id === store.liked.id);

        // 创建者后面显示创建时间（第 10 点）。老歌单可能没有 createTime，
        // 那就退回 updateTime 并标成「更新」，至少不显示一个 1970 年。
        const plTimeText = pl.createTime
          ? `${U.fmtDate(pl.createTime)} 创建`
          : (pl.updateTime ? `${U.fmtDate(pl.updateTime)} 更新` : '');

        root.innerHTML = `<div class="page">
          <div class="pl-head">
            <div class="pl-cover"><img src="${U.esc(global.ne.img(U.cover(pl.cover, 400)))}" alt=""></div>
            <div class="pl-info">
              <div class="pl-tag">${icon(isLiked ? ICON.heart : ICON.radio, 11)}${isLiked ? '我喜欢的音乐' : '歌单'}</div>
              <div class="pl-name">${U.esc(pl.name)}</div>
              ${pl.creator ? `<div class="pl-creator">
                <img src="${U.esc(global.ne.img(U.cover(pl.creator.avatar, 60)))}" alt="">
                <span class="pl-cname" data-uid="${pl.creator.id}">${U.esc(pl.creator.name)}</span>
                ${plTimeText ? `<span class="pl-time">${plTimeText}</span>` : ''}
              </div>` : ''}
              ${pl.description ? `<div class="pl-desc">${U.esc(pl.description)}</div>` : ''}
              <div class="pl-stats">
                <span><b>${pl.trackCount}</b> 首</span>
                ${pl.playCount ? `<span>播放 <b>${U.fmtCount(pl.playCount)}</b></span>` : ''}
              </div>
              <div class="pl-actions">
                <button class="btn-play-all" id="plPlayAll">${icon(ICON.play, 14)}播放全部</button>
                <button class="btn-outline" id="plShuffle">${icon(ICON.shuffle, 14)}随机播放</button>
                ${!isLiked ? `<button class="btn-outline${pl.subscribed ? ' on' : ''}" id="plSub">${icon(pl.subscribed ? ICON.minus : ICON.add, 14)}${pl.subscribed ? '取消收藏' : '收藏歌单'}</button>` : ''}
                <button class="btn-outline pl-multi" id="plMulti" title="多选歌曲，批量移动 / 删除 / 添加 / 下载">${icon(ICON.checkAll, 14)}多选</button>
              </div>
            </div>
          </div>
          <div id="plTracks"></div>
        </div>`;

        const desc = root.querySelector('.pl-desc');
        if (desc) desc.addEventListener('click', () => desc.classList.toggle('open'));

        // 先拿到按钮再建列表：列表的回调里要用它（进入/退出多选时跟着高亮），
        // 而 const 有暂时性死区，放后面会让回调捕获到一个还没初始化的绑定。
        const multiBtn = root.querySelector('#plMulti');

        const list = TrackList(pl.tracks, {
          context: { id: pl.id, name: pl.name },
          playlistId: isLiked ? pl.id : (pl.subscribed ? null : pl.id),
          // 「移动到」「从歌单删除」要改歌单内容，只有自己的歌单能改。
          // 我喜欢的音乐 specialType=5、没有 subscribed 字段，单独放行。
          canRemove: isLiked || !pl.subscribed,
          // 只有歌单页能多选：这里的每一行都属于同一个歌单，批量操作才有明确
          // 语义（移动到哪个歌单、从哪个歌单删除）。搜索 / 专辑页的列表是流式
          // 结果，批量删改没有目标。
          selectable: true,
          onSelectModeChange: (on) => multiBtn.classList.toggle('on', on),
          onSelectAction: (act, picked, trackRoot) => {
            App.onTrackSelectAction(act, picked, {
              playlistId: isLiked ? pl.id : (pl.subscribed ? null : pl.id),
              isLiked,
              list: trackRoot,
            });
          },
        });
        root.querySelector('#plTracks').appendChild(list);

        multiBtn.addEventListener('click', () => {
          if (list._getSelectMode()) list._exitSelect();
          else list._enterSelect();
        });

        // 本地扫描按钮已按用户要求搬到「已下载音乐」页（m00001 第③点）：
        // 扫描是「本机有哪些歌」的全局动作，挂在某一个歌单的头部会让人以为
        // 它只对这个歌单生效。这里不再保留第二个入口。

        root.querySelector('#plPlayAll').addEventListener('click', () => {
          player.playList(pl.tracks, 0, { id: pl.id, name: pl.name });
        });
        root.querySelector('#plShuffle').addEventListener('click', () => {
          // 用户对「随机播放」的期待是"这个歌单从随机的一首开始放"，所以这里
          // 自己洗一份副本再交给 player —— 不依赖 player 的 SHUFFLE 模式，
          // 免得点一下按钮顺手把循环模式也改掉（第 7 点）。
          const shuffled = pl.tracks.slice().sort(() => Math.random() - 0.5);
          player.playList(shuffled, 0, { id: pl.id, name: pl.name });
        });
        const subBtn = root.querySelector('#plSub');
        if (subBtn) {
          subBtn.addEventListener('click', async () => {
            const want = !pl.subscribed;
            subBtn.disabled = true;
            try {
              await api.raw('subscribePlaylist', pl.id, want);
              pl.subscribed = want;
              U.toastOk(want ? '已收藏歌单' : '已取消收藏');
              // 左侧栏「收藏的歌单」读的是 store.playlists，而它是 30s 缓存；
              // 歌单页自己的 subscribed 也来自 pltracks 缓存。不主动失效的话，
              // 收藏完切回侧栏还是旧列表（用户报的「收藏后没显示」），
              // 歌单页的按钮也不会从「收藏歌单」翻成「取消收藏」。
              api.invalidate('playlists:');
              api.invalidate('pltracks:');
              api.invalidate('pl:');
              await App.loadLibrary();
              App.reload();
            } catch (e) {
              U.toastErr(api.explain(e));
              subBtn.disabled = false;
            }
          });
        }
        const cname = root.querySelector('.pl-cname');
        if (cname) cname.addEventListener('click', () => App.go('user', { id: Number(cname.dataset.uid) }));

        // 兜底：万一 main 侧没能补全（例如接口临时抽风），这里再要一次。
        // 判据用 pl.complete 而不是 tracks.length < trackCount —— 补全成功时
        // 两者相等，用后者的话这个分支永远进不来（原来就是这么写的，等于没有
        // 兜底）。main 侧的 playlistTracks 已经幂等且会缓存，重复调用不亏。
        if (pl.complete === false) {
          svc.playlistTracks(pl.id, pl.trackCount).then((full) => {
            if (!full || !full.tracks || full.tracks.length <= pl.tracks.length) return;
            const box = root.querySelector('#plTracks');
            if (!box) return;
            box.innerHTML = '';
            box.appendChild(TrackList(full.tracks, {
              context: { id: full.id, name: full.name },
              playlistId: isLiked ? full.id : (full.subscribed ? null : full.id),
              canRemove: isLiked || !full.subscribed,
              selectable: true,
              onSelectModeChange: (on) => {
                const b = root.querySelector('#plMulti');
                if (b) b.classList.toggle('on', on);
              },
              onSelectAction: (act, picked, trackRoot) => {
                App.onTrackSelectAction(act, picked, {
                  playlistId: isLiked ? full.id : (full.subscribed ? null : full.id),
                  isLiked,
                  list: trackRoot,
                });
              },
            }));
          }).catch(() => {});
        }
      } catch (e) {
        root.innerHTML = `<div class="page">${emptyState('歌单加载失败', api.explain(e))}</div>`;
      }
    },

    // ---------------- 歌手 ----------------
    // 歌手页同时也是「用户页」：头部有头像 / 统计 / 关注按钮，下方三个 tab。
    async artist(root, params) {
      const id = params.id;
      root.innerHTML = `<div class="page">${skeletonTracks(10)}</div>`;
      try {
        const [detail, songs] = await Promise.all([
          svc.artistDetail(id).catch(() => null),
          svc.artistSongs(id, 50, 0),
        ]);
        const name = (detail && detail.name) || params.name || '';
        const avatar = (detail && detail.avatar) || songs[0]?.cover || '';
        const alias = (detail && detail.alias) || [];

        root.innerHTML = `<div class="page">
          <div class="artist-head">
            <img class="artist-avatar" src="${U.esc(global.ne.img(U.cover(avatar, 300)))}" alt="">
            <div class="artist-meta">
              <h1>${U.esc(name)}</h1>
              ${alias.length ? `<div class="am-alias">${U.esc(alias.join(' / '))}</div>` : ''}
              <div class="am-stats">
                <span>歌曲 <b>${detail ? detail.musicSize : songs.length}</b></span>
                <span>专辑 <b>${detail ? detail.albumSize : '-'}</b></span>
                <span>MV <b>${detail ? detail.mvSize : '-'}</b></span>
              </div>
              <div class="am-actions">
                <button class="btn-play-all" id="arPlayAll">${icon(ICON.play, 14)}播放热门</button>
                ${store.loggedIn ? `<button class="btn-outline" id="arFollow"></button>` : ''}
              </div>
            </div>
          </div>
          <div class="search-tabs" id="arTabs">
            <a class="search-tab active" data-arttab="songs">热门歌曲</a>
            <a class="search-tab" data-arttab="all">全部歌曲</a>
            <a class="search-tab" data-arttab="albums">专辑</a>
            <a class="search-tab" data-arttab="desc">歌手简介</a>
          </div>
          <div id="arPane"></div>
        </div>`;

        const pane = root.querySelector('#arPane');

        const renderSongs = () => {
          pane.innerHTML = '';
          if (!songs.length) { pane.innerHTML = emptyState('暂无歌曲'); return; }
          pane.appendChild(TrackList(songs, { context: { id: 'artist:' + id, name } }));
        };

        /* 「全部歌曲」页签（本轮第②点）：热门只给 50 首，作品多的歌手
           （动辄上千首）在这一页翻得到底。一页 100 首，剩下的点「加载更多」——
           一次把 2500 首全拉回来要发 26 个请求、写 2500 行 DOM，进页面就卡住。 */
        const ALL_PAGE = 100;
        let allSongs = [];
        let allTotal = detail ? (detail.musicSize || 0) : 0;
        let allMore = true;
        let allBusy = false;

        const paintAll = () => {
          pane.innerHTML = '';
          if (!allSongs.length) { pane.innerHTML = emptyState('暂无歌曲'); return; }
          pane.appendChild(U.el(`<div class="page-sub">共 ${U.fmtCount(allTotal || allSongs.length)} 首，已加载 ${allSongs.length} 首</div>`));
          pane.appendChild(TrackList(allSongs, { context: { id: 'artist:' + id, name } }));
          if (allMore) {
            const btn = U.el(`<button class="cm-loadmore">加载更多（已 ${allSongs.length} / 共 ${U.fmtCount(allTotal || '?')} 首）</button>`);
            btn.addEventListener('click', loadMoreAll);
            pane.appendChild(btn);
          }
        };

        const loadMoreAll = async () => {
          if (allBusy) return;
          allBusy = true;
          try {
            const r = await svc.artistAllSongs(id, ALL_PAGE, allSongs.length);
            // 服务端偶尔会重复给同一首（翻页边界），按 id 去重再追加，
            // 否则 TrackList 里会出现两行一样的歌、播放下标也跟着错位。
            const seen = new Set(allSongs.map((s) => s.id));
            allSongs = allSongs.concat(r.songs.filter((s) => !seen.has(s.id)));
            if (r.total) allTotal = r.total;
            allMore = r.more;
            paintAll();
          } catch (e) {
            U.toast('加载失败：' + api.explain(e));
          } finally {
            allBusy = false;
          }
        };

        const renderAllSongs = async () => {
          if (allSongs.length) { paintAll(); return; }
          pane.innerHTML = `<div class="page-sub">加载中…</div>`;
          try {
            const r = await svc.artistAllSongs(id, ALL_PAGE, 0);
            allSongs = r.songs;
            if (r.total) allTotal = r.total;
            allMore = r.more;
            paintAll();
          } catch (e) {
            pane.innerHTML = emptyState('歌曲加载失败', api.explain(e));
          }
        };

        const renderAlbums = async () => {
          pane.innerHTML = `<div class="grid">${skeletonGrid(8)}</div>`;
          try {
            const r = await svc.artistAlbums(id, 50, 0);
            if (!r.albums.length) { pane.innerHTML = emptyState('暂无专辑'); return; }
            pane.innerHTML = '<div class="grid" id="arAlbumGrid"></div>';
            const g = pane.querySelector('#arAlbumGrid');
            r.albums.forEach((a) => g.appendChild(albumCard(a)));
          } catch (e) {
            pane.innerHTML = emptyState('专辑加载失败', api.explain(e));
          }
        };

        const renderDesc = async () => {
          pane.innerHTML = `<div class="page-sub">加载中…</div>`;
          try {
            const d = await svc.artistDesc(id);
            const has = d.briefDesc || d.expertises.length;
            pane.innerHTML = has ? `
              ${d.expertises.length ? `<div class="ad-tags">${d.expertises.map((e) =>
                `<span class="ad-tag">${U.esc(e.name)} <b>${e.count}</b></span>`).join('')}</div>` : ''}
              ${d.briefDesc ? `<div class="ad-desc">${U.esc(d.briefDesc).replace(/\n/g, '<br>')}</div>`
                : emptyState('暂无简介')}
            ` : emptyState('暂无简介');
          } catch (e) {
            pane.innerHTML = emptyState('简介加载失败', api.explain(e));
          }
        };

        const panes = { songs: renderSongs, all: renderAllSongs, albums: renderAlbums, desc: renderDesc };
        for (const tab of root.querySelectorAll('[data-arttab]')) {
          tab.addEventListener('click', () => {
            root.querySelectorAll('[data-arttab]').forEach((t) =>
              t.classList.toggle('active', t === tab));
            panes[tab.dataset.arttab]();
          });
        }

        root.querySelector('#arPlayAll').addEventListener('click', () => {
          if (!songs.length) { U.toast('这位歌手还没有可播放的歌曲'); return; }
          player.playList(songs, 0, { id: 'artist:' + id, name });
        });

        // 关注按钮：歌手不是用户，所以「自己」这一判断不适用，登录后一律显示
        const fbtn = root.querySelector('#arFollow');
        if (fbtn && detail) {
          const syncFollow = (on) => {
            fbtn.classList.toggle('on', on);
            fbtn.innerHTML = on ? '已关注' : '关注';
          };
          syncFollow(detail.followed);
          fbtn.addEventListener('click', () => {
            followClick({
              btn: fbtn,
              want: !fbtn.classList.contains('on'),
              call: (w) => svc.artistSub(id, w),
              sync: syncFollow,
              okMsg: (w) => (w ? '已关注 ' + name : '已取消关注'),
            });
          });
        }

        renderSongs();
      } catch (e) {
        root.innerHTML = `<div class="page">${emptyState('歌手信息加载失败', api.explain(e))}</div>`;
      }
    },

    // ---------------- 专辑 ----------------
    async album(root, params) {
      root.innerHTML = `<div class="page">${skeletonTracks(10)}</div>`;
      try {
        const al = await svc.album(params.id);
        root.innerHTML = `<div class="page">
          <div class="pl-head">
            <div class="pl-cover"><img src="${U.esc(global.ne.img(U.cover(al.cover, 400)))}" alt=""></div>
            <div class="pl-info">
              <div class="pl-tag">${icon(ICON.album, 11)}专辑</div>
              <div class="pl-name">${U.esc(al.name)}</div>
              <div class="pl-creator">
                <span class="pl-cname" data-artist="${al.songs?.[0]?.artists?.[0]?.id || ''}">${U.esc(al.artist || '')}</span>
                ${al.publishTime ? `<span class="pl-time">${U.fmtDate(al.publishTime)} 发行</span>` : ''}
              </div>
              ${al.description ? `<div class="pl-desc">${U.esc(al.description)}</div>` : ''}
              <div class="pl-stats"><span><b>${al.songs.length}</b> 首</span></div>
              <div class="pl-actions">
                <button class="btn-play-all" id="alPlayAll">${icon(ICON.play, 14)}播放全部</button>
              </div>
            </div>
          </div>
          <div id="alList"></div>
        </div>`;
        root.querySelector('#alList').appendChild(TrackList(al.songs, {
          context: { id: 'album:' + al.id, name: al.name },
        }));
        root.querySelector('#alPlayAll').addEventListener('click', () => {
          player.playList(al.songs, 0, { id: 'album:' + al.id, name: al.name });
        });
        const c = root.querySelector('.pl-cname');
        if (c && c.dataset.artist) {
          c.addEventListener('click', () => App.go('artist', { id: Number(c.dataset.artist), name: c.textContent }));
        }
      } catch (e) {
        root.innerHTML = `<div class="page">${emptyState('专辑加载失败', api.explain(e))}</div>`;
      }
    },

    // ---------------- 搜索 ----------------
    async search(root, params) {
      const kw = params.kw;
      const type = Number(params.type || 1);
      root.innerHTML = `<div class="page">
        <div class="page-head"><div class="page-title">搜索「${U.esc(kw)}」</div></div>
        ${skeletonTracks(10)}
      </div>`;
      try {
        const r = await svc.search(kw, type, 40, 0);
        const tabs = [
          { t: 1, label: '歌曲', n: r.count },
          { t: 1000, label: '歌单' },
          { t: 100, label: '歌手' },
          { t: 10, label: '专辑' },
          // 用户（m03593 第②点）：加了这一栏才能搜到人 —— 原来只能搜歌/歌单/歌手/专辑，
          // 用户想找某个人的主页没有任何入口。
          { t: 1002, label: '用户' },
        ];
        root.querySelector('.page').innerHTML = `
          <div class="page-head"><div class="page-title">搜索「${U.esc(kw)}」</div></div>
          <div class="search-tabs">
            ${tabs.map((x) => `<button class="search-tab${x.t === type ? ' active' : ''}" data-t="${x.t}">${x.label}${x.t === type && r.count ? ` <span style="color:var(--text-3)">${U.fmtCount(r.count)}</span>` : ''}</button>`).join('')}
          </div>
          <div id="sResult"></div>`;

        for (const b of root.querySelectorAll('.search-tab')) {
          b.addEventListener('click', () => App.go('search', { kw, type: Number(b.dataset.t) }));
        }

        const box = root.querySelector('#sResult');
        if (type === 1) {
          if (!r.songs.length) box.innerHTML = emptyState('没有找到相关歌曲');
          else box.appendChild(TrackList(r.songs, { context: { id: 'search:' + kw, name: '搜索：' + kw } }));
        } else if (type === 1000) {
          if (!r.playlists.length) box.innerHTML = emptyState('没有找到相关歌单');
          else {
            const g = U.el('<div class="grid"></div>');
            r.playlists.forEach((p) => g.appendChild(playlistCard(p)));
            box.appendChild(g);
          }
        } else if (type === 100) {
          if (!r.artists.length) box.innerHTML = emptyState('没有找到相关歌手');
          else {
            const g = U.el('<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(130px,1fr))"></div>');
            r.artists.forEach((a) => g.appendChild(artistCard(a)));
            box.appendChild(g);
          }
        } else if (type === 1002) {
          if (!r.users.length) box.innerHTML = emptyState('没有找到相关用户');
          else {
            // 和「关注 / 粉丝」列表同一个卡片（`userCard`），点进去就是个人主页。
            const g = U.el('<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(220px,1fr))"></div>');
            r.users.forEach((u) => g.appendChild(userCard(u)));
            box.appendChild(g);
          }
        } else {
          if (!r.albums.length) box.innerHTML = emptyState('没有找到相关专辑');
          else {
            const g = U.el('<div class="grid"></div>');
            r.albums.forEach((a) => g.appendChild(albumCard(a)));
            box.appendChild(g);
          }
        }
      } catch (e) {
        root.querySelector('.page').innerHTML = `<div class="page-head"><div class="page-title">搜索「${U.esc(kw)}」</div></div>` +
          emptyState('搜索失败', api.explain(e));
      }
    },

    // ---------------- 最近播放 ----------------
    // 服务端的 /api/v1/play/record 是按「播放次数」排名的榜单，响应里没有
    // 任何时间戳，做不出真正的时间序 —— 所以这里用本机记录（store.recent，
    // 由 player 在每次成功开播时写入），名字才名副其实。
    async recent(root) {
      const head = '<div class="page-head"><div class="page-title">最近播放</div></div>';

      const render = () => {
        const items = store.recent || [];
        if (!items.length) {
          root.querySelector('.page').innerHTML = head +
            emptyState('还没有播放记录', '听几首歌之后这里就会有内容');
          return;
        }
        const songs = items.map((x) => x.song);
        root.querySelector('.page').innerHTML = `
          <div class="page-head">
            <div class="page-title">最近播放</div>
            <div class="page-sub">按播放时间倒序，共 ${items.length} 首（仅记录本机播放）</div>
          </div>
          <div class="daily-head">
            <div class="daily-txt">
              <h2>最近常听</h2>
              <p>这里记录你在本客户端播放过的歌曲，最新播放的排在最前</p>
            </div>
            <button class="btn-play-all" id="rPlayAll">${icon(ICON.play, 14)}播放全部</button>
            <button class="btn-outline" id="rClear">清空记录</button>
          </div>
          <div id="rList"></div>`;
        root.querySelector('#rList').appendChild(
          TrackList(songs, { context: { id: 'recent', name: '最近播放' } }));
        root.querySelector('#rPlayAll').addEventListener('click', () => {
          player.playList(songs, 0, { id: 'recent', name: '最近播放' });
        });
        root.querySelector('#rClear').addEventListener('click', () => {
          if (!confirm('确定清空本机播放记录吗？')) return;
          store.clearRecent();
        });
      };

      root.innerHTML = `<div class="page">${head}${skeletonTracks(10)}</div>`;
      render();

      // 清空 / 新播放时局部重绘，不必重走路由
      if (this._recentOff) this._recentOff();
      this._recentOff = store.on('recent:changed', () => {
        if (store.route && store.route.name === 'recent') render();
      });
    },

    // ---------------- 已下载音乐（m36690 第⑤点） ----------------
    /**
     * 下载情况原来挤在底栏「播放队列」按钮的第二片页签里 —— 那个位置只有主动
     * 点开队列才看得见，而下没下完是随时想知道的。第⑤点把它整体搬成侧栏
     * 「我的音乐」下的一个独立页。
     *
     * 数据有两份，各管一段：
     *   · 任务记录（下过什么、成功没有）来自主进程的 download 队列，它现在会把
     *     已结束的任务写进 `<userData>/download-history.json`，所以重启后这一页
     *     不是空的；
     *   · 「本机真的有这个文件」以本地索引为准 —— 历史里写着「已完成」但文件被
     *     用户删了的情况，靠索引这一层才不会误报。
     */
    /**
     * 已下载音乐（m01537 第①②点重写）。
     *
     * 这一页以前画的是**下载任务**：排队中、百分比、失败全在里面，而真正的「本机
     * 有哪些歌」只写在主进程的索引里，页面根本不读它 —— 所以本地扫描明明扫到了歌，
     * 界面上却什么都不出现。现在数据源换成索引：
     *   · 列表 = `local.entries()`，只列真实存在、真能播的文件；
     *   · 排序 = 文件修改时间从新到旧（下载完成那一刻就是它的 mtime）；
     *   · 「正在下载」搬到侧栏独立页，这里不再混进度条。
     * 同时按第①点去掉顶部的「清除记录」按钮：那条记录已经没有意义 —— 完成的歌以
     * 索引为准，删掉文件就从列表里消失，不需要再手工清理历史。
     */
    async downloads(root) {
      root.innerHTML = `<div class="page">
        <div class="page-head">
          <div class="page-title">已下载音乐</div>
          <div class="page-sub" id="dlSub"></div>
        </div>
        <div class="daily-head">
          <div class="daily-txt">
            <h2>本机已有的歌</h2>
            <p id="dlNote"></p>
          </div>
          <button class="btn-play-all" id="dlPlayAll" disabled>${icon(ICON.play, 14)}播放全部</button>
          <button class="btn-outline" id="dlScan" title="选一个文件夹，按文件名/标签把本机已有的歌匹配进来">${icon(ICON.folder, 14)}本地扫描</button>
          <button class="btn-outline" id="dlClearIndex" title="清空本机歌曲索引，不会删除任何音频文件">清除索引</button>
        </div>
        <div class="qp-list dl-page" id="dlLocal"></div>
      </div>`;

      const note = root.querySelector('#dlNote');
      const sub = root.querySelector('#dlSub');
      const listBox = root.querySelector('#dlLocal');
      const playAll = root.querySelector('#dlPlayAll');
      let current = [];   // 当前画出来的歌曲：播放全部直接用这份，省一次接口
      let seq = 0;        // 并发保护：慢的那次回来时不许覆盖新的

      const paint = async () => {
        const my = ++seq;
        let entries = [];
        try { entries = (await global.ne.local.entries()) || []; } catch { entries = []; }
        // 拿到本机的时间从新到旧。索引里没存下载时间，文件 mtime 是最接近的替代：
        // 下载完成的那一刻才落盘，那一刻就是 mtime。
        entries.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
        if (my !== seq) return;

        const info = store.localInfo || { count: entries.length, dirs: [] };
        const dir = (info.dirs && info.dirs[0]) || '';
        // 侧栏角标跟着这一页走：索引里有文件被删过时，`info().count` 要等主进程
        // 下一次推事件才更新，这里直接按刚数出来的条数对齐，避免「角标 398、
        // 列表 30 首」这种对不上。
        if (info.count !== entries.length) {
          store.localInfo = { ...info, count: entries.length };
          App.paintDlCount();
        }
        note.textContent = entries.length
          ? `本机索引里 ${entries.length} 首歌${dir ? `（来自 ${dir}）` : ''}，最近下载的排在前面`
          : '还没有本机歌曲。点右边的「本地扫描」选一个文件夹，或在歌曲菜单里选「下载」。';
        if (sub) sub.textContent = entries.length ? `共 ${entries.length} 首` : '';

        listBox.innerHTML = '';
        if (!entries.length) {
          current = [];
          playAll.disabled = true;
          listBox.innerHTML = '<div class="qp-empty">这里还没有歌。下载完成的歌、以及本地扫描匹配到的歌，都会出现在这里。</div>';
          return;
        }
        const songs = await songsFromLocalEntries(entries);
        if (my !== seq) return;
        current = songs;
        // 交给 TrackList：行高、序号、悬浮播放、右键菜单、本地 √ 都和别的页一致
        listBox.appendChild(TrackList(songs, { context: { id: 'downloads', name: '已下载音乐' } }));
        playAll.disabled = false;
      };

      await paint();

      playAll.addEventListener('click', () => {
        if (!current.length) { U.toast('还没有下载好的歌'); return; }
        player.playList(current, 0, { id: 'downloads', name: '已下载音乐' });
      });

      // 「本地扫描」（m00001 第③点搬到这里）：它扫的是「本机有哪些歌」，本来就不
      // 属于某一个歌单。歌曲字典由 App 汇总（最近播放 + 看过的列表 + 下载记录），
      // 否则只拿下载记录去匹配，会把从别处扫进来的歌全判成「不认识」。
      root.querySelector('#dlScan').addEventListener('click', async () => {
        const btn = root.querySelector('#dlScan');
        btn.disabled = true;
        App.showScanProgress('正在准备歌曲字典…');
        try {
          let dict = App.scanDictionary();
          // 尽量把「我喜欢的音乐」也补进字典：没打开过那个歌单时它一首都不在
          // store 里，而用户最常扫的恰恰是整个音乐库。
          if (store.liked && store.liked.id) {
            try {
              const liked = await svc.playlistTracks(store.liked.id, 0);
              if (liked && liked.tracks) dict = dict.concat(liked.tracks);
            } catch { /* 取不到就用手头这份，别让扫描失败 */ }
          }
          const r = await global.ne.local.choose(dict);
          if (r && r.canceled) return;
          if (!r || !r.ok) { U.toastErr((r && r.error) || '扫描失败'); return; }
          // 扫完立刻重画：索引变了，列表就得跟着变（不等 IPC 那条路）
          await paint();
          if (r.matched) U.toastOk(`扫描 ${r.files} 个文件，匹配到 ${r.matched} 首`);
          else U.toast(`扫描 ${r.files} 个文件，没匹配到索引里的歌`);
        } catch (e) {
          U.toastErr('扫描失败');
        } finally {
          App.hideScanProgress();
          if (btn) btn.disabled = false;
        }
      });

      // 「清除索引」（m00001 第③点）：只清「哪些歌本机有」的匹配表，不动任何音频
      // 文件。放在「本地扫描」右边，误点概率和破坏力都最低。
      root.querySelector('#dlClearIndex').addEventListener('click', async () => {
        if (!confirm('确定清除本地歌曲索引吗？\n\n只会清空「本机有哪些歌」的匹配记录，不会删除任何音频文件。')) return;
        try {
          await global.ne.local.forget();
          dlSongCache.clear();
          await paint();
          U.toast('已清除本地索引');
        } catch { U.toastErr('清除失败'); }
      });

      // 索引在别处变了（刚下完一首、在歌单页扫了一次）也要跟着重画
      if (this._dlLocalOff) this._dlLocalOff();
      this._dlLocalOff = store.on('local:changed', () => {
        if (store.route && store.route.name === 'downloads') paint();
      });
    },

    /**
     * 正在下载（m01537 第①点）：安卓端侧栏本来就有这一栏，电脑端照抄过来。
     *
     * 列表交给 `App.renderDownloads` 画（它订阅 `download:list`）：进度每 200ms 刷
     * 一次，视图里再画一遍就会出现两条互相覆盖的渲染路径。
     */
    async downloading(root) {
      root.innerHTML = `<div class="page">
        <div class="page-head">
          <div class="page-title">正在下载</div>
          <div class="page-sub" id="dlqSub"></div>
        </div>
        <div class="daily-head">
          <div class="daily-txt">
            <h2>下载队列</h2>
          </div>
          <button class="btn-outline" id="dlqToggle" hidden>全部暂停</button>
          <button class="btn-outline" id="dlqClear" hidden title="停掉全部任务，并删掉它们的半截文件">清空</button>
        </div>
        <div class="qp-list dl-page" id="dlList"></div>
      </div>`;
      // 队列非空时才出现（m02003 第②点）：空队列上摆着「全部开始 / 清空」两个
      // 点不动的按钮只会让人以为坏了。显隐与文案由 `App.renderDownloads` 每次
      // 刷新时同步 —— 它才是唯一知道任务状态的地方。
      const toggle = root.querySelector('#dlqToggle');
      const clear = root.querySelector('#dlqClear');
      toggle.addEventListener('click', async () => {
        // 有在跑 / 在等的就「全部暂停」，否则「全部开始」：一颗按钮管两个方向，
        // 和播放器那颗「播放 / 暂停」同一套习惯，不用先看清列表再决定按哪个。
        const list = App._dlTasks || [];
        const busy = list.some((t) => t.state === 'running' || t.state === 'queued');
        toggle.disabled = true;
        try {
          if (busy) await global.ne.download.pauseAll();
          else await global.ne.download.resumeAll();
        } finally {
          toggle.disabled = false;
        }
      });
      clear.addEventListener('click', async () => {
        const list = App._dlTasks || [];
        if (!list.length) return;
        // 清空会连带删掉半截文件，先问一句 —— 但只在真有东西可删时问
        if (!confirm(`清空下载列表？${list.length} 个任务会被取消，未下完的半截文件一并删除。`)) return;
        clear.disabled = true;
        try {
          await global.ne.download.clearAll();
        } finally {
          clear.disabled = false;
        }
      });
      try {
        App.renderDownloads(await global.ne.download.list());
      } catch {
        App.renderDownloads(App._dlTasks || []);
      }
    },
    // ---------------- 用户主页 ----------------
    async user(root, params) {
      const uid = params.id;
      root.innerHTML = `<div class="page">${skeletonGrid(8)}</div>`;
      try {
        // 资料与歌单互不依赖，一起发出去省一轮往返
        const [d, r] = await Promise.all([
          svc.userDetail(uid),
          svc.userPlaylists(uid),
        ]);

        const pls = (r.playlists || []).filter((p) => p.specialType !== 5);
        const self = store.uid && Number(store.uid) === Number(uid);
        const genderTxt = d.gender === 1 ? '男' : d.gender === 2 ? '女' : '';
        const meta = [];
        if (genderTxt) meta.push(genderTxt);
        // `city` comes back as a numeric code (510100), not a name — printing it
        // raw looks like a bug, so it is left out.
        if (d.createTime) meta.push(U.fmtDate(d.createTime) + ' 加入');

        root.querySelector('.page').innerHTML = `
          <div class="user-head">
            <div class="uh-bg"${d.background ? ` style="background-image:url('${U.esc(global.ne.img(U.cover(d.background, 1000)))}')"` : ''}></div>
            <div class="uh-body">
              <div class="uh-avatar">
                <img src="${U.esc(global.ne.img(U.cover(d.avatar, 200)))}" alt="">
              </div>
              <div class="uh-info">
                <div class="uh-toprow">
                  <div class="uh-main">
                    <div class="uh-name">
                      <span class="uh-nick">${U.esc(d.nickname || '未知用户')}</span>
                      ${d.vipType ? `<span class="uh-vip-tag">VIP</span>` : ''}
                    </div>
                    ${meta.length ? `<div class="uh-meta">${meta.join(' · ')}</div>` : ''}
                    ${d.signature ? `<div class="uh-sign">${U.esc(d.signature)}</div>` : ''}
                  </div>
                  <div class="uh-stats">
                    <button class="uh-stat" data-stat="follows"><b>${d.follows}</b><span>关注</span></button>
                    <button class="uh-stat" data-stat="followeds"><b>${d.followeds}</b><span>粉丝</span></button>
                    <button class="uh-stat" data-stat="level"><b>${d.level || '-'}</b><span>等级</span></button>
                    <button class="uh-stat" data-stat="listen"><b>${d.listenSongs ? U.fmtCount(d.listenSongs) : '-'}</b><span>听歌</span></button>
                    <div class="uh-stat static"><b>${pls.length}</b><span>歌单</span></div>
                  </div>
                  ${self ? `<div class="uh-actions">
                    <button class="btn-outline${d.pcSign ? ' done' : ''}" id="uhSign"${d.pcSign ? ' disabled' : ''}>${d.pcSign ? '今日已签到' : '每日签到'}</button>
                  </div>` : (store.loggedIn ? `<div class="uh-actions">
                    <button class="btn-outline${d.followed ? ' on' : ''}" id="uhFollow">${d.followed ? '已关注' : '关注'}</button>
                  </div>` : '')}
                </div>
              </div>
            </div>
          </div>
          <div class="section-head" style="margin-top:22px">
            <div class="section-title">${self ? '我的歌单' : 'TA 的歌单'}</div>
          </div>
          <div id="uhGrid"></div>`;

        const grid = U.el('<div class="grid"></div>');
        if (!pls.length) {
          root.querySelector('#uhGrid').innerHTML = emptyState('还没有公开的歌单');
        } else {
          pls.forEach((p) => grid.appendChild(playlistCard(p)));
          root.querySelector('#uhGrid').appendChild(grid);
        }

        // 关注 / 粉丝 / 等级 / 听歌 四项都可点进详情
        const statGo = {
          follows: () => App.go('userlist', { id: uid, kind: 'follows', name: d.nickname || '' }),
          followeds: () => App.go('userlist', { id: uid, kind: 'followeds', name: d.nickname || '' }),
          level: () => App.go('userlevel', { id: uid, name: d.nickname || '' }),
          listen: () => App.go('playrank', { id: uid, name: d.nickname || '' }),
        };
        for (const b of root.querySelectorAll('.uh-stat[data-stat]')) {
          const fn = statGo[b.dataset.stat];
          if (fn) b.addEventListener('click', fn);
        }

        if (self) {
          const btn = root.querySelector('#uhSign');
          if (btn) btn.addEventListener('click', () => App.doCheckin(btn));
        } else {
          // 他人主页：关注 / 已关注
          const fbtn = root.querySelector('#uhFollow');
          if (fbtn) {
            fbtn.addEventListener('click', () => {
              followClick({
                btn: fbtn,
                want: !fbtn.classList.contains('on'),
                call: (w) => svc.userFollow(uid, w),
                sync: (on) => {
                  fbtn.classList.toggle('on', on);
                  fbtn.textContent = on ? '已关注' : '关注';
                },
                okMsg: (w) => (w ? '已关注 ' + (d.nickname || '') : '已取消关注'),
              });
            });
          }
        }
      } catch (e) {
        root.innerHTML = `<div class="page">${emptyState('用户主页加载失败', api.explain(e))}</div>`;
      }
    },

    // ---------------- 关注 / 粉丝列表 ----------------
    async userlist(root, params) {
      const uid = params.id;
      const isFollows = params.kind !== 'followeds';
      const title = (params.name ? params.name + ' 的' : '') + (isFollows ? '关注' : '粉丝');
      root.innerHTML = `<div class="page">
        <div class="page-head"><div class="page-title">${U.esc(title)}</div></div>
        ${skeletonGrid(8)}
      </div>`;
      try {
        const r = isFollows ? await svc.follows(uid, 60, 0) : await svc.followeds(uid, 60, 0);
        const users = r.users || [];
        root.querySelector('.page').innerHTML = `
          <div class="page-head">
            <div class="page-title">${U.esc(title)}</div>
            <div class="page-sub">共 ${U.fmtCount(r.total || users.length)} 人${r.more ? '，仅显示前 ' + users.length + ' 位' : ''}</div>
          </div>
          <div id="ulGrid"></div>`;
        if (!users.length) {
          root.querySelector('#ulGrid').innerHTML = emptyState(isFollows ? '还没有关注任何人' : '还没有粉丝');
          return;
        }
        const g = U.el('<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(180px,1fr))"></div>');
        users.forEach((u) => g.appendChild(userCard(u)));
        root.querySelector('#ulGrid').appendChild(g);
      } catch (e) {
        root.querySelector('.page').innerHTML =
          `<div class="page-head"><div class="page-title">${U.esc(title)}</div></div>` +
          emptyState('加载失败', api.explain(e));
      }
    },

    // ---------------- 等级详情 ----------------
    async userlevel(root, params) {
      const uid = params.id;
      root.innerHTML = `<div class="page">${skeletonTracks(6)}</div>`;
      try {
        const [lv, d] = await Promise.all([
          svc.userLevel(uid),
          svc.userDetail(uid).catch(() => ({})),
        ]);
        const pct = Math.max(0, Math.min(100, Math.round((lv.progress || 0) * 100)));
        // nextPlayCount / nextLoginCount are 0 once the level is maxed out, and
        // "0 / 0 首" reads like a bug — show a bare count in that case.
        const pair = (now, next, unit) => (next ? `${now} / ${next} ${unit}` : `${now} ${unit}`);
        root.querySelector('.page').innerHTML = `
          <div class="page-head">
            <div class="page-title">${U.esc((params.name || d.nickname || '') + ' 的等级')}</div>
          </div>
          <div class="daily-head">
            <div class="daily-date">
              <div class="daily-day">${lv.level || d.level || '-'}</div>
              <div class="daily-mon">等级</div>
            </div>
            <div class="daily-txt">
              <h2>听歌等级 Lv.${lv.level || d.level || '-'}</h2>
              <p>${U.esc(lv.info || '听歌越多，等级越高')}</p>
            </div>
          </div>
          <div class="lv-bar"><div class="lv-bar-fill" style="width:${pct}%"></div></div>
          <div class="lv-rows">
            <div class="lv-row"><span>本周已听</span><b>${pair(lv.nowPlayCount, lv.nextPlayCount, '首')}</b></div>
            <div class="lv-row"><span>本周已登录</span><b>${pair(lv.nowLoginCount, lv.nextLoginCount, '天')}</b></div>
            <div class="lv-row"><span>累计听歌</span><b>${d.listenSongs ? U.fmtCount(d.listenSongs) : '-'} 首</b></div>
          </div>`;
      } catch (e) {
        root.innerHTML = `<div class="page">${emptyState('等级加载失败', api.explain(e))}</div>`;
      }
    },

    // ---------------- 播放排行（服务端听歌记录，按播放次数） ----------------
    async playrank(root, params) {
      const uid = params.id;
      root.innerHTML = `<div class="page">
        <div class="page-head"><div class="page-title">${U.esc((params.name || '') + ' 的听歌排行')}</div></div>
        ${skeletonTracks(10)}
      </div>`;
      try {
        const r = await svc.playRecord(uid, 0);
        const songs = r.songs || [];
        root.querySelector('.page').innerHTML = `
          <div class="page-head">
            <div class="page-title">${U.esc((params.name || '') + ' 的听歌排行')}</div>
            <div class="page-sub">按播放次数排序，共 ${songs.length} 首</div>
          </div>
          <div id="prList"></div>`;
        if (!songs.length) {
          root.querySelector('#prList').innerHTML = emptyState('还没有听歌记录');
          return;
        }
        const list = TrackList(songs, { context: { id: 'playrank:' + uid, name: '听歌排行' } });
        root.querySelector('#prList').appendChild(list);
      } catch (e) {
        root.querySelector('.page').innerHTML =
          `<div class="page-head"><div class="page-title">听歌排行</div></div>` +
          emptyState('加载失败', api.explain(e));
      }
    },
  };

  global.views = views;
  global.TrackList = TrackList;
  global.CommentList = CommentList;
  global.ICON = ICON;
  global.icons = icon;
  global.uiHelpers = { skeletonTracks, skeletonGrid, emptyState, playlistCard, artistCard, albumCard, chartCard, radioCard, userCard };
})(window);
