'use strict';

const $ = id => document.getElementById(id);
const api = window.helperAPI;
const phaseLabels = {
  Unknown: '等待阶段',
  Menu: '菜单',
  Playing: '游玩中',
  Results: '结算'
};
let currentState = null;
let catalog = [];
let records = [];
let toastTimer = null;
let lastRenderedRating = null;
let activePage = 'dashboard';
let preciseDrafts = {};
// 0 = game order, 1 = ULT constant desc, 2 = FBD constant desc
let constantsSortMode = 0;
let nicknameEscape = false;
const SORT_LABELS = ['按 ULT 排序', '按 FBD 排序', '恢复游戏顺序'];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatScore(score) {
  const text = String(score ?? '');
  return /^\d+$/.test(text) ? Number(text).toLocaleString('en-US') : '—';
}

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

function showToast(message, error = false) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').className = 'toast' + (error ? ' error' : '');
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4200);
}

function coverNode(url, title) {
  const frame = el('span', 'cover');
  const img = el('img');
  img.src = url;
  img.alt = '';
  img.loading = 'lazy';
  img.addEventListener('error', () => {
    img.remove();
    frame.append(el('span', 'cover-missing', 'NO ART'));
  }, { once: true });
  frame.title = title || '';
  frame.append(img);
  return frame;
}

function setPhaseTag(id, phase) {
  const node = $(id);
  node.textContent = phaseLabels[phase] || phase || 'UNKNOWN';
  node.style.color = phase === 'Results' ? '#e876a8' :
    phase === 'Playing' ? '#ffba73' :
    phase === 'Menu' ? '#a2b1ff' : '#8795b1';
}

function switchPage(page) {
  if (page === 'constants' && currentState?.settings?.developerMode !== true) page = 'dashboard';
  activePage = page;
  document.querySelectorAll('.page').forEach(node => {
    node.classList.toggle('active', node.id === `page-${page}`);
  });
  document.querySelectorAll('.nav-item').forEach(node => {
    node.classList.toggle('active', node.dataset.page === page);
  });
  if (page === 'catalog') loadCatalog();
  if (page === 'constants') loadConstants();
  if (page === 'records') loadRecords();
}

function renderRatingBars(selected) {
  const bars = $('rating-bars');
  bars.replaceChildren(...Array.from({ length: 30 }, (_, index) => {
    const bar = el('i');
    if (index < 10) bar.classList.add('double');
    if (index < selected) bar.classList.add('filled');
    return bar;
  }));
}

function renderTop30(result) {
  const list = $('top30-list');
  list.replaceChildren();
  const rows = result?.top30 || [];
  if (!rows.length) {
    list.append(el('div', 'empty-state', '暂无可计算记录。请启动游戏并完成一首歌曲。'));
    return;
  }
  for (const entry of rows) {
    const row = el('article', 'top-row' + (entry.weight === 2 ? ' double' : ''));
    row.append(el('div', 'rank', String(entry.rank).padStart(2, '0')));
    row.append(coverNode(entry.cover_url, entry.title));
    const song = el('div', 'song-name');
    song.append(el('b', '', entry.title));
    song.append(el('span', '', `${entry.difficulty}  /  ${entry.chart_id}`));
    row.append(song);
    const score = el('div', 'metric', formatScore(entry.score));
    score.append(el('small', '', 'GAME SCORE'));
    row.append(score);
    const constant = el('div', 'metric', entry.constant_display || entry.constant);
    constant.append(el('small', '', '定数'));
    row.append(constant);
    const contribution = el('div', 'metric', entry.contribution_display);
    contribution.append(el('small', '', '加权贡献'));
    row.append(contribution);
    const rating = el('div', 'metric top-rating', entry.rating_display.slice(0, -1));
    rating.append(el('small', '', `单谱 / ${entry.formula_zone === 'cap_plus_2' ? 'CAP +2' : 'SCORE CURVE'}`));
    row.append(rating);
    row.append(el('div', 'weight', `×${entry.weight}`));
    list.append(row);
  }
}

