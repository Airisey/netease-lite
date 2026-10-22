'use strict';
/**
 * 皮肤（第 8 / 9 点）
 *
 * 皮肤只做一件事：把 `data-skin` 打到 <html> 上。真正的外观全部在 CSS 里——
 * `styles.css` 就是「经典黑」，`skins.css` 里是 `html[data-skin="light"]` 的覆盖。
 * 这样加皮肤不需要动 JS，也不需要动 index.html 的结构。
 *
 * 首屏的 data-skin 由 `js/boot.js` 在样式表之前写好（值来自 preload 注入的
 * argv），这里负责的是运行时的切换与持久化。
 */
(function (global) {
  const SKINS = [
    {
      id: 'classic',
      name: '经典黑',
      desc: '深色、紧凑、原汁原味的客户端观感',
      // 色块：左半是强调色，右半是底色，一眼看出深浅
      swatch: ['#ec4141', '#16161a'],
    },
    {
      id: 'light',
      name: '现代白',
      desc: '白底、细线、平面化的极简界面',
      // 色块：左半是强调色，右半是底色，一眼看出深浅。值必须与 skins.css
      // 的 --accent 一致，否则菜单里的小方块和实际界面不是一个蓝。
      swatch: ['#2b63f0', '#ffffff'],
    },
    {
      id: 'swiss',
      name: '瑞士风',
      desc: '纸白底、黑字、红色细线，国际主义排版',
      swatch: ['#e93b1a', '#f5f2eb'],
    },
    {
      id: 'sunset',
      name: '落日余晖',
      desc: '暖褐黑底、夕照橙金，地平线上一轮落日',
      // 底色是暖调的近黑（不是经典黑那种中性灰黑），强调色取太阳的橙金，
      // 但压深到 #bd5730 才够白字压填充的对比度（4.60:1），见 skins.css 的注释。
      swatch: ['#ef8a5c', '#121010'],
    },
    {
      id: 'arcade',
      name: '街机风',
      desc: '奶油底、糖果色块、2px 黑描边与硬投影',
      // 强调色是参考图里那块黄。它比任何一款皮肤的强调色都亮，白字压上去
      // 只有 1.3:1，所以这一款里所有「强调色填充」上的文字都改成了墨黑，
      // 详见 skins.css「五、街机风」的注释。
      swatch: ['#f6d467', '#f7f8f3'],
    },
  ];

  const IDS = SKINS.map((s) => s.id);
  // 深色皮肤（决定滚动条 / 原生控件画深色还是浅色）。
  // 原来这里写的是 `next === 'classic' ? 'dark' : 'light'`，隐含「经典黑是唯一
  // 深色皮肤」—— 落日余晖加进来之后这个假设就不成立了，改成查这张表。
  const DARK = { classic: 1, sunset: 1 };

  const Skins = {
    list: SKINS,
    _current: 'classic',
    _menu: null,
    _btn: null,
    _outside: null,

    current() { return this._current; },
    name(id) { const s = SKINS.find((x) => x.id === (id || this._current)); return s ? s.name : '经典黑'; },

    /** 只改 DOM，不落盘。boot.js 已经打过一次，这里是运行时切换用。 */
    apply(id) {
      const next = IDS.includes(id) ? id : 'classic';
      this._current = next;
      const el = document.documentElement;
      el.setAttribute('data-skin', next);
      // color-scheme 只分「深 / 浅」两档，由上面的 DARK 表决定
      el.style.colorScheme = DARK[next] ? 'dark' : 'light';
      // 皮肤可能改变滚动条/阴影等由 JS 读取的观感，广播一下让需要的模块响应
      if (global.store) global.store.emit('skin:changed', next);
      return next;
    },

    async set(id) {
      const next = this.apply(id);
      try { await global.ne.skin.set(next); } catch (e) { console.warn('[skins] save', e); }
      this.syncMenu();
      return next;
    },

    /** 启动时调用：用 boot.js 已经定下的值，并订阅主进程的换肤广播。 */
    init() {
      const boot = (global.ne && global.ne.bootSkin) || 'classic';
      this.apply(boot);
      if (global.ne && global.ne.skin) {
        global.ne.skin.onChanged((id) => {
          this.apply(id);
          this.syncMenu();
        });
      }
      return this._current;
    },

    // ---------------------------------------------------------- 下拉菜单
    bindMenu(btn, menu) {
      this._btn = btn;
      this._menu = menu;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleMenu();
      });
      // 点菜单里的条目由 renderMenu 的委托处理
      menu.addEventListener('click', (e) => {
        const item = e.target.closest('.skin-item');
        if (!item) return;
        e.stopPropagation();
        this.set(item.dataset.skin);
        this.closeMenu();
      });
      this._outside = (e) => {
        if (!this._menu || this._menu.hidden) return;
        if (e.target.closest('#skinMenu') || e.target.closest('#tbSkin')) return;
        this.closeMenu();
      };
      document.addEventListener('mousedown', this._outside);
      this.renderMenu();
    },

    renderMenu() {
      if (!this._menu) return;
      this._menu.innerHTML = SKINS.map((s) => `
        <button class="skin-item" data-skin="${s.id}" title="${U.esc(s.desc)}">
          <span class="skin-swatch" style="--sw-a:${s.swatch[0]};--sw-b:${s.swatch[1]}"></span>
          <span class="skin-name">${U.esc(s.name)}</span>
          <span class="skin-tick">${global.icons(global.ICON.check, 14)}</span>
        </button>`).join('');
      this.syncMenu();
    },

    syncMenu() {
      if (!this._menu) return;
      for (const el of this._menu.querySelectorAll('.skin-item')) {
        el.classList.toggle('on', el.dataset.skin === this._current);
      }
    },

    toggleMenu() { this._menu && this._menu.hidden ? this.openMenu() : this.closeMenu(); },

    openMenu() {
      if (!this._menu) return;
      this.renderMenu();
      this._menu.hidden = false;
      if (this._btn) this._btn.setAttribute('aria-expanded', 'true');
    },

    closeMenu() {
      if (!this._menu) return;
      this._menu.hidden = true;
      if (this._btn) this._btn.setAttribute('aria-expanded', 'false');
    },
  };

  global.Skins = Skins;
})(window);
