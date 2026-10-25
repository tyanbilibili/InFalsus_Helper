'use strict';
// 各页面共用的格式化工具；app.js 与 export-image.js 都从这里取，避免两份实现。
(function () {
  /** 游戏分数加千分位；非纯数字时显示占位符。 */
  function formatScore(score) {
    const text = String(score ?? '');
    return /^\d+$/.test(text) ? Number(text).toLocaleString('en-US') : '—';
  }

  /** 本地时间的「年-月-日 时:分:秒」。 */
  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    }).format(date);
  }

  window.IFHUtils = { formatScore, formatDate };
})();