function populateAccounts(state) {
  const select = $('account-select');
  select.replaceChildren();
  for (const account of state.accounts || []) {
    const option = new Option(account.label, account.key);
    option.selected = account.key === state.selected_account;
    select.append(option);
  }
  select.hidden = (state.accounts || []).length <= 1;
}

function syncSettings(state) {
  const settings = state.settings || {};
  const input = settings.input || {};
  $('developer-mode').checked = settings.developerMode === true;
  $('overlay-enabled').checked = settings.overlayEnabled !== false;
  $('overlay-key').value = settings.overlayKey || 'F5';
  $('input-enabled').checked = input.enabled !== false;
  $('input-sounds').checked = input.playSounds !== false;
  $('swallow-caps').checked = input.swallowCapsLock === true;
  $('remap-keyboard').checked = input.remapKeyboard === true;
  $('remap-mouse').checked = input.remapMouse === true;
  $('block-hotkeys').checked = input.blockScreenshotHotkeys === true;
  $('swallow-caps').disabled = input.remapKeyboard === true;
}

function render(state) {
  if (!state) return;
  currentState = state;
  const result = state.result;
  const rating = result?.rating_text || '--.---';
  $('rating-value').textContent = rating;
  if (lastRenderedRating && lastRenderedRating !== rating) {
    $('rating-value').animate(
      [{ transform: 'scale(.88)', color: '#ffffff' }, { transform: 'scale(1)', color: '#cad3ff' }],
      { duration: 420, easing: 'cubic-bezier(.2,.8,.2,1)' }
    );
  }
  lastRenderedRating = rating;
  $('rating-change').textContent = state.rating_change
    ? `本次变化 ${state.rating_change}`
    : result ? '当前最佳 Top 30 加权结果' : '等待有效记录';
  $('rating-rule').textContent = 'SCORE CURVE / 98M BASE';
  renderRatingBars(result?.selected_count || 0);
  renderTop30(result);

  const account = (state.accounts || []).find(item => item.key === state.selected_account);
  const nickname = state.nickname && state.nickname !== 'LOCAL PLAYER' ? state.nickname : '';
  const nicknameInput = $('player-nickname');
  if (document.activeElement !== nicknameInput) nicknameInput.value = nickname;
  nicknameInput.placeholder = account ? account.short : 'LOCAL PLAYER';
  $('player-account').textContent = account ? account.short : '等待发现';
  $('player-selected').textContent = `${result?.selected_count ?? 0} / 30`;
  $('player-observed').textContent = String(state.observed_count ?? 0);
  $('player-history').textContent = state.coverage
    ? `${state.coverage.history_occupied} / ${state.coverage.history_capacity}`
    : '— / 1024';
  $('last-sync').textContent = formatDate(state.last_scan_at);
  populateAccounts(state);

  $('game-path').textContent = state.installation?.path || '尚未定位 In Falsus';
  $('game-build').textContent = state.installation?.build_id || '—';
  $('catalog-source').textContent = state.catalog?.source === 'game' ? 'LOCAL DATA' : 'BUNDLED';
  $('phase-notice').textContent = state.phase?.notice || '等待游戏连接';
  $('overlay-state-label').textContent = state.phase?.phase === 'Results'
    ? '结算展开'
    : state.phase?.phase === 'Playing' ? '游玩隐藏' : '待机隐藏';
  setPhaseTag('phase-tag', state.phase?.phase);
  setPhaseTag('phase-settings-tag', state.phase?.phase);

  $('side-songs').textContent = state.catalog?.song_count ?? '—';
  $('side-charts').textContent = state.catalog?.chart_count ?? '—';
  $('side-records').textContent = state.observed_count ?? '—';
  $('settings-game-path').textContent = state.installation?.path || '尚未定位';
  $('nav-constants').hidden = state.settings?.developerMode !== true;
  if (state.settings?.developerMode !== true && activePage === 'constants') switchPage('dashboard');
  const gameRunning = Number(state.phase?.pid || 0) > 0;
  $('quick-launch').disabled = !state.installation;
  $('settings-launch').disabled = !state.installation;
  $('quick-launch').textContent = gameRunning ? '切回游戏' : '启动游戏';
  $('settings-launch').textContent = gameRunning ? '切回游戏' : '一键启动';

  const input = state.input?.status || {};
  $('input-state-tag').textContent = input.running ? (input.enabled ? 'LISTENING' : 'PAUSED') : 'OFFLINE';
  $('input-state-tag').style.color = input.running ? '#72e0ba' : '#ff7e9d';
  $('input-detail').textContent = input.error
    ? `输入服务：${input.error}`
    : input.lastTrigger
      ? `最近触发：${input.lastTrigger.name} ${input.lastTrigger.time}${input.lastTrigger.ok ? '' : '（播放失败）'}`
      : input.running ? '键盘与鼠标钩子已安装；Alt + Z 可暂停。' : '输入服务正在启动…';

  $('global-dot').className = 'status-dot' + (state.error ? ' error' : '');
  $('global-status').textContent = state.error
    ? `诊断：${state.error}`
    : state.phase?.phase === 'Playing' ? '游戏游玩中 / 浮窗折叠'
      : state.phase?.phase === 'Results' ? '结算检测 / 浮窗展开'
        : state.installation ? '本地数据已连接' : '等待连接游戏';
  $('first-run').hidden = !!state.installation;
  syncSettings(state);
}

