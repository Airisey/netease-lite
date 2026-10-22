'use strict';
/**
 * Runs in <head>, before the stylesheets, in every window (main + both mini
 * windows). Its only job is to stamp `data-skin` on <html> from the value the
 * main process injected into argv, so the first paint is already the right
 * theme. The authoritative value still comes from config later (app.js reads
 * it back); this is purely to kill the flash of the wrong skin.
 */
(function () {
  // 这张表必须和 js/skins.js 的 SKINS 对齐。boot.js 在所有脚本之前跑，
  // 拿不到 skins.js 里的列表，所以只能在这里再列一遍 —— 加皮肤时两处都要改。
  // 它只用来兜底：argv 里出现不认识的 id（旧配置、手改的 config.json）时退回经典黑，
  // 免得打出一个没有任何规则的 data-skin，界面变成无皮肤的裸样式。
  var KNOWN = { classic: 1, light: 1, swiss: 1, sunset: 1, arcade: 1 };
  // 深色皮肤名单。注意「经典黑是唯一深色皮肤」这句话已经不成立了 ——
  // 落日余晖也是深底，用 skin === 'classic' 判断会让它退回浅色滚动条。
  var DARK = { classic: 1, sunset: 1 };
  var skin = 'classic';
  try {
    if (window.ne && window.ne.bootSkin) skin = window.ne.bootSkin;
  } catch (e) { /* keep the default */ }
  if (!KNOWN[skin]) skin = 'classic';
  var el = document.documentElement;
  el.setAttribute('data-skin', skin);
  // `<body>` is not parsed yet, so `color-scheme` on <html> is what stops the
  // scrollbar / form controls from painting in the OS theme during the gap.
  el.style.colorScheme = DARK[skin] ? 'dark' : 'light';
})();
