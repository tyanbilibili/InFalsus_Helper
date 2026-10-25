'use strict';

const $ = id => document.getElementById(id);
const api = window.helperAPI;
const { formatScore, formatDate } = window.IFHUtils;
const phaseLabels = {
  Unknown: '等待阶段',
  Menu: '菜单',
  Playing: '游玩中',
  Results: '结算'
};
let currentState = null;
let catalog = [];
let catalogLoaded = false;
let catalogVersion = 0;
let lastCatalogRenderKey = '';
let lastConstantsRenderKey = '';
let lastTop30Key = '';
let lastCatalogMeta = null;
let records = [];
let toastTimer = null;
let lastRenderedRating = null;
let activePage = 'dashboard';
let preciseDrafts = {};
// 0 = game order, 1 = ULT constant desc, 2 = FBD constant desc
let constantsSortMode = 0;
let nicknameEscape = false;
const SORT_LABELS = ['按 ULT 排序', '按 FBD 排序', '恢复游戏顺序'];
// 算法元信息来自后端 state.algorithms（名字/标签/规则/公式说明只维护一份）。
let algorithmMeta = { order: ['arcaea'], list: [], zones: {} };

function algorithmInfo(id) {
  const list = algorithmMeta.list || [];
  return list.find(item => item.id === id) || list[0] || null;
}

// 供 export-image.js 复用同一份算法元信息
window.IFHUtils.algorithmTag = id => algorithmInfo(id)?.tag || 'CUSTOM';

function algorithmOrder() {
  return algorithmMeta.order && algorithmMeta.order.length ? algorithmMeta.order : ['arcaea'];
}

function zoneLabel(zone) {
  return (algorithmMeta.zones && algorithmMeta.zones[zone]) || 'SCORE CURVE';
}

let algorithmDraft = 'arcaea';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Coalesce rapid input events so typing doesn't rebuild 80 cards per keystroke. */
function debounce(fn, wait = 120) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
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

function renderRatingBars(selected, algorithm) {
  const bars = $('rating-bars');
  const weighted = algorithm !== 'phigros';
  bars.replaceChildren(...Array.from({ length: 30 }, (_, index) => {
    const bar = el('i');
    if (weighted && index < 10) bar.classList.add('double');
    if (index < selected) bar.classList.add('filled');
    return bar;
  }));
}