function inputPatch() {
  return {
    overlayEnabled: $('overlay-enabled').checked,
    overlayKey: $('overlay-key').value,
    developerMode: $('developer-mode').checked,
    input: {
      enabled: $('input-enabled').checked,
      playSounds: $('input-sounds').checked,
      swallowCapsLock: $('swallow-caps').checked,
      remapKeyboard: $('remap-keyboard').checked,
      remapMouse: $('remap-mouse').checked,
      blockScreenshotHotkeys: $('block-hotkeys').checked
    }
  };
}

async function updateSettings() {
  try {
    const state = await api.updateSettings(inputPatch());
    render(state);
    if (state.settings?.developerMode) await loadConstants();
    showToast('设置已保存并应用到全局输入服务。');
  } catch (error) {
    showToast(error.message, true);
  }
}

async function loadCatalog() {
  try {
    catalog = await api.getCatalog();
    renderCatalog();
  } catch (error) {
    $('catalog-grid').replaceChildren(el('div', 'empty-state', error.message));
  }
}

function renderCatalog() {
  const query = $('catalog-search').value.trim().toLowerCase();
  const visible = catalog.filter(song =>
    !query || [song.title, song.title_en, song.artist, song.pack]
      .filter(Boolean).some(value => String(value).toLowerCase().includes(query))
  );
  const grid = $('catalog-grid');
  grid.replaceChildren();
  if (!visible.length) {
    grid.append(el('div', 'empty-state', '没有找到匹配的歌曲。'));
    return;
  }
  const order = { MIN: 0, EVO: 1, ULT: 2, FBD: 3 };
  for (const song of visible) {
    const card = el('article', 'catalog-card');
    card.append(coverNode(song.cover_url, song.title));
    const copy = el('div', 'catalog-copy');
    copy.append(el('h3', '', song.title));
    copy.append(el('p', '', `${song.artist || '未知艺术家'} / ${song.pack || '未分类'}`));
    const charts = el('div', 'charts');
    for (const chart of [...song.charts].sort((a, b) => order[a.difficulty] - order[b.difficulty])) {
      charts.append(el('span', 'chart-chip ' + chart.difficulty.toLowerCase(),
        `${chart.difficulty} · ${chart.constant_display || chart.constant}`));
    }
    copy.append(charts);
    card.append(copy);
    grid.append(card);
  }
}

