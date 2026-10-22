/* ============================================================
   悬浮小窗（竖版 v / 横版 h）
   ------------------------------------------------------------
   这个页面不播放音频：它只负责
     1) 把主窗口推来的状态画出来（ne.mini.onState）
     2) 把用户操作打包成命令发回主窗口（ne.mini.cmd）
   歌词复用主窗口的 Lrc.LyricView，滚动/高亮/自动居中逻辑完全一致。
   ============================================================ */
(function (global) {
  'use strict';

  const ne = global.ne || {};
  const mini = ne.mini || {};
  const U = global.U || {};

  const $ = (id) => document.getElementById(id);

  /* ---------------------------------------------------------- 兼容层
     契约经历过一次小改版：早期只有 ne.isMini / {type:'seek'} / {type:'repeat'}
     / {type:'go'}，现在 preload 暴露的是 ne.miniMode / {type:'seekRatio'} /
     {type:'cycleRepeat'} / {type:'openArtist'|'openAlbum'}。
     两个都认，按 preload 是否暴露 miniMode 自动选一套词汇，避免发出去的命令
     在主窗口那边落空。 */
  const MODERN = typeof ne.miniMode === 'string';
  const MODE = (ne.miniMode === 'h' || ne.isMini === 'h') ? 'h' : 'v';

  // 脚本在 </body> 前执行，body 已经解析出来了。这里同步打上 data-mode，
  // 否则横版会先按竖版布局画一帧再跳过去。
  if (document.body) document.body.dataset.mode = MODE;

  function send(payload) {
    if (payload && typeof mini.cmd === 'function') mini.cmd(payload);
  }
  function sendSeek(ratio) {
    const r = Math.min(1, Math.max(0, ratio || 0));
    // 主窗口的处理器读的是 msg.value（app.js:535），早期契约写的是 ratio。
    // 两个字段都带上，谁在对面都能拿到数。
    send(MODERN ? { type: 'seekRatio', ratio: r, value: r } : { type: 'seek', ratio: r, value: r });
  }
  function sendRepeatCycle() {
    // 小窗把「列表 / 单曲 / 随机」压成了一个按钮，所以要用三态轮换的 cycleAll
    // （app.js:543）；player.cycleRepeat() 只在 list/one 之间转，会把随机模式吃掉。
    send(MODERN ? { type: 'cycleAll' } : { type: 'repeat' });
  }
  function sendGo(route, id, name) {
    if (!id) return;
    send(MODERN
      ? { type: route === 'album' ? 'openAlbum' : 'openArtist', params: { id: id, name: name } }
      : { type: 'go', route: route, params: { id: id, name: name } });
    // 导航发生在主窗口，顺手把它叫到前面来
    if (typeof mini.focusMain === 'function') {
      const p = mini.focusMain();
      if (p && typeof p.catch === 'function') p.catch(function () {});
    }
  }
  function imgUrl(url, size) {
    if (!url) return '';
    const sized = (typeof U.cover === 'function') ? U.cover(url, size) : url;
    return (typeof ne.img === 'function') ? ne.img(sized) : sized;
  }
  const fmtTime = (typeof U.fmtTime === 'function') ? U.fmtTime : function (ms) {
    if (!ms || ms < 0 || !isFinite(ms)) return '00:00';
    const t = Math.floor(ms / 1000);
    return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
  };

  /* ---------------------------------------------------------- DOM 引用 */
  const card = $('miniCard');
  const headEl = $('miniHead');
  const coverImg = $('miniCoverImg');
  const titleEl = $('miniTitle');
  const artistEl = $('miniArtist');
  const albumEl = $('miniAlbum');
  const closeBtn = $('miniClose');

  const lyricScroll = $('miniLyricScroll');
  const lyricList = $('miniLyricList');
  const lyricEmpty = $('miniLyricEmpty');

  const curEl = $('miniCur');
  const durEl = $('miniDur');
  const progressEl = $('miniProgress');
  const progressFill = $('miniProgressFill');
  const progressKnob = $('miniProgressKnob');

  const controlsEl = $('miniControls');
  const repeatBtn = $('miniRepeat');
  const iconRepeatList = $('miniIconRepeatList');
  const iconRepeatOne = $('miniIconRepeatOne');
  const iconShuffle = $('miniIconShuffle');
  const prevBtn = $('miniPrev');
  const playBtn = $('miniPlay');
  const iconPlay = $('miniIconPlay');
  const iconPause = $('miniIconPause');
  const nextBtn = $('miniNext');
  const likeBtn = $('miniLike');
  const iconHeart = $('miniIconHeart');
  const iconHeartOn = $('miniIconHeartOn');
  const queueBtn = $('miniQueueBtn');

  const queueEl = $('miniQueue');
  const queueCountEl = $('miniQueueCount');
  const queueCloseBtn = $('miniQueueClose');
  const queueListEl = $('miniQueueList');

  /* ---------------------------------------------------------- 状态 */
  const REPEAT_ORDER = ['list', 'one', 'shuffle'];
  const REPEAT_TITLE = { list: '列表循环', one: '单曲循环', shuffle: '随机播放' };

  const state = {
    song: null,
    paused: true,
    position: 0,
    duration: 0,
    repeat: 'list',
    liked: false,
    queueLen: 0
  };

  let queue = [];
  let queueIndex = -1;
  let queueOpen = false;
  let queueClosing = null;   // 队列出场动画进行中的 { finish, timer }

  let progressDragging = false;
  let progressRatio = 0;

  let dragActive = false;

  let lastSongId = 0;
  let lastLyricKey = null;
  let lastTrackKey = null;

  let lyricView = null;

  const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : 0;

  /* ---------------------------------------------------------- 歌词 */
  function lyricKeyOf(raw) {
    if (!raw) return null;
    return String(raw.lrc || '') + '\u0001' + String(raw.tlyric || '');
  }

  function applyLyrics(song, rawLyric) {
    if (!lyricView) return;
    const songId = song ? num(song.id) : 0;

    if (!song) {
      if (lastSongId !== 0) {
        lastSongId = 0;
        lastLyricKey = null;
        lyricView.set(null);   // 清掉上一首的残影
        lyricView.reset();
      }
      return;
    }

    if (songId !== lastSongId) {
      // 换歌：歌词可能还没到，先按“有没有”渲染，到了再补
      lastSongId = songId;
      lastLyricKey = null;
      lyricView.set(rawLyric || null);
      lastLyricKey = lyricKeyOf(rawLyric);
      return;
    }

    if (!rawLyric) return;
    const key = lyricKeyOf(rawLyric);
    if (key !== lastLyricKey) {
      lastLyricKey = key;
      lyricView.set(rawLyric);
    }
  }

  /* ---------------------------------------------------------- 渲染：曲目 */
  function renderCover(song) {
    const src = song ? imgUrl(song.cover, 200) : '';
    if (src) coverImg.src = src;
    else coverImg.removeAttribute('src');
  }

  function renderArtists(song) {
    artistEl.textContent = '';
    if (!song) {
      const span = document.createElement('span');
      span.className = 'mini-muted';
      span.textContent = '—';
      artistEl.appendChild(span);
      return;
    }
    const list = Array.isArray(song.artists)
      ? song.artists.filter((a) => a && a.name)
      : [];

    if (!list.length) {
      // 没有 artists 数组就退化成纯文本，不可点
      artistEl.textContent = song.artistText || '未知歌手';
      return;
    }
    list.forEach((a, i) => {
      if (i) artistEl.appendChild(document.createTextNode(' / '));
      if (a.id) {
        const link = document.createElement('a');
        link.className = 'mini-link';
        link.textContent = a.name;
        link.title = a.name;
        link.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          sendGo('artist', a.id, a.name);
        });
        artistEl.appendChild(link);
      } else {
        // id 为 0：只显示文字，不做成链接
        const span = document.createElement('span');
        span.textContent = a.name;
        artistEl.appendChild(span);
      }
    });
  }

  function renderAlbum(song) {
    const album = song && song.album;
    if (album && album.name) {
      albumEl.textContent = album.name;
      albumEl.title = album.name;
      albumEl.dataset.id = album.id ? String(album.id) : '';
      albumEl.dataset.name = album.name;
      albumEl.classList.toggle('off', !album.id);
    } else {
      albumEl.textContent = '';
      albumEl.removeAttribute('title');
      albumEl.dataset.id = '';
      albumEl.dataset.name = '';
      albumEl.classList.add('off');
    }
  }

  /* 头部只在"曲目真的换了"时重建：state 每秒推好几次，
     每次都重排 artistEl 的 <a> 会让链接在鼠标下反复被替换。 */
  function trackKeyOf(song) {
    if (!song) return '';
    const album = song.album || {};
    const artists = Array.isArray(song.artists)
      ? song.artists.map((a) => ((a && a.id) || 0) + ':' + ((a && a.name) || '')).join('|')
      : '';
    return [num(song.id), song.name || '', song.artistText || '', song.cover || '',
            album.id || 0, album.name || '', artists].join('\u0001');
  }

  function renderTrack() {
    const song = state.song;
    const key = trackKeyOf(song);

    if (key !== lastTrackKey) {
      lastTrackKey = key;
      renderCover(song);
      titleEl.textContent = song ? (song.name || '未知歌曲') : '未在播放';
      titleEl.title = titleEl.textContent;
      renderArtists(song);
      renderAlbum(song);
    }

    // 没歌时歌词区给一块“未在播放”占位，而不是留着上一首的残影
    lyricScroll.hidden = !song;
    lyricEmpty.hidden = !!song;

    controlsEl.classList.toggle('is-off', !song);
  }

  /* ---------------------------------------------------------- 渲染：按钮 */
  /**
   * 图标都是 <svg>，而 `hidden` 是 HTMLElement 的 IDL 属性，SVGElement 上没有。
   * 直接写 `svg.hidden = true` 只会在 JS 对象上挂一个同名的扩展属性，DOM 上的
   * hidden 特性原封不动 —— 表现就是「按钮有按下的反馈（.active / title 变了），
   * 图标却一直是原来那个」。必须走特性（attribute）这条路。
   */
  function setHidden(el, on) {
    if (!el) return;
    if (on) el.setAttribute('hidden', '');
    else el.removeAttribute('hidden');
  }

  function renderRepeat() {
    const r = REPEAT_ORDER.indexOf(state.repeat) >= 0 ? state.repeat : 'list';
    setHidden(iconRepeatList, r !== 'list');
    setHidden(iconRepeatOne, r !== 'one');
    setHidden(iconShuffle, r !== 'shuffle');
    repeatBtn.title = REPEAT_TITLE[r];
    repeatBtn.classList.toggle('active', r !== 'list');
  }

  function renderPlay() {
    setHidden(iconPlay, !state.paused);
    setHidden(iconPause, state.paused);
    playBtn.title = state.paused ? '播放' : '暂停';
  }

  function renderLike() {
    setHidden(iconHeart, state.liked);
    setHidden(iconHeartOn, !state.liked);
    likeBtn.classList.toggle('on', state.liked);
  }

  function renderButtons() {
    renderRepeat();
    renderPlay();
    renderLike();
  }

  /* ---------------------------------------------------------- 渲染：进度 */
  function duration() {
    return state.duration || (state.song ? num(state.song.duration) : 0);
  }

  function paintProgress(ratio) {
    const r = Math.min(1, Math.max(0, ratio || 0));
    const dur = duration();
    progressFill.style.width = (r * 100) + '%';
    progressKnob.style.left = (r * 100) + '%';
    curEl.textContent = fmtTime(r * dur);
    durEl.textContent = fmtTime(dur);
  }

  function renderProgress() {
    if (progressDragging) return;   // 拖动中不被推送覆盖
    const dur = duration();
    paintProgress(dur > 0 ? state.position / dur : 0);
  }

  function ratioFromEvent(e) {
    const rect = progressEl.getBoundingClientRect();
    if (!rect.width) return 0;
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  }

  /* ---------------------------------------------------------- 渲染：队列 */
  function renderQueue() {
    if (!queueListEl) return;
    queueListEl.innerHTML = '';
    if (queueCountEl) queueCountEl.textContent = String(queue.length || state.queueLen || 0);

    if (!queue.length) {
      const empty = document.createElement('div');
      empty.className = 'mini-queue-empty';
      empty.textContent = state.queueLen > 0 ? '队列载入中…' : '队列为空';
      queueListEl.appendChild(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    queue.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'mini-queue-item' + (i === queueIndex ? ' on' : '');

      const cov = document.createElement('div');
      cov.className = 'mini-queue-cover';
      const im = document.createElement('img');
      im.alt = '';
      im.loading = 'lazy';
      const src = imgUrl(item && item.cover, 80);
      if (src) im.src = src;
      cov.appendChild(im);

      const meta = document.createElement('div');
      meta.className = 'mini-queue-meta';
      const nm = document.createElement('div');
      nm.className = 'mini-queue-name';
      nm.textContent = (item && item.name) || '未知歌曲';
      const ar = document.createElement('div');
      ar.className = 'mini-queue-artist';
      ar.textContent = (item && item.artistText) || '';
      meta.appendChild(nm);
      meta.appendChild(ar);

      row.appendChild(cov);
      row.appendChild(meta);
      row.title = nm.textContent;
      row.addEventListener('click', () => {
        send({ type: 'playAt', index: i });
        setQueueOpen(false);
      });
      frag.appendChild(row);
    });
    queueListEl.appendChild(frag);
  }

  /** 收掉正在进行中的出场动画：拆监听、清定时器、摘掉 .is-closing。 */
  function cancelQueueClose() {
    if (!queueClosing) return;
    clearTimeout(queueClosing.timer);
    queueEl.removeEventListener('animationend', queueClosing.finish);
    queueEl.classList.remove('is-closing');
    queueClosing = null;
  }

  /**
   * 开关队列浮层。
   *
   * 打开是 CSS 的 `miniQueueIn` 入场动画（淡入 + 轻微上移）。关闭原来只是一句
   * `hidden = true`，浮层"啪"地消失，和入场不对称。这里补一段向下渐隐的出场
   * 动画：加 `.is-closing` 触发 `miniQueueOut`，等动画真跑完再把 hidden 挂上。
   *
   * 两个细节：
   *  1) 不能只等 `animationend` —— 设置里关掉动画后（`body.no-anim`，见
   *     settings.css）根本不会有动画事件，浮层就再也关不掉了。所以同时挂一个
   *     比动画时长略长的 `setTimeout` 兜底，谁先到谁生效。
   *  2) `.mini-card [hidden] { display:none !important }` 会直接掐掉动画，所以
   *     `hidden` 必须等动画结束才挂，中途不能被设回去。
   */
  function setQueueOpen(open) {
    const want = !!open;
    // 状态和 DOM 已经一致就什么都不用做（浮层正在出场时 hidden 还没挂上，所以
    // 判据要连 is-closing 一起看）
    if (queueEl && want === queueOpen && !queueEl.classList.contains('is-closing')
        && (queueEl.hidden === !want)) return;
    cancelQueueClose();

    if (!want && queueOpen && queueEl && !queueEl.hidden) {
      queueOpen = false;
      if (queueBtn) queueBtn.classList.remove('active');
      queueEl.classList.add('is-closing');
      // 出场收尾：animationend 和兜底定时器谁先到谁干活
      const finish = () => {
        cancelQueueClose();
        // 动画期间可能又被点开了，那就别关
        if (!queueOpen) queueEl.hidden = true;
      };
      queueEl.addEventListener('animationend', finish);
      queueClosing = { finish, timer: setTimeout(finish, 260) };
      return;
    }

    queueOpen = want;
    if (queueEl) {
      queueEl.classList.remove('is-closing');
      queueEl.hidden = !queueOpen;
    }
    if (queueBtn) queueBtn.classList.toggle('active', queueOpen);
    if (queueOpen) renderQueue();
  }

  /* ---------------------------------------------------------- 状态入口 */
  function applyState(raw) {
    if (!raw || typeof raw !== 'object') return;

    const song = raw.song || raw.track || null;
    // playing=true 表示正在播放；老契约给的是 paused
    const paused = (typeof raw.playing === 'boolean') ? !raw.playing : !!raw.paused;
    const position = num(raw.position != null ? raw.position : raw.time);

    let dur = num(raw.duration);
    if (!dur && song) dur = num(song.duration);
    if (!song) dur = 0;

    const repeat = REPEAT_ORDER.indexOf(raw.repeat) >= 0 ? raw.repeat : state.repeat;
    const rawLyric = raw.lyric || raw.lyrics || null;

    state.song = song;
    state.paused = paused;
    state.position = position;
    state.duration = dur;
    state.repeat = repeat;
    state.liked = !!raw.liked;
    state.queueLen = num(raw.queueLen);

    // 队列里当前曲目的高亮跟着 state 走（队列数据本身由 onQueue 推）
    if (song && queue.length) {
      const idx = queue.findIndex((it) => it && num(it.id) === num(song.id));
      if (idx >= 0 && idx !== queueIndex) {
        queueIndex = idx;
        if (queueOpen) renderQueue();
      }
    }

    renderTrack();
    renderButtons();
    renderProgress();
    applyLyrics(song, rawLyric);

    if (lyricView) lyricView.update(position);
  }

  /* ---------------------------------------------------------- 进度条拖拽 */
  function onProgressDown(e) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    progressDragging = true;
    progressEl.classList.add('dragging');
    try { progressEl.setPointerCapture(e.pointerId); } catch (_) { /* 忽略 */ }
    progressRatio = ratioFromEvent(e);
    paintProgress(progressRatio);
  }

  function onProgressMove(e) {
    if (!progressDragging) return;
    progressRatio = ratioFromEvent(e);
    paintProgress(progressRatio);
  }

  function onProgressUp(e) {
    if (!progressDragging) return;
    progressDragging = false;
    progressEl.classList.remove('dragging');
    try { progressEl.releasePointerCapture(e.pointerId); } catch (_) { /* 忽略 */ }
    paintProgress(progressRatio);   // 乐观：立刻停在松手位置
    sendSeek(progressRatio);
  }

  function onProgressCancel() {
    if (!progressDragging) return;
    progressDragging = false;
    progressEl.classList.remove('dragging');
    renderProgress();
  }

  /* ---------------------------------------------------------- 拖拽窗口
     窗口移动由主进程轮询系统光标完成，这里只负责通知开始 / 结束。 */
  function onDragDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // 按钮、链接、进度条上的按下不算拖窗口
    if (e.target.closest && e.target.closest('button, a, input, .mini-progress')) return;
    if (dragActive) return;
    dragActive = true;
    // 第 14 点：拖动期间窗口每移动一次都要重新合成整个透明表面，歌词的
    // mask 渐隐和发光阴影属于最贵的两笔，先摘掉，松手再装回来。
    document.body.classList.add('is-dragging');
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) { /* 忽略 */ }
    if (typeof mini.dragStart === 'function') mini.dragStart();
  }

  function onDragUp(e) {
    if (!dragActive) return;   // 防重复调用
    // lostpointercapture 在「按钮还按着」的时候也会触发（窗口移动、系统或别的
    // 元素把捕获抢走都算）。这时候拖动并没有结束，收工就变成"松手才走了几步
    // 窗口就不跟了"。真正的松手由 window 上的 pointerup 兜底，所以这里放行。
    if (e.type === 'lostpointercapture' && e.buttons) return;
    dragActive = false;
    document.body.classList.remove('is-dragging');
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (_) { /* 忽略 */ }
    if (typeof mini.dragEnd === 'function') mini.dragEnd();
  }

  /* ---------------------------------------------------------- 绑定 */
  function bind() {
    document.body.dataset.mode = MODE;

    // --- 歌词（复用主窗口的 LyricView，容器/列表与 index.html 同构）
    if (global.Lrc && global.Lrc.LyricView) {
      lyricView = new global.Lrc.LyricView(lyricScroll, lyricList);
    }
    // LyricView 在容器上冒泡派发 lyricseek，detail 是行时间(ms)
    card.addEventListener('lyricseek', (e) => {
      const t = e.detail;
      const dur = duration();
      if (typeof t !== 'number' || t < 0 || dur <= 0) return;
      sendSeek(t / dur);
    });

    // --- 头部：拖拽 + 可点链接
    headEl.addEventListener('pointerdown', onDragDown);
    headEl.addEventListener('pointerup', onDragUp);
    headEl.addEventListener('pointercancel', onDragUp);
    headEl.addEventListener('lostpointercapture', onDragUp);
    // 兜底：setPointerCapture 万一失败（上面的 try 会吞掉异常），或者指针在
    // 窗口外松开，头部就收不到 pointerup 了 —— 那会让主进程一直跟着光标跑，
    // 窗口"粘"在鼠标上停不下来。window 上再挂一层，onDragUp 自带防重入。
    window.addEventListener('pointerup', onDragUp);
    window.addEventListener('blur', onDragUp);

    albumEl.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = Number(albumEl.dataset.id) || 0;
      if (!id) return;
      sendGo('album', id, albumEl.dataset.name || albumEl.textContent);
    });

    // --- 进度条
    progressEl.addEventListener('pointerdown', onProgressDown);
    progressEl.addEventListener('pointermove', onProgressMove);
    progressEl.addEventListener('pointerup', onProgressUp);
    progressEl.addEventListener('pointercancel', onProgressCancel);
    progressEl.addEventListener('lostpointercapture', onProgressCancel);

    // --- 按钮
    repeatBtn.addEventListener('click', () => {
      // 乐观翻转，等主窗口下一次 state 推送校正
      const i = REPEAT_ORDER.indexOf(state.repeat);
      state.repeat = REPEAT_ORDER[(i + 1) % REPEAT_ORDER.length];
      renderRepeat();
      sendRepeatCycle();
    });
    prevBtn.addEventListener('click', () => send({ type: 'prev' }));
    playBtn.addEventListener('click', () => {
      state.paused = !state.paused;
      renderPlay();
      send({ type: 'toggle' });
    });
    nextBtn.addEventListener('click', () => send({ type: 'next' }));
    likeBtn.addEventListener('click', () => {
      state.liked = !state.liked;
      renderLike();
      send({ type: 'like' });
    });
    queueBtn.addEventListener('click', () => setQueueOpen(!queueOpen));
    queueCloseBtn.addEventListener('click', () => setQueueOpen(false));
    closeBtn.addEventListener('click', () => {
      if (typeof mini.close === 'function') {
        const p = mini.close();
        if (p && typeof p.catch === 'function') p.catch(function () {});
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && queueOpen) setQueueOpen(false);
    });

    // --- 主进程 -> 页面
    if (typeof mini.onState === 'function') mini.onState(applyState);

    // 第 15 点：主进程正在移出 / 移入滑动时，把歌词的 mask 渐隐和发光关掉
    // （同拖动时的 `.is-dragging`，理由见 mini.css）。滑动结束必须摘掉这个类，
    // 所以两个方向都要处理，收到 false 就移除。
    if (typeof mini.onSliding === 'function') {
      mini.onSliding((on) => {
        document.body.classList.toggle('is-sliding', !!on);
      });
    }

    if (typeof mini.onQueue === 'function') {
      // preload 的 onQueue 只透传一个 payload 对象（electron/preload.js:126-130），
      // 不是 (list, index) 两个参数，所以两种形状都要认。
      mini.onQueue((payload, maybeIndex) => {
        let list = null;
        let idx = -1;
        if (Array.isArray(payload)) {
          list = payload;
          idx = maybeIndex;
        } else if (payload && typeof payload === 'object') {
          list = Array.isArray(payload.list) ? payload.list
               : Array.isArray(payload.queue) ? payload.queue
               : Array.isArray(payload.items) ? payload.items : null;
          const i = payload.index != null ? payload.index : payload.currentIndex;
          idx = (typeof i === 'number') ? i : -1;
        }
        if (!list) return;
        queue = list;
        queueIndex = (typeof idx === 'number') ? idx : -1;
        if (queueOpen) renderQueue();
        else if (queueCountEl) queueCountEl.textContent = String(queue.length);
      });
    }

    // 队列 / 打开状态也可能走 onCmd 过来，顺手接住
    if (typeof mini.onCmd === 'function') {
      mini.onCmd((m) => {
        if (!m || typeof m !== 'object') return;
        if (Array.isArray(m.list)) {
          queue = m.list;
          const idx = m.index != null ? m.index : m.currentIndex;
          queueIndex = (typeof idx === 'number') ? idx : -1;
          renderQueue();
        }
        if (m.type === 'queueOpen') setQueueOpen(!!m.open);
      });
    }

    // --- 换肤（boot.js 已经设过初始值，这里只跟后续变化）
    if (ne.skin && typeof ne.skin.onChanged === 'function') {
      // 深色皮肤名单。小窗不引 skins.js，所以只能再列一遍 ——
      // boot.js / skins.js / 这里三处的 DARK 必须一致。
      const DARK = { classic: 1, sunset: 1 };
      ne.skin.onChanged((id) => {
        document.documentElement.setAttribute('data-skin', id);
        // 与 boot.js / skins.js 同一套判断：深色皮肤不只经典黑一个了
        // （落日余晖也是深底），所以按名单判，别再写 id === 'classic'。
        document.documentElement.style.colorScheme = DARK[id] ? 'dark' : 'light';
      });
    }
  }

  /* ---------------------------------------------------------- 启动 */
  function start() {
    bind();
    // 先画一遍空态，避免主窗口还没推状态时是一片空白
    renderTrack();
    renderButtons();
    renderProgress();
    if (lyricView) lyricView.set(null);
    renderQueue();

    // 只调一次：让主窗口开始推状态
    if (typeof mini.hello === 'function') mini.hello();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  // 方便在 devtools 里看
  global.Mini = {
    state: state,
    get queue() { return queue; },
    get lyricView() { return lyricView; },
    applyState: applyState,
    // openQueue() 不带参数时是"打开"，带参数时按参数来（内部 setQueueOpen 只收显式布尔）
    openQueue: function (open) { setQueueOpen(open === undefined ? true : open); },
    closeQueue: function () { setQueueOpen(false); }
  };
})(window);
