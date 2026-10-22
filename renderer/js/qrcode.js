/* ============================================================
   二维码渲染（基于 vendor/qrcode-generator.js）
   ============================================================ */
(function (global) {
  'use strict';

  /**
   * 把文本画成二维码。
   * @param {HTMLCanvasElement} canvas
   * @param {string} text
   * @param {object} [opt] { size, margin, dark, light }
   */
  function draw(canvas, text, opt) {
    opt = Object.assign({ size: 180, margin: 4, dark: '#000000', light: '#ffffff' }, opt || {});
    const ctx = canvas.getContext('2d');
    const size = opt.size;
    canvas.width = size;
    canvas.height = size;
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';

    ctx.fillStyle = opt.light;
    ctx.fillRect(0, 0, size, size);

    // 自动选择版本号（0 = auto）；M 级纠错在手机屏上足够稳
    let qr = null;
    for (const level of ['M', 'L', 'Q', 'H']) {
      try {
        const q = global.qrcode(0, level);
        q.addData(text);
        q.make();
        qr = q;
        break;
      } catch (e) { /* 数据过长，降级纠错级别重试 */ }
    }
    if (!qr) {
      ctx.fillStyle = '#c33';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('二维码生成失败', size / 2, size / 2);
      return false;
    }

    const count = qr.getModuleCount();
    const margin = opt.margin;
    const cell = (size - margin * 2) / count;
    ctx.fillStyle = opt.dark;
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (!qr.isDark(r, c)) continue;
        // 用 ceil 消除相邻模块间的亚像素缝隙
        const x = Math.floor(margin + c * cell);
        const y = Math.floor(margin + r * cell);
        const w = Math.ceil(margin + (c + 1) * cell) - x;
        const h = Math.ceil(margin + (r + 1) * cell) - y;
        ctx.fillRect(x, y, w, h);
      }
    }
    return true;
  }

  global.QR = { draw };
})(window);