function renderTop30(result) {
  const list = $('top30-list');
  const rows = result?.top30 || [];
  const algorithm = result?.algorithm || 'arcaea';
  const isAverage = algorithm === 'phigros';
  // Rebuilding 30 rows (with cover <img> nodes) on every state push is wasteful;
  // only do it when the underlying entries actually changed.
  const key = `${algorithm}|` + rows.map(entry =>
    `${entry.chart_id}:${entry.score}:${entry.rating_display}:${entry.weight}`).join('|');
  if (key === lastTop30Key) return;
  lastTop30Key = key;
  list.replaceChildren();
  if (!rows.length) {
    list.append(el('div', 'empty-state', '暂无可计算记录。请启动游戏并完成一首歌曲。'));
    return;
  }
  for (const entry of rows) {
    const doubled = !isAverage && entry.weight === 2;
    const row = el('article', 'top-row' + (doubled ? ' double' : ''));
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
    rating.append(el('small', '', `单谱 / ${zoneLabel(entry.formula_zone)}`));
    row.append(rating);
    row.append(el('div', 'weight', isAverage ? 'AVG' : `×${entry.weight}`));
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

function renderAlgorithm() {
  const node = $('rating-algorithm');
  if (!node) return;
  node.dataset.value = algorithmDraft;
  const info = algorithmInfo(algorithmDraft);
  node.querySelector('.segmented-value').textContent = info?.name || 'Arcaea 算法';
  $('formula-tag').textContent = info?.tag || 'CUSTOM';
  const grid = $('formula-grid');
  grid.replaceChildren(...((info?.formula) || []).map(([label, value]) => {
    const cell = el('div');
    cell.append(el('span', '', label));
    cell.append(el('b', '', value));
    return cell;
  }));
}

function syncSettings(state) {
  const settings = state.settings || {};
  const input = settings.input || {};
  if (state.algorithms) algorithmMeta = state.algorithms;
  algorithmDraft = algorithmOrder().includes(settings.ratingAlgorithm)
    ? settings.ratingAlgorithm
    : algorithmOrder()[0];
  renderAlgorithm();
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
  $('rating-rule').textContent = algorithmInfo(result?.algorithm)?.rule || 'SCORE CURVE';
  renderRatingBars(result?.selected_count || 0, result?.algorithm);
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
  $('catalog-source').textContent = state.catalog?.stale
    ? 'LOCAL DATA / 版本较旧'
    : state.catalog?.source === 'game' ? 'LOCAL DATA' : 'BUNDLED';
  // A rebuilt catalog invalidates the cached card lists.
  const catalogMeta = state.catalog
    ? `${state.catalog.song_count}|${state.catalog.build_id}|${state.catalog.updated_at}`
    : '';
  if (catalogMeta !== lastCatalogMeta) {
    lastCatalogMeta = catalogMeta;
    catalogLoaded = false;
    lastCatalogRenderKey = '';
    lastConstantsRenderKey = '';
  }
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
    ratingAlgorithm: algorithmDraft,
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
    // Rating values on the history page depend on the algorithm.
    if (activePage === 'records') await loadRecords();
    showToast('设置已保存并应用到全局输入服务。');
  } catch (error) {
    showToast(error.message, true);
  }
}

async function fetchCatalog(force = false) {
  if (catalogLoaded && !force) return catalog;
  catalog = await api.getCatalog();
  catalogLoaded = true;
  catalogVersion += 1;
  return catalog;
}

async function loadCatalog() {
  try {
    await fetchCatalog();
    renderCatalog();
  } catch (error) {
    $('catalog-grid').replaceChildren(el('div', 'empty-state', error.message));
  }
}

function renderCatalog() {
  const query = $('catalog-search').value.trim().toLowerCase();
  const key = `${catalogVersion}|${query}|${catalog.length}`;
  if (key === lastCatalogRenderKey) return;
  lastCatalogRenderKey = key;
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
    await fetchCatalog();
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
  const key = `${catalogVersion}|${constantsSortMode}|${query}|${catalog.length}`;
  if (key === lastConstantsRenderKey) return;
  lastConstantsRenderKey = key;
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
    catalogLoaded = false;
    lastConstantsRenderKey = '';
    lastCatalogRenderKey = '';
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
  const query = ($('records-search')?.value || '').trim().toLowerCase();
  const visible = query
    ? records.filter(record => [record.title, record.difficulty, record.chart_id]
      .filter(Boolean).some(value => String(value).toLowerCase().includes(query)))
    : records;
  list.replaceChildren();
  if (!records.length) {
    list.append(el('div', 'empty-state', '历史记录尚未读取。'));
    renderRecordSummary(0);
    return;
  }
  if (!visible.length) {
    list.append(el('div', 'empty-state', '没有找到匹配的记录。'));
    renderRecordSummary(0);
    return;
  }
  renderRecordSummary(visible.length);
  for (const record of visible) {
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

function renderRecordSummary(shown) {
  const node = $('records-summary');
  if (!node) return;
  const rows = [
    ['已归档游玩记录', records.length],
    ['不同谱面最佳成绩', currentState?.best_score_count ?? 0],
    ['当前显示', shown]
  ];
  node.replaceChildren(...rows.map(([label, value]) => {
    const cell = el('span');
    cell.append(document.createTextNode(`${label} `));
    cell.append(el('b', '', String(value)));
    return cell;
  }));
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

async function exportTop30() {
  const button = $('export-top30');
  button.disabled = true;
  try {
    const bytes = new Uint8Array(await window.IFHExport.buildTop30Image(currentState));
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
  $('records-search').addEventListener('input', debounce(renderRecords));
  $('catalog-search').addEventListener('input', debounce(renderCatalog));
  $('constants-search').addEventListener('input', debounce(renderConstants));
  $('sort-constants').addEventListener('click', () => {
    constantsSortMode = (constantsSortMode + 1) % 3;
    $('sort-constants').textContent = SORT_LABELS[constantsSortMode];
    renderConstants();
  });
  $('save-constants').addEventListener('click', saveConstants);
  $('rating-algorithm').addEventListener('click', event => {
    const arrow = event.target.closest('.segmented-arrow');
    if (!arrow) return;
    const dir = Number(arrow.dataset.dir) >= 0 ? 1 : -1;
    const order = algorithmOrder();
    const index = order.indexOf(algorithmDraft);
    algorithmDraft = order[(index + dir + order.length) % order.length];
    renderAlgorithm();
    updateSettings();
  });
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
      if (currentState?.settings?.developerMode) {
        catalogLoaded = false;
        lastConstantsRenderKey = '';
        await loadConstants();
      }
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
  $('relaunch-admin').addEventListener('click', async () => {
    try {
      await api.relaunchAdmin();
    } catch (error) {
      showToast(error.message || String(error), true);
    }
  });
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

// 只读入口：自动化测试与 export-image.js 需要当前状态。
window.__IFH = { get state() { return currentState; } };

async function init() {
  bindEvents();
  try {
    const [state, version] = await Promise.all([api.getState(), api.appVersion()]);
    // 顶栏与侧栏都跟着 VERSION.txt 走。
    $('version-label').textContent = `BUILD ${version.version}`;
    $('app-version').textContent = `v${version.version}`;
    render(state);
  } catch (error) {
    showToast(`本地服务连接失败：${error.message}`, true);
  }
}

init();
