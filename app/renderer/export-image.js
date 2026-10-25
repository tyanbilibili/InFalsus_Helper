'use strict';
// Top 30 导出图：纯 Canvas 绘制，不碰 DOM 状态。
// 通过 window.IFHExport.buildTop30Image(state) 调用，所需工具来自 utils.js。
(function () {
  function chamfer(ctx, x, y, w, h, cut = 14) {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + w - cut, y);
    ctx.lineTo(x + w, y + cut);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x + cut, y + h);
    ctx.lineTo(x, y + h - cut);
    ctx.closePath();
  }

  function fitText(ctx, value, maxWidth) {
    let text = String(value || '');
    if (ctx.measureText(text).width <= maxWidth) return text;
    while (text.length > 1 && ctx.measureText(text + '…').width > maxWidth) text = text.slice(0, -1);
    return text + '…';
  }

  function loadImage(url) {
    return new Promise(resolve => {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.onload = () => resolve(image);
      image.onerror = () => resolve(null);
      image.src = url;
    });
  }

  async function buildTop30Image(state) {
    const { formatScore, formatDate, algorithmTag } = window.IFHUtils;
    if (!state?.result?.top30?.length) throw new Error('当前没有可导出的 Top 30 成绩');
    await document.fonts.ready;
    const canvas = document.createElement('canvas');
    canvas.width = 2400;
    canvas.height = 1800;
    const ctx = canvas.getContext('2d');
    const result = state.result;
    const algorithm = result?.algorithm || 'arcaea';
    const isAverage = algorithm === 'phigros';

    const background = ctx.createLinearGradient(0, 0, 2400, 1800);
    background.addColorStop(0, '#0b111d');
    background.addColorStop(0.55, '#101827');
    background.addColorStop(1, '#1a1726');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, 2400, 1800);
    ctx.strokeStyle = '#8da1d310';
    ctx.lineWidth = 1;
    for (let x = 0; x <= 2400; x += 40) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 1800); ctx.stroke();
    }
    for (let y = 0; y <= 1800; y += 40) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(2400, y); ctx.stroke();
    }
    ctx.fillStyle = '#ffffff05';
    for (let i = 0; i < 28; i++) {
      ctx.beginPath();
      ctx.moveTo(40 + i * 89, 0);
      ctx.lineTo(10 + i * 89, 360);
      ctx.lineTo(140 + i * 89, 420);
      ctx.closePath();
      ctx.fill();
    }

    ctx.fillStyle = '#edf1ff';
    ctx.font = '600 30px "IF Tech Numeric", "IF Arcaea CJK", sans-serif';
    ctx.fillText('IN FALSUS  /  TOP 30', 64, 72);
    ctx.fillStyle = '#8795b1';
    ctx.font = '16px "IF Tech Numeric", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`RATING ARCHIVE   //   ${algorithmTag(algorithm)}`, 2336, 70);
    ctx.textAlign = 'left';

    function panel(x, y, w, h, border) {
      const grad = ctx.createLinearGradient(x, y, x + w, y + h);
      grad.addColorStop(0, '#182239');
      grad.addColorStop(1, '#141b2b');
      chamfer(ctx, x, y, w, h, 20);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = border;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    panel(64, 112, 1440, 160, '#a2b1ff');
    ctx.fillStyle = '#8795b1';
    ctx.font = '14px "IF Tech Numeric", sans-serif';
    ctx.fillText('PLAYER', 96, 148);
    ctx.fillStyle = '#edf1ff';
    ctx.font = '600 34px "IF Arcaea Latin", "IF Arcaea CJK", sans-serif';
    const account = state.accounts?.find(item => item.key === state.selected_account);
    ctx.fillText(fitText(ctx, account?.label || 'LOCAL PLAYER', 1280), 96, 203);
    ctx.fillStyle = '#8795b1';
    ctx.font = '14px "IF Arcaea CJK", sans-serif';
    ctx.fillText(`${result.selected_count} 张有效谱面  /  ${result.zero_filled_slots} 个补零席位`, 96, 244);

    panel(1536, 112, 800, 160, '#e876a8');
    ctx.fillStyle = '#e876a8';
    ctx.font = '14px "IF Tech Numeric", sans-serif';
    ctx.fillText('CURRENT RATING', 1568, 148);
    ctx.fillStyle = '#edf1ff';
    ctx.font = '600 74px "IF Tech Numeric", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(result.rating_text, 2304, 238);
    ctx.textAlign = 'left';

    const covers = await Promise.all(result.top30.map(entry => loadImage(entry.cover_url)));
    function card(x, y, entry, image, index) {
      const doubled = !isAverage && index < 10;
      const color = doubled ? '#e876a8' : '#a2b1ff';
      panel(x, y, 441, 224, color);
      chamfer(ctx, x + 16, y + 14, 50, 38, 8);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.fillStyle = '#101624';
      ctx.font = '600 19px "IF Tech Numeric", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(index + 1).padStart(2, '0'), x + 41, y + 40);
      ctx.textAlign = 'left';
      if (!entry) {
        ctx.fillStyle = '#8795b1';
        ctx.font = '18px "IF Arcaea CJK", sans-serif';
        ctx.fillText('未收录 / 补零席位', x + 84, y + 40);
        ctx.textAlign = 'right';
        ctx.font = '600 35px "IF Tech Numeric", sans-serif';
        ctx.fillText('0.000', x + 416, y + 154);
        ctx.textAlign = 'left';
        return;
      }
      ctx.fillStyle = '#edf1ff';
      ctx.font = '600 19px "IF Arcaea Latin", "IF Arcaea CJK", sans-serif';
      ctx.fillText(fitText(ctx, entry.title, 330), x + 84, y + 37);
      ctx.fillStyle = color;
      ctx.font = '13px "IF Tech Numeric", "IF Arcaea CJK", sans-serif';
      ctx.fillText(`${entry.difficulty}   /   定数 ${entry.constant_display || entry.constant}   /   ${isAverage ? 'AVG' : '×' + entry.weight}`, x + 84, y + 62);

      ctx.save();
      chamfer(ctx, x + 16, y + 80, 112, 112, 12);
      ctx.clip();
      if (image) ctx.drawImage(image, x + 16, y + 80, 112, 112);
      else {
        ctx.fillStyle = '#0d1524';
        ctx.fillRect(x + 16, y + 80, 112, 112);
        ctx.fillStyle = '#60708e';
        ctx.font = '12px "IF Tech Numeric", sans-serif';
        ctx.fillText('NO ART', x + 40, y + 140);
      }
      ctx.restore();

      ctx.fillStyle = '#8795b1';
      ctx.font = '11px "IF Tech Numeric", sans-serif';
      ctx.fillText('RATING', x + 146, y + 100);
      ctx.fillStyle = '#edf1ff';
      ctx.font = '600 34px "IF Tech Numeric", sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(entry.rating_display.slice(0, -1), x + 416, y + 116);
      ctx.fillStyle = '#cbd4e8';
      ctx.font = '16px "IF Tech Numeric", sans-serif';
      ctx.fillText(`SCORE  ${formatScore(entry.score)}`, x + 416, y + 148);
      ctx.fillStyle = color;
      ctx.font = '15px "IF Tech Numeric", sans-serif';
      ctx.fillText(`CONTRIB  ${entry.contribution_display}`, x + 416, y + 178);
      ctx.fillStyle = '#8795b1';
      ctx.font = '11px "IF Tech Numeric", sans-serif';
      const counts = entry.counts || {};
      ctx.fillText(`S ${counts.shiny ?? '—'}  /  P ${counts.perfect ?? '—'}  /  N ${counts.near ?? '—'}  /  M ${counts.miss ?? '—'}`, x + 416, y + 207);
      ctx.textAlign = 'left';
    }

    for (let index = 0; index < 30; index++) {
      const x = 64 + (index % 5) * 457;
      const y = 304 + Math.floor(index / 5) * 240;
      card(x, y, result.top30[index] || null, covers[index] || null, index);
    }
    ctx.fillStyle = '#8795b1';
    ctx.font = '12px "IF Arcaea CJK", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(formatDate(new Date().toISOString()), 2336, 1762);
    ctx.textAlign = 'left';

    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => blob ? blob.arrayBuffer().then(resolve) : reject(new Error('图片生成失败')), 'image/png');
    });
  }


  window.IFHExport = { buildTop30Image };
})();