async function loadConstants() {
  try {
    catalog = await api.getCatalog();
    preciseDrafts = {};
    for (const song of catalog) {
      for (const chart of song.charts) {
        preciseDrafts[chart.chart_id] = chart.constant_display || Number(chart.base_constant).toFixed(1);
      }
    }
    renderConstants();
  } catch (error) {
    $('constants-grid').replaceChildren(el('div', 'empty-state', error.message));
  }
}

function editConstant(chip, chart) {
  const input = el('input', 'constant-chip-input');
  input.type = 'text';
  input.inputMode = 'decimal';
  input.value = preciseDrafts[chart.chart_id] || chart.constant_display;
  input.maxLength = 4;
  chip.replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = commit => {
    if (finished) return;
    finished = true;
    if (commit) {
      const value = input.value.trim();
      if (!/^\d{1,2}(?:\.\d)?$/.test(value) || Number(value) > 99.9) {
        showToast('精确定数必须是 0.0–99.9 之间的一位小数。', true);
        input.replaceWith(chip);
        return;
      }
      preciseDrafts[chart.chart_id] = Number(value).toFixed(1);
    }
    input.replaceWith(chip);
    chip.textContent = `${chart.difficulty} · ${preciseDrafts[chart.chart_id]}`;
    chip.classList.toggle('modified', preciseDrafts[chart.chart_id] !== chart.base_constant_display);
  };
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); finish(true); }
    if (event.key === 'Escape') { event.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true), { once: true });
}

function renderConstants() {
  const query = $('constants-search').value.trim().toLowerCase();
  let visible = catalog.filter(song =>
    !query || [song.title, song.title_en, song.artist, song.pack]
      .filter(Boolean).some(value => String(value).toLowerCase().includes(query))
  );
  if (constantsSortMode !== 0) {
    const primary = constantsSortMode === 1 ? 'ULT' : 'FBD';
    const secondary = constantsSortMode === 1 ? 'FBD' : 'ULT';
    const chartValue = (song, difficulty) => Number(
      preciseDrafts[song.charts.find(chart => chart.difficulty === difficulty)?.chart_id] || 0
    );
    visible = [...visible].sort((a, b) =>
      chartValue(b, primary) - chartValue(a, primary) ||
      chartValue(b, secondary) - chartValue(a, secondary) ||
      a.title.localeCompare(b.title, 'zh-CN')
    );
  }
  const grid = $('constants-grid');
  grid.replaceChildren();
  if (!visible.length) {
    grid.append(el('div', 'empty-state', '没有找到匹配的歌曲。'));
    return;
  }
  const order = { MIN: 0, EVO: 1, ULT: 2, FBD: 3 };
  for (const song of visible) {
    const card = el('article', 'catalog-card');
    card.append(coverNode(song.cover_url, song.title));
    const copy = el('div', 'catalog-copy');
    copy.append(el('h3', '', song.title));
    copy.append(el('p', '', `${song.artist || '未知艺术家'} / ${song.pack || '未分类'}`));
    const charts = el('div', 'charts precise-charts');
    for (const chart of [...song.charts].sort((a, b) => order[a.difficulty] - order[b.difficulty])) {
      const chip = el('span', 'chart-chip editable ' + chart.difficulty.toLowerCase());
      chip.textContent = `${chart.difficulty} · ${preciseDrafts[chart.chart_id]}`;
      chip.classList.toggle('modified', preciseDrafts[chart.chart_id] !== chart.base_constant_display);
      chip.title = '双击修改精确定数';
      chip.addEventListener('dblclick', () => editConstant(chip, chart));
      charts.append(chip);
    }
    copy.append(charts);
    card.append(copy);
    grid.append(card);
  }
}

async function saveConstants() {
  try {
    const state = await api.savePreciseConstants(preciseDrafts);
    render(state);
    await loadConstants();
    showToast('精确定数已保存，并已用于 Rating 与 Top30 计算。');
  } catch (error) {
    showToast(error.message || String(error), true);
  }
}

