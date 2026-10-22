/* ============================================================
   播放器：队列 / 播放控制 / 歌词同步 / 上报
   ============================================================ */
(function (global) {
  'use strict';

  const REPEAT = { LIST: 'list', ONE: 'one', SHUFFLE: 'shuffle' };

  /**
   * 离结尾不足这么多秒的进度就不再续接了。
   *
   * 原来只有 5 秒，用户报来的《真夏ノ花火》正好卡在最后 13 秒：上次听到 3:05
   * （全长 3:18）被记下来，之后每次启动都从那句尾巴上接着放；剩下那十几秒又不够
   * 写回一条新进度（`_saveProgress` 有同样的门槛），那个 3:05 就被永久钉在 config
   * 里 —— 用户看到的「每次打开都从 3:00 开始放」就是它。门限放宽到 20 秒，这种
   * 「其实已经听完了」的位置会被当成没听过。
   */
  const RESUME_TAIL_GUARD = 20;

  class Player {
    constructor() {
      this.audio = new Audio();
      this.audio.preload = 'auto';
      this.audio.volume = 0.7;

      this.queue = [];        // [{ id, name, artistText, artists, album, cover, duration, ... }]
      this.index = -1;
      this.repeat = REPEAT.LIST;
      this.shuffleOrder = [];
      this.playing = false;
      this.loading = false;

      // 第 7 点：随机播放改成「把队列本身洗一遍」。关掉随机时要能还原成原来的
      // 顺序，所以记一份打乱之前的 id 序列（存 id 而不是下标，中途增删歌也不会错位）。
      this._orderBeforeShuffle = null;

      this.currentUrl = null;
      this.currentQuality = null;
      // 当前这首是不是放的本地文件（m35069 第 2 点）：本地文件不会过期，
      // 用它把「该不该刷新直链」这条路径整个跳过。
      this.currentLocal = false;
      this._urlExpireAt = 0;

      // 第⑥点：本地文件被证明放不了的歌（损坏或丢失）。放进这里就不再试本地 ——
      // 否则「本地坏 → 退回在线 → 下次又挑中同一个坏文件」会绕成圈。
      this._noLocal = new Set();

      this._scrobbled = new Set();
      this._failStreak = 0;    // 连续失败计数，避免整队列全是付费曲时无限跳

      // 第 6 点：淡入淡出的定时器与「记住进度」的节流
      this._fadeTimer = null;
      this._progressAt = 0;

      // m03577 第⑨点：启动恢复队列期间关掉落盘 —— 装到一半的状态被写回去，
      // 下次启动就会拿一份残缺的队列覆盖掉用户真正的那份。
      this._restoring = false;

      // 只有「启动时接着上次听」那条路放行过一次进度恢复；见 `resumeArmedFor`。
      this._resumeOk = null;

      this._bindAudio();
    }

    /** 淡入淡出是否开启（设置项 fade，默认开） */
    _fadeOn() {
      return global.Settings ? global.Settings.get('fade') !== false : true;
    }

    /** 记住进度是否开启（设置项 rememberProgress，默认关） */
    _rememberOn() {
      return global.Settings ? global.Settings.get('rememberProgress') === true : false;
    }

    /** 当前设置下音量应该停在哪儿 */
    _targetVolume() {
      return store.muted ? 0 : store.volume;
    }

    /**
     * 把音量平滑推到 target。
     *
     * 只动 `audio.volume`，不碰 `store.volume` —— 否则淡入过程中底栏那根音量条
     * 会跟着从 0 爬到 100%，看起来像用户自己拧的。定时器每次调用先清掉，
     * 所以连续切歌不会叠加出两条互相打架的斜坡。
     */
    _fadeTo(target, ms, done) {
      clearInterval(this._fadeTimer);
      this._fadeTimer = null;
      const a = this.audio;
      const to = Math.max(0, Math.min(1, target));
      if (!this._fadeOn() || ms <= 0) {
        a.volume = to;
        if (done) done();
        return;
      }
      const from = a.volume;
      const t0 = performance.now();
      const step = () => {
        const p = Math.min(1, (performance.now() - t0) / ms);
        a.volume = from + (to - from) * p;
        if (p >= 1) {
          clearInterval(this._fadeTimer);
          this._fadeTimer = null;
          if (done) done();
        }
      };
      this._fadeTimer = setInterval(step, 16);
      step();
    }

    // ---------------------------------------------------- 只读访问器

    get current() {
      return this.index >= 0 ? this.queue[this.index] || null : null;
    }

    get hasNext() {
      if (!this.queue.length) return false;
      if (this.repeat === REPEAT.ONE) return true;
      if (this.repeat === REPEAT.SHUFFLE) return this.queue.length > 1;
      return this.index < this.queue.length - 1;
    }

    // ---------------------------------------------------- audio 事件

    _bindAudio() {
      const a = this.audio;

      a.addEventListener('timeupdate', () => {
        store.emit('player:time', { current: a.currentTime * 1000, duration: (a.duration || 0) * 1000 });
        this._maybeScrobble();
        this._saveProgress(this.current);
      });

      a.addEventListener('loadedmetadata', () => {
        store.emit('player:duration', { duration: (a.duration || 0) * 1000 });
      });

      a.addEventListener('play', () => {
        this.playing = true;
        store.emit('player:state', { playing: true, loading: false });
      });

      a.addEventListener('pause', () => {
        this.playing = false;
        store.emit('player:state', { playing: false });
      });

      a.addEventListener('waiting', () => {
        this.loading = true;
        store.emit('player:state', { loading: true });
      });

      a.addEventListener('playing', () => {
        this.loading = false;
        this._failStreak = 0;
        store.emit('player:state', { loading: false, playing: true });
      });

      a.addEventListener('ended', () => {
        this._onEnded();
      });

      a.addEventListener('error', () => {
        const e = a.error;
        // 空 src 触发的 error 不是真错误（停止播放时会出现）
        if (!a.currentSrc) return;
        console.warn('[player] audio error', e && e.code, e && e.message);
        // 第⑥点：本地文件损坏（能读出来、解不了码）。别当成「这首歌放不了」直接
        // 跳过 —— 在线那一份很可能是好的，先退回去再放一次。_dropLocal 保证同一首
        // 只退一次，在线也失败时才会落到 _handleLoadFailure 那套重试/跳过逻辑里。
        if (this.currentLocal) {
          const song = this.current;
          if (song && !this._noLocal.has(song.id)) {
            this._dropLocal(song);
            this._load(song);
            return;
          }
        }
        this._handleLoadFailure();
      });
    }

    _onEnded() {
      // 这首歌已经放完了，那条「上次听到 3:05」的账留着只会让它下次从尾巴上接着
      // 放（用户报来的《真夏ノ花火》就是这么被钉住的）。放完即清零，下次从头上听。
      this._forgetProgress(this.current);
      if (this.repeat === REPEAT.ONE) {
        this.audio.currentTime = 0;
        this.audio.play().catch(() => {});
        return;
      }
      this.next(true);
    }

    /** 设置项「播放失败自动跳过」；没有设置模块时按开启处理 */
    get autoSkip() {
      const S = global.Settings;
      return S ? S.get('autoSkip') !== false : true;
    }

    /** 拿不到可播地址或播放出错时的处理 */
    _handleLoadFailure() {
      const song = this.current;
      this._failStreak++;
      if (song) U.toastErr(`无法播放：${song.name}${song.artistText ? ' - ' + song.artistText : ''}`);
      if (!this.autoSkip) {
        // 用户关掉了自动跳过：停在当前这首，不往下走
        this._failStreak = 0;
        this.playing = false;
        store.emit('player:state', { playing: false, loading: false });
        return;
      }
      // 连续 4 首失败就停下，别把整个队列刷完
      if (this._failStreak >= 4) {
        this._failStreak = 0;
        this.playing = false;
        store.emit('player:state', { playing: false, loading: false });
        U.toastErr('连续多首歌曲无法播放，已暂停');
        return;
      }
      if (this.hasNext) setTimeout(() => this.next(true), 350);
    }

    /** 播放满 1/2 或 4 分钟上报一次 */
    _maybeScrobble() {
      const song = this.current;
      if (!song || !store.loggedIn) return;
      if (this._scrobbled.has(song.id)) return;
      const dur = (this.audio.duration || 0) * 1000 || song.duration || 0;
      const cur = this.audio.currentTime * 1000;
      if (dur > 0 && cur >= Math.min(dur / 2, 240000)) {
        this._scrobbled.add(song.id);
        svc.raw('scrobble', song.id, this._sourceId(), Math.round(cur)).catch(() => {});
      }
    }

    _sourceId() {
      // 歌单/专辑上下文；没有就用歌曲 id 本身
      return (this.context && this.context.id) || this.current?.id || 0;
    }

    // ---------------------------------------------------- 队列

    /** 用新列表替换队列并播放 fromIndex */
    async playList(songs, fromIndex = 0, context = null) {
      const list = (songs || []).filter(Boolean);
      if (!list.length) { U.toast('没有可播放的歌曲'); return; }
      this.queue = list.slice();
      this.context = context;
      this._failStreak = 0;
      this._scrobbled.clear();
      // 换队列等于换了一个新上下文，之前记的「原顺序」不再适用
      this._orderBeforeShuffle = null;
      this.shuffleOrder = this.queue.map((_, i) => i);
      // 随机模式开着时，新队列进来也要先打乱；锚点是要播的那首，
      // 打乱之后下标要重新指回它（否则点了第 3 首，放出来是别人）
      if (this.repeat === REPEAT.SHUFFLE) {
        this._applyShuffle(this.queue[fromIndex] || null);
        await this.playAt(this.index);
      } else {
        await this.playAt(fromIndex);
      }
      store.emit('player:queue', this.queue);
      this._saveQueue();
    }

    /** 在队列末尾追加 */
    async enqueue(songs, { playNow = false } = {}) {
      const list = (songs || []).filter(Boolean);
      if (!list.length) return;
      if (!this.queue.length || playNow) {
        await this.playList(list, 0, this.context);
        return;
      }
      const startIdx = this.queue.length;
      this.queue.push(...list);
      this._rebuildShuffle();
      store.emit('player:queue', this.queue);
      this._saveQueue();
      U.toast(`已添加 ${list.length} 首到播放队列`);
    }

    /** 插入到当前歌曲之后 */
    playNext(songs) {
      const list = (songs || []).filter(Boolean);
      if (!list.length) return;
      if (this.index < 0) return this.playList(list, 0);
      this.queue.splice(this.index + 1, 0, ...list);
      this._rebuildShuffle();
      store.emit('player:queue', this.queue);
      this._saveQueue();
      U.toast(`已插入 ${list.length} 首到下一首播放`);
    }

    removeAt(i) {
      if (i < 0 || i >= this.queue.length) return;
      const wasCurrent = i === this.index;
      this.queue.splice(i, 1);
      if (i < this.index) this.index--;
      else if (wasCurrent) {
        this.index = Math.min(this.index, this.queue.length - 1);
        if (this.index >= 0) this.playAt(this.index, { keepQueue: true });
        else this.stop();
      }
      this._rebuildShuffle();
      store.emit('player:queue', this.queue);
      this._saveQueue();
    }

    clearQueue() {
      this.stop();
      this.queue = [];
      this.index = -1;
      this.context = null;
      this._rebuildShuffle();
      store.emit('player:queue', this.queue);
      // 用户主动清空 = 明确要"下次别再给我这套"。这是唯一该把快照抹掉的地方
      // （`_saveQueue` 自己遇到空队列是**不写**的，两者语义不同）。
      this._orderBeforeShuffle = null;
      // 内存里那份也要清：`_restoreProgress` 读的是 store.lastPlay，只清 config
      // 的话，本次会话里点开一首旧歌还会被拽回上次的进度。
      store.lastPlay = null;
      if (global.App && global.App.saveConfig) {
        // lastPlay 也一起清：它是「上次听到哪儿」，队列都空了还留着它，下次启动
        // 就会走单曲兜底路径，凭空冒出一首歌 —— 用户刚点的「清空」等于没生效。
        global.App.saveConfig({
          queue: [], queueIndex: 0, queueOrigin: null, queueCtx: null, lastPlay: null,
        }).catch(() => {});
      }
      // 必须补一条 track=null：`stop()` 只发 `player:state`，而播放条上的歌名、
      // 歌手、封面、红心状态和评论数角标全都挂在 `player:track` 上。少了这条，
      // 清空队列后底栏会永远停在上一次播放的歌（角标也跟着留下旧数字），
      // 全屏播放页同样不会复位。`syncTrackUI(null)` 自带全套清空分支。
      store.emit('player:track', null);
    }

    /**
     * 洗牌（第 7 点 + m36690 第 3 点）。
     *
     * 用户要的语义是「点随机播放后，歌单里的歌被重新排列到播放列表中」，而不是
     * 「顺序列表 + 一张随机跳转表」。区别在界面上看得见：老做法里列表还是原顺序、
     * 只是播放顺序乱跳，用户会以为随机没生效；新做法列表本身就乱了。
     *
     * m36690 第 3 点又追加了一条：**正在放的那首要钉在首位**，其余再随机填充。
     * 理由是「列表本身就乱」带来一个新问题 —— 点随机的瞬间，用户盯着的那首歌会
     * 被随机到列表中间某处，看起来像是"随机把我正在听的歌换掉了"。把它固定在
     * 第一行，既保留了「列表真的乱了」的观感，又让当前曲始终有确定的位置。
     *
     * 所以这里直接重排 `this.queue`，并把「打乱前的顺序」按 id 记下来，关掉随机时
     * 还原。anchor 是重排后下标要继续指向的那首歌（默认当前曲）—— 不传的话，
     * 队列被换掉之后 `this.index` 会指到另一首歌上去。
     *
     * `shuffleOrder` 保留成恒等序列：小窗和底栏的 next/prev 都还在读它，留着一张
     * 恒等表比到处判空省事，语义上也对 —— 队列自己已经是乱的了。
     */
    _applyShuffle(anchor) {
      const keep = anchor || this.current;
      if (this.queue.length > 1) {
        // 只在第一次进随机时记原顺序，反复开关不会把乱序当成原序
        if (!this._orderBeforeShuffle) {
          this._orderBeforeShuffle = this.queue.map((s) => s.id);
        }
        // 按 id 而不是引用挑出当前曲：队列里可能有同一首歌的两个不同对象
        // （搜索页和歌单页各自建的 song 对象），引用比较会让 filter 漏掉它。
        const rest = keep ? this.queue.filter((s) => s.id !== keep.id) : this.queue.slice();
        for (let i = rest.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [rest[i], rest[j]] = [rest[j], rest[i]];
        }
        this.queue = keep ? [keep].concat(rest) : rest;
      }
      if (keep) {
        const ni = this.queue.indexOf(keep);
        if (ni >= 0) this.index = ni;
      }
      this.shuffleOrder = this.queue.map((_, i) => i);
      store.emit('player:queue', this.queue);
      this._saveQueue();
    }

    /** 关掉随机时把队列还原成原来的顺序（第 7 点）。 */
    _undoShuffle() {
      const before = this._orderBeforeShuffle;
      this._orderBeforeShuffle = null;
      this.shuffleOrder = this.queue.map((_, i) => i);
      if (!before || before.length !== this.queue.length) return;
      const cur = this.current;
      const byId = new Map(this.queue.map((s) => [s.id, s]));
      const restored = before.map((id) => byId.get(id)).filter(Boolean);
      // 中途被删过歌就对不齐了，宁可保持现状也不要拼出半个队列
      if (restored.length !== this.queue.length) return;
      this.queue = restored;
      if (cur) {
        const ni = this.queue.findIndex((s) => s.id === cur.id);
        if (ni >= 0) this.index = ni;
      }
      store.emit('player:queue', this.queue);
      this._saveQueue();
    }

    /**
     * 队列变了之后把 `shuffleOrder` 拉回恒等。
     *
     * 这里**不**重新洗牌：随机开着的时候往队列里加一首歌，如果整列又洗一遍，
     * 正在放的那首会突然跳到列表别的位置上，看起来像界面抽风。新歌直接排到末尾，
     * 想重排就再点一次随机按钮。
     */
    _rebuildShuffle() {
      this.shuffleOrder = this.queue.map((_, i) => i);
    }

    // ---------------------------------------------------- 播放控制

    async playAt(i, { keepQueue = false } = {}) {
      if (i < 0 || i >= this.queue.length) return;
      this.index = i;
      const song = this.queue[i];
      store.emit('player:track', song);
      // 下标变了也要落盘：下次启动该接着放这一首，而不是队列第一首。
      this._saveQueue();

      await this._load(song);
    }

    /**
     * 查这首歌在本机有没有音频（m35069 第 2 点）。
     *
     * 索引由主进程维护（扫描文件夹 + 下载完成的歌自动进索引），渲染层只问
     * 「这首歌对应哪个文件」。主进程每次都会 stat，文件被移走 / 删掉时返回
     * null —— 于是这里静默回落到网络播放，不需要谁去通知索引失效。
     *
     * 拿不到索引（老版本主进程、IPC 出错）时也返回 null：本地优先是锦上添花，
     * 不能因为它让整首歌放不出来。
     *
     * [want] 是用户当前选的音质（用户 m11461 第③点）。传了就只有「本地这份够
     * 这一档」时才返回；不够返回 null 让调用方去取新流 —— 但**不**判它死刑，
     * 文件没坏，只是档位不够，下次选回低档还要用它。`satisfied: false` 与
     * 「文件不在了」是两件事，不能都走 [_dropLocal]（那会给用户弹一句
     * 「本地无法播放」，可他什么都没坏）。
     */
    async _localSource(song, want) {
      if (!song || !song.id) return null;
      // 第⑥点：这首歌的本地副本已经被证明放不了，本次会话不再试它。
      if (this._noLocal.has(song.id)) return null;
      if (!store.localIds || !store.localIds.size) return null;
      if (!store.localIds.has(song.id)) return null;
      const L = global.ne && global.ne.local;
      if (!L || !L.resolve) return null;
      let hit = null;
      try { hit = await L.resolve(song.id, want); } catch { hit = null; }
      if (!hit) {
        // 走到这一步说明「索引说本机有」，但主进程已经 stat 不到文件了（被删 /
        // 挪走 / 改名）。只有这种情况才该提示：压根没下载过的歌进不到这里，
        // 不会误报。
        this._dropLocal(song);
        return null;
      }
      // 档位不够：静默去取新流，索引和「√」都不动。
      if (hit.satisfied === false) return null;
      return hit;
    }

    /**
     * 第⑥点：给一首歌的本地副本判死刑，改用在线资源。
     *
     * 三件事缺一不可 ——
     *   · 记进 `_noLocal`，本次会话不再挑它（否则「本地坏 → 退回在线 → 下次又
     *     挑中同一个坏文件」会绕成圈）；
     *   · 让主进程把它从索引里剔掉并广播，歌单里那个「√」跟着灭 —— 文件在但
     *     解不了码是 `existsSync` 发现不了的坏法，只有真播过一次的人能上报；
     *   · 如实告诉用户换了源。静默换源会让用户以为自己听的是下好的文件，其实
     *     已经在跑流量了。
     */
    _dropLocal(song) {
      if (!song || !song.id) return;
      this._noLocal.add(song.id);
      // 立刻把状态改成「现在放的不是本地文件」：损坏那条路径是在 error 事件里
      // 进来的，此刻 currentLocal 还是 true，不改的话紧接着的这次 _load 若也失败，
      // 判断分支会以为还在放本地文件。
      this.currentLocal = false;
      if (store.localIds) store.localIds.delete(Number(song.id));
      const L = global.ne && global.ne.local;
      if (L && L.drop) L.drop(song.id).catch(() => {});
      if (global.App && global.App.paintLocal) global.App.paintLocal();
      U.toast(`「${song.name}」本地无法播放，已转为在线资源`);
    }

    /**
     * 取播放地址：本地文件优先，传输层失败自动退避重试。
     *
     * `svc.songUrl` 的 `failed: true` 表示「压根没问到服务端」（断网 / 接口
     * 5xx / 被风控），这和「服务端明确回答这首歌没版权」是两件事 —— 把它们
     * 混在一起报给用户就是 m36690 第①点。所以这里只对 failed 重试，且重试
     * 期间用户切了歌（token 变了）就立刻放弃，不浪费等待。
     */
    async _fetchUrl(song, token, retries = 2) {
      // 本地优先（m35069 第 2 点）：本机已经有这首歌的音频就直接放它。
      // 主进程每次都会 stat 一遍，文件被删掉时返回 null，这里自然回落到
      // 网络 —— 所以索引不需要「主动失效」也能自己纠正。
      const local = await this._localSource(song);
      if (local) return { url: local.url, local: true, file: local.file, type: local.mime };

      const waits = [600, 1400];
      for (let i = 0; ; i++) {
        const info = await svc.songUrl(song.id, store.quality);
        if (!info || !info.failed) return info;
        if (i >= retries || token !== this._loadToken) return info;
        await new Promise((r) => setTimeout(r, waits[Math.min(i, waits.length - 1)]));
        if (token !== this._loadToken) return info;
      }
    }

    async _load(song) {
      this.loading = true;
      store.emit('player:state', { loading: true });
      // 每次 _load 都换一个令牌，晚到的那次会作废先到的那次，避免重试期间
      // 用户已经切歌、旧请求回来又把 audio.src 改回去。
      const token = (this._loadToken = (this._loadToken || 0) + 1);

      try {
        const info = await this._fetchUrl(song, token);
        if (token !== this._loadToken) return;

        if (!info || !info.url) {
          if (info && info.failed) {
            // 第①点：问都没问到，绝不能说「暂无版权或已下架」。
            // 也不消耗自动跳过额度、不往下跳 —— 网络断了整队列都放不出来，
            // 跳只会把队列烧完，用户回来还得手动找回位置。
            this.loading = false;
            this._failStreak = 0;
            store.emit('player:state', { loading: false, playing: false });
            U.toastErr(`「${song.name}」加载失败，请检查网络后重试`);
            return;
          }
          // 服务端答了、但 url 为空：付费 / 无版权 / 下架
          const why = info && info.fee === 1 ? '需要会员或付费' : '暂无版权或已下架';
          U.toastErr(`「${song.name}」${why}`);
          this.loading = false;
          store.emit('player:state', { loading: false });
          this._failStreak++;
          if (this.autoSkip && this._failStreak < 4 && this.hasNext) setTimeout(() => this.next(true), 400);
          else { this._failStreak = 0; store.emit('player:state', { playing: false }); }
          return;
        }

        this.currentUrl = info.url;
        this.currentLocal = !!info.local;
        this.currentQuality = info.local ? '本地文件' : (info.level || info.br);
        // 网易云直链有效期很短（约 20 分钟），留 5 分钟余量。
        // 本地文件不会过期，置 0 表示「不用刷新」。
        this._urlExpireAt = info.local ? 0 : Date.now() + 15 * 60 * 1000;

        this.audio.src = info.url;
        this.audio.load();
        store.emit('player:url', { song, url: info.url, info });

        // 第 6 点：从 0 淡入。先落回 0 再 play，否则上一首的满音量会先响一下。
        const target = this._targetVolume();
        if (this._fadeOn()) this.audio.volume = 0;
        await this.audio.play();
        if (this._fadeOn()) this._fadeTo(target, 320);
        this.loading = false;
        store.emit('player:state', { loading: false, playing: true });
        // 真正开始播放才记进「最近播放」，取流失败的歌曲不该出现在里面
        store.pushRecent(song);
        this._restoreProgress(song);
      } catch (e) {
        this.loading = false;
        store.emit('player:state', { loading: false });
        // 用户主动暂停导致的 AbortError 不算失败
        if (e && e.name === 'AbortError') return;
        console.warn('[player] load failed', e);
        this._handleLoadFailure();
      }
    }

    /**
     * 直链过期时刷新并恢复到原来的进度。
     *
     * `want` 是给「用户在播放页切了音质」用的（用户 m09508 第②点、m11461 第③点，
     * 安卓端同一个毛病）：切档时不问本地是不行的 —— 索引里存着这首歌，
     * `_localSource()` 会一直把同一个文件还回来，档位换了也听不出任何区别。
     * 但反过来「一律不问本地」也不对：用户从无损切到标准，本地那份无损完全够用，
     * 再去下一份 128k 纯属浪费。所以这里把当前档位交给索引，让它回答够不够
     * （`satisfied`），不够才去网络上取。
     */
    async _refreshUrl(want) {
      const song = this.current;
      if (!song) return false;
      // 本地文件不会过期，压根不用刷新（切档时例外，得重新问一次够不够）
      if (this.currentLocal && !want) return false;
      const pos = this.audio.currentTime;
      const wasPlaying = this.playing;
      try {
        const local = await this._localSource(song, want);
        // 本地这份就是现在放的那份（切档但档位本来就够）—— 什么都别动，
        // 重新 load 一次会把播放打断几毫秒，听感上是一次多余的顿挫。
        if (local && this.currentLocal && local.url === this.currentUrl) return true;
        const info = local ? { url: local.url, local: true } : await svc.songUrl(song.id, store.quality);
        if (!info || !info.url) return false;
        this.currentUrl = info.url;
        this.currentLocal = !!info.local;
        this._urlExpireAt = info.local ? 0 : Date.now() + 15 * 60 * 1000;
        this.audio.src = info.url;
        this.audio.load();
        if (pos > 0) {
          await new Promise((res) => {
            const h = () => { this.audio.removeEventListener('loadedmetadata', h); res(); };
            this.audio.addEventListener('loadedmetadata', h);
            setTimeout(res, 1500);
          });
          this.audio.currentTime = pos;
          // 第⑦点：换源后同样要自己补一条进度，否则进度条会从 0 重新爬
          this._emitTime(pos, this.audio.duration || 0);
        }
        if (wasPlaying) await this.audio.play();
        return true;
      } catch { return false; }
    }

    // ---------------------------------------------------- 上次播放进度（第 6 点）

    /**
     * 把「上次听到哪儿了」写进 config。
     *
     * 存的是 `{ id, position }` 而不是整个队列：用户只想接着听那首歌，恢复一整个
     * 队列会顺带把他上次随便点开的临时列表也带回来。节流到 5 秒一次 —— timeupdate
     * 每 250ms 就发一条，直接落盘会把 config.json 写成磁盘热点。
     */
    _saveProgress(song) {
      if (!this._rememberOn() || !song) return;
      const now = Date.now();
      if (now - this._progressAt < 5000) return;
      this._progressAt = now;
      // 快播完的不记：下次启动从"离结尾 3 秒"接着放没有任何意义。
      // 门槛跟 `resumePositionFor` 用同一个常量 —— 存的时候挡不住，恢复的时候
      // 再挡就晚了：那个值会一直躺在 config 里被反复读出来。
      const dur = this.audio.duration || 0;
      const pos = this.audio.currentTime || 0;
      if (!dur || pos < 5 || pos > dur - RESUME_TAIL_GUARD) return;
      global.App.saveConfig({
        lastPlay: { id: song.id, name: song.name || '', position: Math.round(pos * 1000), at: now },
      }).catch(() => {});
    }

    /**
     * 该不该给这首歌续上次的进度？返回要跳到的秒数，0 表示从头上放。
     *
     * 只回答「这个位置现在还值不值得用」：太靠前（不到 5 秒）、已经贴到结尾
     * （不足 `RESUME_TAIL_GUARD` 秒）、隔了三天以上，都当没听过。
     */
    resumePositionFor(song) {
      if (!this._rememberOn() || !song) return 0;
      const lp = global.store.lastPlay;
      if (!lp || lp.id !== song.id || !lp.position) return 0;
      // 过期太久就不接了：隔了一周再打开，从上次的 3:12 开始放反而突兀
      if (lp.at && Date.now() - lp.at > 3 * 24 * 3600 * 1000) return 0;
      const pos = lp.position / 1000;
      if (pos < 5) return 0;
      const dur = (this.audio.duration || 0) || (song.duration ? song.duration / 1000 : 0);
      if (dur && pos >= dur - RESUME_TAIL_GUARD) return 0;
      return pos;
    }

    /**
     * 放行一次「接着上次听」，只给启动恢复那条路（`App.resumeLastPlay` /
     * `App._restoreQueue`）用。
     *
     * 设置页写的就是「下次启动时接着上次的进度继续播」；用户自己在列表里点一首歌
     * 是明确要从头听，不该被三天前那个 3:12 劫持，所以 `_restoreProgress` 默认
     * 什么都不做，只有这里放行过才接。
     */
    resumeArmedFor(song) {
      this._resumeOk = (song && song.id) ? song.id : null;
    }

    /** 这首歌已经放完 / 被换掉了，config 里那条进度就别留着了 */
    _forgetProgress(song) {
      const lp = global.store.lastPlay;
      if (!song || !lp || lp.id !== song.id) return;
      global.store.lastPlay = null;
      if (global.App && global.App.saveConfig) {
        global.App.saveConfig({ lastPlay: null }).catch(() => {});
      }
    }

    /** 启动时接着上次的进度继续（第 6 点）。 */
    _restoreProgress(song) {
      if (!song) return;
      const armed = this._resumeOk === song.id;
      // 只接一次：之后同一首再放（点列表、上一首）都从头开始
      this._resumeOk = null;
      if (!armed) return;
      const pos = this.resumePositionFor(song);
      if (!pos) return;
      const apply = () => {
        const dur = this.audio.duration || 0;
        if (!dur || pos >= dur - RESUME_TAIL_GUARD) return;
        this.audio.currentTime = pos;
        // 第⑦点：进度条只在 `timeupdate` 里画，可是一次跳转之后的第一条
        // timeupdate 未必落在跳转之后（缓冲里可能还排着一条 currentTime=0 的
        // 旧事件），界面于是会停在开头不动。这里显式广播一次，让「恢复到的
        // 位置」和进度条、时间文字、歌词立刻对齐。
        this._emitTime(pos, dur);
      };
      if (this.audio.readyState >= 1) apply();
      else this.audio.addEventListener('loadedmetadata', apply, { once: true });
    }

    /**
     * 手动广播一条播放进度。
     *
     * 第⑦点加它是因为进度条、时间文字、歌词都只挂在 `player:time` 这一个
     * 事件上：任何「不经过 timeupdate 就改变播放位置」的操作（恢复上次进度、
     * 换源后回到原位置）都必须自己补一条，否则界面会停在 0:00。
     */
    _emitTime(currentSec, durationSec) {
      const dur = durationSec || this.audio.duration || 0;
      store.emit('player:time', { current: currentSec * 1000, duration: dur * 1000 });
    }

    /** 记住的进度属于哪首歌——启动时用它决定要不要把这首歌塞回队列 */
    get lastPlay() { return global.store.lastPlay || null; }

    // ---------------------------------------------------- 队列持久化（m03577 第⑨点）

    /**
     * 把整个播放队列写进 config。
     *
     * 存的是**当前顺序**（洗过牌之后的那份），不是歌单 id —— 用户可能中途插过歌、
     * 删过歌、把某首丢到下一首播放，用歌单 id 重放会把那些编辑全丢掉。
     * 另外三样必须一起存，否则恢复出来的是个"看着对、一点就不对"的队列：
     *   · `index`   —— 不然会从第一首开始；
     *   · `repeat`  —— 随机模式下队列本身是乱序的，只有配上 repeat 才说得通；
     *   · `origin`  —— 退出随机要还原的原始 id 序列。
     *
     * 空队列**不清**已存的快照：冷启动时 `connect`/同步那些路径会带着空队列跑一遍，
     * 照着"空就是空"写下去会把用户上一轮真正的那份抹掉（安卓端踩过这个坑）。
     */
    _saveQueue() {
      if (this._restoring) return;
      if (!this.queue.length) return;
      const snap = {
        queue: this.queue,
        queueIndex: this.index,
        queueRepeat: this.repeat,
        queueCtx: this.context || null,
        queueOrigin: this._orderBeforeShuffle || null,
        queueAt: Date.now(),
      };
      if (global.App && global.App.saveConfig) global.App.saveConfig(snap).catch(() => {});
    }

    /**
     * 用快照恢复队列，但**不播**。
     *
     * 打开应用就自己出声很讨厌（跟 `resumeLastPlay` 的老口径一致），所以这里只把
     * 队列、下标、循环模式摆好，让底栏显示上一首停着的那首歌，等用户按播放。
     * 循环模式要在这里落定：随机模式下列表已经是乱的，若先按 LIST 摆再切 SHUFFLE，
     * `setRepeat` 会当成"刚进随机"再洗一次，把存下来的顺序又打乱一遍。
     */
    restoreQueue(snap) {
      const q = (snap && Array.isArray(snap.queue) ? snap.queue : []).filter((s) => s && s.id);
      if (!q.length) return false;
      this._restoring = true;
      try {
        this.queue = q.slice();
        this.repeat = [REPEAT.LIST, REPEAT.ONE, REPEAT.SHUFFLE].includes(snap.queueRepeat)
          ? snap.queueRepeat
          : REPEAT.LIST;
        this.context = snap.queueCtx || null;
        // 原始顺序只在「随机 + 存了 origin」时才有意义；顺序列表存着它反而会让
        // 下一次进随机时误以为"已经记过原序"，于是退出随机还原成一份乱序。
        this._orderBeforeShuffle = (this.repeat === REPEAT.SHUFFLE && Array.isArray(snap.queueOrigin))
          ? snap.queueOrigin.slice()
          : null;
        const idx = Number.isInteger(snap.queueIndex) ? snap.queueIndex : 0;
        this.index = (idx >= 0 && idx < this.queue.length) ? idx : 0;
        this.shuffleOrder = this.queue.map((_, i) => i);
        store.emit('player:queue', this.queue);
        store.emit('player:repeat', this.repeat);
        store.emit('player:track', this.current);
      } finally {
        this._restoring = false;
      }
      // 恢复完把快照按"现在的样子"再存一遍：老版本存的只有单曲，或者快照里的
      // 下标因为歌曲失效被夹过，都借这次写回就地修好。
      this._saveQueue();
      return true;
    }

    async play() {
      if (!this.current) {
        if (this.queue.length) return this.playAt(0);
        return;
      }
      // 还没有直链（冷启动时从「上次播放」恢复出来的那首就是这种情况）——
      // 直接 `audio.play()` 会因为没有 src 而失败，必须先把流取回来。
      if (!this.currentUrl) return this._load(this.current);
      // 直链可能已过期
      if (this._urlExpireAt && Date.now() > this._urlExpireAt && !this.playing) {
        const ok = await this._refreshUrl();
        if (ok) return;
      }
      // 暂停后回来时音量可能停在 0（淡出到一半），先补回目标值
      const target = this._targetVolume();
      if (this._fadeOn() && this.audio.volume < target) this._fadeTo(target, 200);
      try { await this.audio.play(); } catch (e) { console.warn('[player] play failed', e); }
    }

    /**
     * 暂停（第 6 点：淡出）。
     *
     * 淡出期间用户可能又点了播放，所以真正的 `pause()` 放在斜坡结束的回调里；
     * `_fadeTo` 会先清掉上一条定时器，于是"暂停→立刻播放"不会留下一条还在
     * 往下拉的斜坡。淡出关闭时行为跟原来完全一样，是同步 pause。
     */
    pause() {
      if (!this._fadeOn() || this.audio.paused) { this.audio.pause(); return; }
      this._fadeTo(0, 180, () => this.audio.pause());
    }

    toggle() { this.playing ? this.pause() : this.play(); }

    stop() {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
      this.playing = false;
      this.currentUrl = null;
      this.currentLocal = false;
      store.emit('player:state', { playing: false, loading: false });
    }

    async next(auto = false) {
      if (!this.queue.length) return;
      if (this.repeat === REPEAT.ONE && auto) {
        this.audio.currentTime = 0;
        return this.audio.play().catch(() => {});
      }
      if (this.repeat === REPEAT.SHUFFLE) {
        // 队列本身已经被打乱了（第 7 点），所以顺着下标走就是在随机播，
        // 到底回卷到第一首 —— 跟列表循环一样，只是列表是乱序的。
        const nextPos = (this.index + 1) % this.queue.length;
        return this.playAt(nextPos);
      }
      let i = this.index + 1;
      if (i >= this.queue.length) {
        if (this.repeat === REPEAT.LIST) i = 0;
        else { this.pause(); return; }
      }
      return this.playAt(i);
    }

    async prev() {
      if (!this.queue.length) return;
      // 播放超过 3 秒时，先回到开头
      if (this.audio.currentTime > 3) {
        this.audio.currentTime = 0;
        return;
      }
      if (this.repeat === REPEAT.SHUFFLE) {
        // 同 next()：队列已经是打乱过的，直接往回走一首
        const prevPos = (this.index - 1 + this.queue.length) % this.queue.length;
        return this.playAt(prevPos);
      }
      let i = this.index - 1;
      if (i < 0) i = this.queue.length - 1;
      return this.playAt(i);
    }

    seek(ms) {
      if (!this.audio.duration) return;
      this.audio.currentTime = Math.max(0, Math.min(ms / 1000, this.audio.duration));
    }

    seekRatio(r) {
      if (!this.audio.duration) return;
      this.audio.currentTime = Math.max(0, Math.min(r, 1)) * this.audio.duration;
    }

    setVolume(v) {
      this.audio.volume = Math.max(0, Math.min(1, v));
      store.emit('player:volume', this.audio.volume);
    }

    setMuted(m) {
      this.audio.muted = !!m;
      store.emit('player:muted', !!m);
    }

    /** 循环按钮只在「列表循环 / 单曲循环」之间切换。
     *  随机播放由它自己的按钮（#btnShuffle）控制，不再混进这条循环链：
     *  原顺序是 LIST → SHUFFLE → ONE，于是点一下循环按钮就跳进了随机模式，
     *  和旁边的随机按钮语义重复且反直觉。 */
    cycleRepeat() {
      const order = [REPEAT.LIST, REPEAT.ONE];
      const was = this.repeat;
      this.repeat = order[(order.indexOf(this.repeat) + 1) % order.length];
      // 从随机切到循环时也要还原队列（第 7 点），否则列表会一直是乱的那份
      if (was === REPEAT.SHUFFLE) this._undoShuffle();
      store.emit('player:repeat', this.repeat);
      this._saveQueue();
      return this.repeat;
    }

    /**
     * 直接指定循环模式。底栏的随机按钮、悬浮小窗的三合一按钮都走这里，
     * 免得两个入口各自拼一遍 `player.repeat = ...` + 广播。
     */
    setRepeat(v) {
      const next = [REPEAT.LIST, REPEAT.ONE, REPEAT.SHUFFLE].includes(v) ? v : REPEAT.LIST;
      if (next === this.repeat) return this.repeat;
      const was = this.repeat;
      this.repeat = next;
      // 第 7 点：随机 = 重排队列，退出随机 = 还原队列
      if (next === REPEAT.SHUFFLE) this._applyShuffle();
      else if (was === REPEAT.SHUFFLE) this._undoShuffle();
      store.emit('player:repeat', this.repeat);
      this._saveQueue();
      return this.repeat;
    }

    get duration() { return (this.audio.duration || 0) * 1000; }
    get position() { return this.audio.currentTime * 1000; }

    /** 切歌后把音量等设置重新套用 */
    applySettings() {
      this.audio.volume = store.muted ? 0 : store.volume;
    }
  }

  Player.REPEAT = REPEAT;
  global.Player = Player;
})(window);
