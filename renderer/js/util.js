/* ============================================================
   通用工具
   ============================================================ */
(function (global) {
  'use strict';

  const U = {};

  /** 毫秒 -> mm:ss */
  U.fmtTime = function (ms) {
    if (!ms || ms < 0 || !isFinite(ms)) return '00:00';
    const total = Math.floor(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  };

  /** 播放量等大数字 -> 万 / 亿 */
  U.fmtCount = function (n) {
    if (!n || n < 0) return '0';
    if (n >= 1e8) return (n / 1e8).toFixed(n >= 1e9 ? 0 : 1) + '亿';
    if (n >= 1e4) return (n / 1e4).toFixed(n >= 1e5 ? 0 : 1) + '万';
    return String(n);
  };

  /**
   * 角标专用的大数字缩写：只保留整数万/亿。
   * `fmtCount` 会给到 "7.0万" 这种 4 字串，放进播放条上 14px 高的小圆角标里
   * 会把 28px 的按钮撑出界，所以角标一律砍掉小数位（7万 / 197万）。
   */
  U.fmtBadge = function (n) {
    if (!n || n < 0) return '';
    if (n >= 1e8) return (n / 1e8).toFixed(0) + '亿';
    if (n >= 1e4) return (n / 1e4).toFixed(0) + '万';
    return String(n);
  };

  /** 时间戳 -> 2024-05-01 / 2024-05-01 12:30 */
  U.fmtDate = function (ms, withTime) {
    if (!ms) return '';
    const d = new Date(ms);
    const p = (x) => String(x).padStart(2, '0');
    const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    return withTime ? `${day} ${p(d.getHours())}:${p(d.getMinutes())}` : day;
  };

  /** 字节数 -> 1.2 GB / 340 MB / 12 KB。1024 进制，跟资源管理器一致。 */
  U.fmtSize = function (bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + units[i];
  };

  /** 时间戳 -> 刚刚 / 5分钟前 / 3天前 / 2024-05-01 */
  U.fmtRelative = function (ms) {
    if (!ms) return '';
    const diff = Date.now() - ms;
    if (diff < 0) return U.fmtDate(ms);
    const min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return min + '分钟前';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + '小时前';
    const day = Math.floor(hr / 24);
    if (day < 30) return day + '天前';
    if (day < 365) return Math.floor(day / 30) + '个月前';
    return U.fmtDate(ms);
  };

  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  U.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
  };

  U.debounce = function (fn, ms) {
    let t = null;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  };

  U.throttle = function (fn, ms) {
    let last = 0, timer = null, lastArgs = null;
    return function (...args) {
      const now = Date.now();
      lastArgs = args;
      if (now - last >= ms) {
        last = now;
        fn.apply(this, args);
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          last = Date.now();
          fn.apply(this, lastArgs);
        }, ms - (now - last));
      }
    };
  };

  /** HTML 字符串 -> 元素 */
  U.el = function (html) {
    const t = document.createElement('template');
    t.innerHTML = String(html).trim();
    return t.content.firstElementChild;
  };

  /** 网易云图床支持 ?param=WxH 直接取缩略图，省带宽、加载更快 */
  U.cover = function (url, size) {
    if (!url) return '';
    if (!size) return url;
    return url + (url.includes('?') ? '&' : '?') + 'param=' + size + 'y' + size;
  };

  U.sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------- Toast

  U.toast = function (msg, type, ms) {
    const wrap = document.getElementById('toastWrap');
    if (!wrap) return;
    const node = U.el(`<div class="toast ${type || ''}">${U.esc(msg)}</div>`);
    wrap.appendChild(node);
    // 最多同时显示 3 条
    while (wrap.children.length > 3) wrap.removeChild(wrap.firstChild);
    setTimeout(() => {
      node.classList.add('out');
      setTimeout(() => node.remove(), 220);
    }, ms || 2400);
  };

  U.toastErr = (msg) => U.toast(msg, 'err', 3200);
  U.toastOk = (msg) => U.toast(msg, 'ok');

  // ---------------------------------------------------------- 右键菜单

  let ctxOpen = false;

  U.hideCtxMenu = function () {
    const menu = document.getElementById('ctxMenu');
    if (menu && !menu.hidden) {
      menu.hidden = true;
      menu.innerHTML = '';
    }
    ctxOpen = false;
  };

  /**
   * items: [{ label, icon?, disabled?, onClick } | 'sep']
   */
  U.ctxMenu = function (items, x, y) {
    const menu = document.getElementById('ctxMenu');
    if (!menu) return;
    menu.innerHTML = '';
    for (const it of items) {
      if (it === 'sep' || it.type === 'sep') {
        menu.appendChild(U.el('<div class="ctx-sep"></div>'));
        continue;
      }
      const icon = it.icon ? `<svg viewBox="0 0 24 24" width="14" height="14">${it.icon}</svg>` : '';
      const node = U.el(`<div class="ctx-item">${icon}<span>${U.esc(it.label)}</span></div>`);
      if (it.disabled) {
        node.style.opacity = '.4';
        node.style.pointerEvents = 'none';
      } else {
        node.addEventListener('click', () => {
          U.hideCtxMenu();
          it.onClick && it.onClick();
        });
      }
      menu.appendChild(node);
    }
    menu.hidden = false;
    ctxOpen = true;
    // 先测量再定位，保证不出屏
    const rect = menu.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 6);
    const top = Math.min(y, window.innerHeight - rect.height - 6);
    menu.style.left = Math.max(4, left) + 'px';
    menu.style.top = Math.max(4, top) + 'px';
  };

  document.addEventListener('mousedown', (e) => {
    if (ctxOpen && !e.target.closest('#ctxMenu')) U.hideCtxMenu();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') U.hideCtxMenu();
  });
  window.addEventListener('blur', U.hideCtxMenu);
  window.addEventListener('resize', U.hideCtxMenu);

  /**
   * 复制一段文字到剪贴板，成功与否都弹一句提示（用户 m09508 第⑦点）。
   *
   * 单独抽出来是因为三个调用点（歌名、歌词行、歌词行带翻译）行为必须一致：
   * 复制本身没有任何可见反馈，不弹提示用户会以为没点上；而失败时也要说
   * 「复制失败」而不是静默 —— `navigator.clipboard` 在非安全上下文里是
   * undefined，`writeText` 也可能被拒绝（没有用户手势时）。
   *
   * 注意 `writeText` 失败后**还要再试一次 execCommand**：它失败最常见的原因是
   * 窗口没有焦点（Document is not focused），而这在真机上偶发（切回来太快、
   * 菜单刚关掉）。既然失败代价是用户手动选中再按 Ctrl+C，多试一条路值得。
   */
  U.copy = function (text) {
    const legacy = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch (e) {
        return false;
      }
    };
    const fallback = () => (legacy() ? U.toastOk('已复制') : U.toast('复制失败'));
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => U.toastOk('已复制'), fallback);
      return;
    }
    fallback();
  };

  // ---------------------------------------------------------- 滚动容器

  /** 让子元素在容器内可见，必要时滚动 */
  U.scrollIntoViewIfNeeded = function (container, child, smooth) {
    if (!container || !child) return;
    const cRect = container.getBoundingClientRect();
    const kRect = child.getBoundingClientRect();
    const topGap = kRect.top - cRect.top;
    const bottomGap = kRect.bottom - cRect.bottom;
    if (topGap < 0) {
      container.scrollTop += topGap - cRect.height * 0.3;
    } else if (bottomGap > 0) {
      container.scrollTop += bottomGap + cRect.height * 0.3;
    }
  };

  /**
   * 把某元素平滑滚动到容器垂直中央，返回目标 scrollTop。
   *
   * 这里刻意不用 child.offsetTop：滚动容器（.lyric-scroll）是 static 定位，
   * 歌词行的 offsetParent 其实是外层的 .np-body，offsetTop 的参照系不是
   * 容器的内容原点，直接用会整体偏掉一个容器的 offsetTop（实测偏 88px，
   * 正好是「当前歌词不在正中」的原因）。改用两个 rect 的中心差，
   * 结果与 offsetParent 是谁无关。
   */
  U.scrollToCenter = function (container, child, animate) {
    if (!container || !child) return 0;
    const cRect = container.getBoundingClientRect();
    const aRect = child.getBoundingClientRect();
    const delta = (aRect.top + aRect.height / 2) - (cRect.top + cRect.height / 2);
    const target = container.scrollTop + delta;
    if (animate && 'scrollBehavior' in container.style) {
      container.scrollTo({ top: target, behavior: 'smooth' });
    } else {
      container.scrollTop = target;
    }
    return target;
  };

  /** 元素中心相对容器中心的偏移（px，正数表示偏下） */
  U.centerDelta = function (container, child) {
    if (!container || !child) return 0;
    const cRect = container.getBoundingClientRect();
    const aRect = child.getBoundingClientRect();
    return (aRect.top + aRect.height / 2) - (cRect.top + cRect.height / 2);
  };

  global.U = U;
})(window);
