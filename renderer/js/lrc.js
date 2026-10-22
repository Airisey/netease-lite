/* ============================================================
   LRC 歌词解析与同步显示
   ============================================================ */
(function (global) {
  'use strict';

  const TIME_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

  function fracToMs(frac) {
    if (!frac) return 0;
    if (frac.length === 1) return parseInt(frac, 10) * 100;
    if (frac.length === 2) return parseInt(frac, 10) * 10;
    return parseInt(frac.slice(0, 3), 10);
  }

  /** "[00:12.34]词" -> [{time: 12340, text: '词'}]，一行多时间戳会展开 */
  function parseLrc(text) {
    const out = [];
    if (!text) return out;
    for (const raw of String(text).split(/\r?\n/)) {
      TIME_RE.lastIndex = 0;
      const stamps = [];
      let m;
      while ((m = TIME_RE.exec(raw)) !== null) {
        stamps.push((parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) * 1000 + fracToMs(m[3]));
      }
      if (!stamps.length) continue;
      const content = raw.replace(TIME_RE, '').trim();
      for (const t of stamps) out.push({ time: t, text: content });
    }
    out.sort((a, b) => a.time - b.time);
    return out;
  }

  /** 在已排序的时间数组里找 <= t 的最后一个下标，没有则 -1 */
  function lastIndexAtOrBefore(times, t) {
    let lo = 0, hi = times.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  /** 把翻译按时间对齐到原文；时间戳对不上时按顺序兜底 */
  function alignTranslation(main, trans) {
    if (!trans.length) return main.map((l) => ({ ...l, trans: '' }));
    const tTimes = trans.map((l) => l.time);
    const used = new Set();
    const out = main.map((line, i) => {
      // 1) 精确匹配
      let idx = tTimes.indexOf(line.time);
      // 2) 容差匹配
      if (idx < 0) {
        for (let d = 1; d <= 6 && idx < 0; d++) {
          const cand = tTimes.indexOf(line.time + d * 10);
          if (cand >= 0 && !used.has(cand)) idx = cand;
        }
      }
      if (idx >= 0 && !used.has(idx)) {
        used.add(idx);
        return { ...line, trans: trans[idx].text };
      }
      // 3) 数量一致时按下标对齐
      if (trans.length === main.length) {
        used.add(i);
        return { ...line, trans: trans[i].text };
      }
      return { ...line, text: line.text, trans: '' };
    });
    return out;
  }

  /** 纯文本歌词（没有时间戳）也要能显示 */
  function plainToLines(text) {
    return String(text || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((t) => ({ time: -1, text: t, trans: '' }));
  }

  class Lyrics {
    constructor() {
      this.lines = [];
      this.times = [];
      this.index = -1;
    }

    /** raw: { lrc, tlyric, romalrc } */
    set(raw) {
      const main = parseLrc(raw && raw.lrc);
      const trans = parseLrc(raw && raw.tlyric);
      if (main.length) {
        this.lines = alignTranslation(main, trans);
      } else {
        // 无时间轴：退化成纯文本
        const t = (raw && (raw.lrc || raw.tlyric)) || '';
        this.lines = plainToLines(t.replace(/\[[^\]]*\]/g, ''));
      }
      this.times = this.lines.map((l) => l.time);
      this.index = -1;
      return this;
    }

    get empty() { return this.lines.length === 0; }

    /** 当前时间对应的行号 */
    indexAt(ms) {
      if (!this.lines.length) return -1;
      if (this.times[0] < 0) return -1; // 无时间轴
      return lastIndexAtOrBefore(this.times, ms + 60);
    }
  }

  /**
   * 歌词视图：渲染 + 高亮 + 自动滚动
   *
   * 第 15 点：歌词必须「在没有干预的情况下始终让当前行停在正中」。
   * 原来的实现只监听容器的 scroll 事件来判断"用户滚动了"，可我们自己居中也是
   * 通过改 scrollTop 完成的 —— 于是每次自动居中都会把自己判成"用户在滚"，
   * userScrolling 被置 true 并锁 2.6s，滚动因此变成每 2.6 秒才跳一次，中间
   * 几行歌词都不居中。现在把"自己滚的"和"用户滚的"分开：
   *   · 居中前记一个时间戳 _selfScrollUntil，这段时间内的 scroll 事件一律不算用户操作；
   *   · 用户操作改用 wheel / 触摸 / 指针 / 键盘 这些真实输入事件来判定，最可靠。
   */
  class LyricView {
    constructor(container, listEl) {
      this.container = container;
      this.listEl = listEl;
      this.lyrics = new Lyrics();
      this.active = -1;
      this.userScrolling = false;
      this._scrollTimer = null;
      this._selfScrollUntil = 0;
      this._padTop = 0;
      this._padBottom = 0;
      // 自己驱动的平滑跟随（见 center 的注释）：_raf 是循环句柄，
      // _lastStep 用来算两帧之间的间隔，好让缓动与帧率无关。
      this._raf = 0;
      this._lastStep = 0;
      this._followUntil = 0;   // 循环至少跑到这个时刻，用来盖住字号过渡那 240ms
      this._followMs = 110;    // 缓动时间常数
      this._followMax = 4200;  // 速度上限 px/s，长距离归位时先匀速后收尾
      this._followTop = 0;     // 浮点累加器，见 _follow 的注释

      const markUser = () => {
        // 用户接管时立刻停掉跟随循环，别和用户的手抢滚动位置
        this._stopFollow();
        this.userScrolling = true;
        clearTimeout(this._scrollTimer);
        this._scrollTimer = setTimeout(() => {
          this.userScrolling = false;
          // 松手 3s 后主动归位：否则用户滚一下之后，当前行会一直歪着
          // 直到下一行歌词出现才被拉回来。走和换行同一条平滑路径，所以是
          // "滑回去"而不是"瞬移回去"；第二个参数让它滚多远都保持平滑。
          this.center(true, true);
        }, 3000);
      };
      this._markUser = markUser;

      // 真实输入事件 = 用户在看别的地方，暂停自动跟随。
      // 注意 pointerdown：点歌词行是"跳转播放"，不是滚动，别误判成用户接管；
      // 只有按在容器本身（滚动条 / 空白处）上才算。
      for (const evt of ['wheel', 'touchstart', 'touchmove']) {
        container.addEventListener(evt, markUser, { passive: true });
      }
      container.addEventListener('pointerdown', (e) => {
        if (e.target === container) markUser();
      }, { passive: true });
      // 键盘 / 滚动条拖拽：没有上面的输入事件，只能靠 scroll 兜底，
      // 但要排除我们自己居中产生的那几次。
      container.addEventListener('scroll', () => {
        // 跟随循环每一帧都在写 scrollTop，那些事件全是自己造成的
        if (this._raf || Date.now() < this._selfScrollUntil) return;
        markUser();
      }, { passive: true });

      // 容器尺寸变化（切皮肤、开合小窗、横竖版切换、窗口缩放）之后行高会重排，
      // 原来居中的那一行就偏了，这里补一次对中。
      if (typeof ResizeObserver === 'function') {
        this._ro = new ResizeObserver(() => { this.pad(); this.center(false); });
        this._ro.observe(this.container);
      }
      // 当前行字号从 17px 过渡到 22px 要 240ms，行高在这期间一直在长。
      // 跟随循环每帧都重算目标，所以过渡本身已经不会造成偏差；这里再补一次，
      // 是给"瞬时对齐"那条路径兜底（容器尺寸变化 / 拖进度条时不会有跟随循环）。
      this.listEl.addEventListener('transitionend', (e) => {
        if (e.propertyName !== 'font-size' || !e.target.classList.contains('active')) return;
        if (this._raf) return; // 跟随循环正在跑，它自己会收敛
        this.center(false);
      });
      this.pad();
    }

    /**
     * 让第一行和最后一行也能滚到正中。
     *
     * 原来靠 CSS 的 `.lyric-list { padding: 42% 0 }` 撑上下留白，但百分比的
     * padding 是按**宽度**算的：歌词区宽 557px、高 625px 时只有 234px 留白，
     * 而「把首行推到正中」需要 (625 - 43) / 2 = 291px。结果就是开头几句和结尾
     * 几句永远差几十像素到不了中间（实测首行差 53px）。
     * 这里按容器**高度**算，用像素写回，任何窗口尺寸下都刚好够。
     */
    pad() {
      const h = this.container.clientHeight;
      if (!h) return;
      const first = this.listEl.querySelector('.lyric-line');
      if (!first) { this.listEl.style.padding = ''; this._padTop = 0; this._padBottom = 0; return; }
      // 改 padding 会让浏览器重新夹一次 scrollTop，可能派发 scroll 事件；
      // 那不是用户操作，先立守卫再改。
      this._selfScrollUntil = Math.max(this._selfScrollUntil, Date.now() + 120);
      // 半屏减半行：这样「行中心 == 容器中心」时滚动量正好用满
      const lineH = first.offsetHeight || 40;
      let pad = Math.max(0, Math.round((h - lineH) / 2));
      // 歌词比容器还短时不需要那么多留白，否则会多出一段能滚的空白。
      // 量内容高度前必须先把留白清掉，否则量到的是「内容 + 旧留白」。
      this.listEl.style.padding = '0';
      const content = this.listEl.scrollHeight;
      if (content + 2 * pad <= h) pad = Math.max(0, Math.round((h - content) / 2));
      this._padTop = pad;
      this._padBottom = pad;
      this.listEl.style.padding = pad + 'px 0';
    }

    set(raw) {
      this.lyrics.set(raw);
      this.active = -1;
      // 换歌了：上一首的"用户正在看别处"状态不该带过来，否则新歌词前 3s 不跟随
      clearTimeout(this._scrollTimer);
      this.userScrolling = false;
      this.render();
    }

    render() {
      const L = this.lyrics;
      this.listEl.innerHTML = '';
      if (L.empty) {
        this.listEl.appendChild(U.el('<div class="lyric-empty">暂无歌词</div>'));
        return;
      }
      const frag = document.createDocumentFragment();
      L.lines.forEach((line, i) => {
        const node = document.createElement('div');
        node.className = 'lyric-line';
        node.dataset.i = String(i);
        const txt = document.createElement('div');
        txt.textContent = line.text || '♪';
        node.appendChild(txt);
        if (line.trans) {
          const tr = document.createElement('div');
          tr.className = 'lyric-trans';
          tr.textContent = line.trans;
          node.appendChild(tr);
        }
        node.addEventListener('click', () => {
          if (line.time >= 0) {
            this.container.dispatchEvent(new CustomEvent('lyricseek', { detail: line.time, bubbles: true }));
          }
        });
        // 长按某句歌词 → 复制（用户 m09508 第⑦点）。
        //
        // 为什么用 contextmenu 而不是监听 mousedown 计时：桌面端本来就把右键当
        // 「更多操作」在用（封面、播放条、列表行都挂了 contextmenu），长按鼠标
        // 左键在桌面浏览器里没有任何原生语义，自己计时反而会和点击跳转抢事件
        // —— 按住 400ms 再松手，click 照样会派发，用户既跳了位置又弹了菜单。
        // 右键是干净的：一个手势一件事。
        node.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const text = line.text || '';
          if (!text) return;
          const items = [{ label: '复制歌词', onClick: () => U.copy(text) }];
          if (line.trans) {
            items.push({
              label: '复制歌词与翻译',
              onClick: () => U.copy(text + '\n' + line.trans),
            });
          }
          U.ctxMenu(items, e.clientX, e.clientY);
        });
        frag.appendChild(node);
      });
      this.listEl.appendChild(frag);
      this._stopFollow();
      // 这里是程序自己把滚动条拉回顶部，紧接着的 scroll 事件不是用户操作。
      // 以前漏了这一步：事件被 markUser() 当成"用户接管"，锁定跟随 2.6s，
      // 于是新的一句歌词先歪在下方，等锁过期才被拉回正中 —— 就是"跳一下"。
      // 守卫要在 pad() 之前立起来：pad() 会改 padding，进而可能让浏览器
      // 夹一下 scrollTop，那同样会派发 scroll 事件。
      this._selfScrollUntil = Date.now() + 260;
      this.pad();
      this.container.scrollTop = 0;
    }

    /** 停掉跟随循环。用户接管 / 重新渲染 / 复位时都要先停。 */
    _stopFollow() {
      if (this._raf) {
        cancelAnimationFrame(this._raf);
        this._raf = 0;
      }
    }

    /** 当前高亮行的中心相对容器中心的偏移（正数=在中心下方）。 */
    _delta() {
      const node = this.listEl.querySelector(`.lyric-line[data-i="${this.active}"]`);
      if (!node) return null;
      return { node, delta: U.centerDelta(this.container, node) };
    }

    /**
     * 自己驱动的缓动跟随，替代浏览器原生 smooth 滚动。
     *
     * 原生 scrollTo({behavior:'smooth'}) 有两个治不好的毛病：
     *  1. 目标位置只在调用那一刻算一次。而当前行字号是 17px→22px 过渡 240ms，
     *     行高一直在长，目标一路在变 —— 滚完就偏了几像素，只能再补一次，
     *     看着就是"跳一下"。
     *  2. 换行和"用户滚完归位"用的是同一套缓动，长距离时 Chromium 的 smooth
     *     会先慢后快再慢，和短距离的手感完全不一样。
     * 这里每帧重新读一次 rect 算目标，偏差按指数衰减逼近，所以字号怎么长都不会跳；
     * 长距离再用速度上限兜住，避免几千像素的归位跑太久。
     *
     * 关键细节：scrollTop 会被浏览器吸附到 0.5px 的整数倍（dpr=2 时实测：
     * 加 0.45px 结果不变，加 0.9px 只前进 0.5px）。如果每帧都「读 scrollTop
     * → 算增量 → 写回」，那么当剩余偏差衰减到半像素以下时增量会被四舍五入成 0，
     * 位置再也动不了，循环就永远收敛不了 —— 实测留下 5~9px 的永久偏差，
     * 请求动画帧一直跑着不停。所以缓动的累加器用浮点变量自己记，不依赖回读值。
     */
    _follow() {
      this._stopFollow();
      const c = this.container;
      // 累加器自己记浮点位置：scrollTop 会被吸附到 0.5px 的整数倍（dpr=2 实测），
      // 如果每帧都「回读 scrollTop 再算增量」，剩余偏差衰减到半像素以下时增量
      // 会被吸附成 0，位置再也动不了，循环永远收敛不了（实测留下 5~9px 永久偏差）。
      this._followTop = c.scrollTop;
      this._lastStep = 0;
      const t0 = performance.now();
      const step = (ts) => {
        this._raf = 0;
        if (this.active < 0 || this.userScrolling) return;
        const now = ts || performance.now();
        const dt = this._lastStep ? Math.min(64, Math.max(1, now - this._lastStep)) : 16;
        this._lastStep = now;
        const hit = this._delta();
        if (!hit) return;
        // 收工判据在写之前用「刚量到的」偏差判断，不能用写之前的旧值：
        // 至少跑到字号过渡结束（_followUntil），并且已经贴到半像素以内。
        // 收工时精确对齐一次，把吸附留下的零头抹掉。
        if (Math.abs(hit.delta) <= 0.5 && now > this._followUntil) {
          c.scrollTop = c.scrollTop + hit.delta;
          this._followTop = c.scrollTop;
          return;
        }
        // 每帧重新量一次"此刻该在的位置"：字号过渡期间目标一直在动，
        // 这样不会像原生 smooth 那样滚完才发现偏了
        const target = c.scrollTop + hit.delta;
        let k = 1 - Math.exp(-dt / this._followMs);
        // 起步缓冲：换行瞬间偏差最大（约一行高），纯指数缓动第一帧就会迈出
        // 6~7px —— 单帧跨度太大看着还是"顿"一下。所以前 ~90ms 把步长按比例
        // 放开，让位移从 1px 左右平滑加到正常速度，起手就没有突然的一跳。
        const ramp = Math.min(1, (now - t0) / 90);
        k *= ramp * ramp;
        let next = this._followTop + (target - this._followTop) * k;
        // 速度上限：一次跳过几十行（拖进度条）时别让缓动拖太久
        const cap = (this._followMax * dt) / 1000;
        if (next - this._followTop > cap) next = this._followTop + cap;
        else if (this._followTop - next > cap) next = this._followTop - cap;
        // 夹在可滚范围内，否则累加器会跑到界外，循环一直以为还差很远
        const max = Math.max(0, c.scrollHeight - c.clientHeight);
        if (next < 0) next = 0;
        else if (next > max) next = max;
        this._followTop = next;
        c.scrollTop = next;
        this._selfScrollUntil = Date.now() + 120;
        // 兜底超时：任何意外（元素被换掉、容器不可滚）都不能让循环一直挂着
        if (now - t0 > 2600) {
          const again = this._delta();
          if (again) c.scrollTop = c.scrollTop + again.delta;
          this._followTop = c.scrollTop;
          return;
        }
        this._raf = requestAnimationFrame(step);
      };
      this._raf = requestAnimationFrame(step);
    }

    /** 把当前高亮行拉到容器正中。animate 只在换行 / 归位时为 true。 */
    center(animate, force) {
      if (this.active < 0 || this.userScrolling) return;
      const hit = this._delta();
      if (!hit) return;
      const { node, delta } = hit;
      // 已经在正中就不动，免得每 250ms 都写一次 scrollTop
      if (Math.abs(delta) < 1 && !this._raf) return;
      // 跟随循环正在收敛，别用瞬时定位去打断它 —— 进度事件是 4Hz，
      // 换行后 250ms 内必定来一次 center(false)，抢过去就是那个"跳一下"。
      if (this._raf && !animate) return;
      const lineH = node.offsetHeight || 40;
      // 一次跳几十行（拖动进度条 / 切歌）时不做缓动，几万像素的动画纯属折磨。
      // 其余情况（换行、字号过渡结束、容器尺寸变化、用户归位）全部走同一条
      // 缓动路径，这样任何一处都不会出现瞬移。
      if (force || Math.abs(delta) <= lineH * 60) {
        // 换行后字号要从 17px 长到 22px（240ms）才定型，循环至少跑到那时候
        if (animate) this._followUntil = performance.now() + 300;
        this._follow();
        return;
      }
      // 瞬时对齐：拖动进度条 / 切歌
      this._stopFollow();
      this._selfScrollUntil = Date.now() + 200;
      U.scrollToCenter(this.container, node, false);
    }

    update(ms, force) {
      const L = this.lyrics;
      if (L.empty) return;
      const idx = L.indexAt(ms);
      const changed = idx !== this.active;
      if (!changed && !force) {
        // 行没变也要保证它还在正中：进度事件是 4Hz，容器/字号随时可能变。
        this.center(false);
        return;
      }
      const prev = this.listEl.querySelector('.lyric-line.active');
      if (prev) prev.classList.remove('active');
      this.active = idx;
      if (idx < 0) return;
      const node = this.listEl.querySelector(`.lyric-line[data-i="${idx}"]`);
      if (!node) return;
      node.classList.add('active');
      // 换行时平滑滚动，其余情况瞬时对齐 —— 每帧都跑 smooth 会和拖动/进度更新抢合成器
      this.center(changed);
    }

    reset() {
      this.active = -1;
      this._stopFollow();
      clearTimeout(this._scrollTimer);
      this.userScrolling = false;
      this._selfScrollUntil = Date.now() + 200;
      this.container.scrollTop = 0;
      const prev = this.listEl.querySelector('.lyric-line.active');
      if (prev) prev.classList.remove('active');
    }
  }

  global.Lrc = { parseLrc, alignTranslation, Lyrics, LyricView };
})(window);