async function saveNickname(value) {
  try {
    const state = await api.setNickname(value);
    render(state);
    showToast(String(value || '').trim() ? '昵称已更新。' : '已恢复为存档编号显示。');
  } catch (error) {
    showToast(error.message || String(error), true);
  }
}

async function loadRecords() {
  try {
    records = await api.getRecords(600);
    renderRecords();
  } catch (error) {
    $('record-list').replaceChildren(el('div', 'empty-state', error.message));
  }
}

function renderRecords() {
  const list = $('record-list');
  list.replaceChildren();
  if (!records.length) {
    list.append(el('div', 'empty-state', '历史记录尚未读取。'));
    return;
  }
  for (const record of records) {
    const row = el('div', 'record-row');
    const song = el('div', 'record-song');
    song.append(el('b', '', record.title));
    song.append(el('span', '', `${record.difficulty} / ${record.chart_id}`));
    row.append(song);
    row.append(el('span', 'num', formatScore(record.score)));
    row.append(el('span', 'num',
      `${record.counts.shiny} / ${record.counts.perfect} / ${record.counts.near} / ${record.counts.miss}`));
    row.append(el('span', 'num constant-cell', record.constant_display || record.constant));
    row.append(el('span', 'rating-cell', record.single_rating_text));
    const order = el('div', 'record-order');
    order.append(el('span', '', formatDate(record.observed_at)));
    row.append(order);
    list.append(row);
  }
}

async function runAction(action, success) {
  try {
    const result = await action();
    if (result) render(result);
    if (success) showToast(success);
  } catch (error) {
    showToast(error.message || String(error), true);
  }
}

async function launchFromUi() {
  const buttons = [$('quick-launch'), $('settings-launch')];
  buttons.forEach(button => { button.disabled = true; });
  try {
    const result = await api.launchGame();
    if (result?.alreadyRunning) showToast('游戏已经在运行，已切回游戏窗口。');
    else showToast(result?.viaSteam ? '已通过 Steam 启动游戏。' : '游戏启动请求已发送。');
  } catch (error) {
    showToast(error.message || String(error), true);
  } finally {
    buttons.forEach(button => { button.disabled = !currentState?.installation; });
  }
}

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

async function buildTop30Image() {
  if (!currentState?.result?.top30?.length) throw new Error('当前没有可导出的 Top 30 成绩');
  await document.fonts.ready;
  const canvas = document.createElement('canvas');
  canvas.width = 2400;
  canvas.height = 1800;
  const ctx = canvas.getContext('2d');
  const result = currentState.result;

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
  ctx.fillText('RATING ARCHIVE   //   CUSTOM V1', 2336, 70);
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
  const account = currentState.accounts?.find(item => item.key === currentState.selected_account);
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
    const color = index < 10 ? '#e876a8' : '#a2b1ff';
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
    ctx.fillText(`${entry.difficulty}   /   定数 ${entry.constant_display || entry.constant}   /   ×${entry.weight}`, x + 84, y + 62);

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

async function exportTop30() {
  const button = $('export-top30');
  button.disabled = true;
  try {
    const bytes = new Uint8Array(await buildTop30Image());
    const saved = await api.saveExport(bytes);
    if (saved) showToast(`Top30 分表已导出：${saved}`);
  } catch (error) {
    showToast(error.message || String(error), true);
  } finally {
    button.disabled = false;
  }
}

function bindEvents() {
  document.querySelectorAll('.nav-item').forEach(node => {
    node.addEventListener('click', () => switchPage(node.dataset.page));
  });
  $('win-min').addEventListener('click', api.minimize);
  $('win-max').addEventListener('click', api.maximize);
  $('win-close').addEventListener('click', api.close);
  $('catalog-search').addEventListener('input', renderCatalog);
  $('constants-search').addEventListener('input', renderConstants);
  $('sort-constants').addEventListener('click', () => {
    constantsSortMode = (constantsSortMode + 1) % 3;
    $('sort-constants').textContent = SORT_LABELS[constantsSortMode];
    renderConstants();
  });
  $('save-constants').addEventListener('click', saveConstants);
  $('set-default-constants').addEventListener('click', async () => {
    try {
      render(await api.savePreciseDefaults());
      showToast('已把当前精确定数设为默认精确定数。');
    } catch (error) {
      showToast(error.message || String(error), true);
    }
  });
  $('reset-default-constants').addEventListener('click', async () => {
    try {
      render(await api.resetPreciseDefaults());
      if (currentState?.settings?.developerMode) await loadConstants();
      showToast('已还原到默认精确定数。');
    } catch (error) {
      showToast(error.message || String(error), true);
    }
  });
  $('player-nickname').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.target.blur();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      nicknameEscape = true;
      const current = currentState?.nickname;
      event.target.value = current && current !== 'LOCAL PLAYER' ? current : '';
      event.target.blur();
    }
  });
  $('player-nickname').addEventListener('change', event => {
    if (nicknameEscape) { nicknameEscape = false; return; }
    saveNickname(event.target.value);
  });
  $('account-select').addEventListener('change', event =>
    runAction(() => api.selectAccount(event.target.value), '已切换存档账号。'));
  $('quick-launch').addEventListener('click', launchFromUi);
  $('settings-launch').addEventListener('click', launchFromUi);
  $('locate-game').addEventListener('click', () => runAction(api.chooseGame, '已连接新游戏目录并重建曲库。'));
  $('settings-locate').addEventListener('click', () => runAction(api.chooseGame, '已连接新游戏目录并重建曲库。'));
  $('auto-locate').addEventListener('click', () => runAction(api.autoLocate, '已从 Steam 自动定位游戏。'));
  $('first-auto').addEventListener('click', async () => {
    try {
      render(await api.autoLocate());
      showToast('已从 Steam 自动定位游戏。');
    } catch (error) {
      $('first-error').textContent = error.message;
    }
  });
  $('first-manual').addEventListener('click', async () => {
    try {
      const state = await api.chooseGame();
      if (state) render(state);
    } catch (error) {
      $('first-error').textContent = error.message;
    }
  });
  $('refresh-catalog').addEventListener('click', () => runAction(api.refreshCatalog, '当前游戏 Data 已重新读取。'));
  $('settings-refresh').addEventListener('click', () => runAction(api.refreshCatalog, '当前游戏 Data 已重新读取。'));
  $('export-top30').addEventListener('click', exportTop30);
  $('reveal-archive').addEventListener('click', () => api.revealArchive());
  $('restart-input').addEventListener('click', async () => {
    try { render(await api.restartInput()); showToast('全局输入服务已重启。'); }
    catch (error) { showToast(error.message, true); }
  });
  $('relaunch-admin').addEventListener('click', () => api.relaunchAdmin());
  for (const id of [
    'overlay-enabled', 'overlay-key', 'input-enabled', 'input-sounds',
    'swallow-caps', 'remap-keyboard', 'remap-mouse', 'block-hotkeys',
    'developer-mode'
  ]) {
    $(id).addEventListener('change', updateSettings);
  }
  api.onState(render);
  api.onBackendEvent(event => {
    if (event.type === 'archive') showToast(`已新增 ${event.value.added} 条游戏历史记录。`);
    if (event.type === 'rating') {
      showToast(`Rating 已更新：${event.value.rating}${event.value.change ? `（${event.value.change}）` : ''}`);
      if (activePage === 'records') loadRecords();
    }
  });
}

async function init() {
  bindEvents();
  try {
    const [state, version] = await Promise.all([api.getState(), api.appVersion()]);
    $('version-label').textContent = `BUILD ${version.version}`;
    render(state);
  } catch (error) {
    showToast(`本地服务连接失败：${error.message}`, true);
  }
}

init();
