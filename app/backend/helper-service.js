'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

const { SafeStore } = require('./store.cjs');
const { PreciseConstants } = require('./precise-constants.js');
const { ArchiveStore } = require('./archive-store.js');
const { inspectInstall, findInstall } = require('./installation.cjs');
const { checkUpdate } = require('./catalog-update.cjs');
const { loadActive } = require('./catalog-data.cjs');
const { discover, readStable, parseSave, accountKey } = require('./save-reader.cjs');
const rating = require('./rating.js');

const execFileAsync = promisify(execFile);
const DIFFICULTIES = Object.freeze({ 1: 'MIN', 2: 'EVO', 4: 'ULT', 8: 'FBD' });
const DEFAULT_SETTINGS = Object.freeze({
  schema: 'infalsus-helper-settings/v2',
  selectedAccount: null,
  nicknames: {},
  overlayEnabled: true,
  overlayKey: 'F5',
  developerMode: false,
  ratingAlgorithm: 'arcaea',
  input: {
    enabled: false,
    playSounds: false,
    swallowCapsLock: false,
    remapKeyboard: false,
    remapMouse: false,
    blockScreenshotHotkeys: false
  },
  ratingDigits: 3
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clone = value => JSON.parse(JSON.stringify(value));
const bool = value => value === true;
/** Executables must be spawned from app.asar.unpacked, never from inside app.asar. */
const asarUnpacked = target =>
  target.includes('app.asar') ? target.replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked') : target;

function normalizeSettings(value) {
  const output = clone(DEFAULT_SETTINGS);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return output;
  if (!['infalsus-helper-settings/v1', DEFAULT_SETTINGS.schema].includes(value.schema)) return output;
  if (/^[a-f0-9]{64}$/.test(value.selectedAccount || '')) {
    output.selectedAccount = value.selectedAccount;
  }
  output.overlayEnabled = value.overlayEnabled !== false;
  output.developerMode = value.developerMode === true;
  if (typeof value.overlayKey === 'string' && /^F(?:[1-9]|1[0-2])$/.test(value.overlayKey)) {
    output.overlayKey = value.overlayKey;
  }
  output.ratingDigits = value.ratingDigits === 4 ? 4 : 3;
  output.ratingAlgorithm = rating.ALGORITHMS.includes(value.ratingAlgorithm)
    ? value.ratingAlgorithm
    : rating.DEFAULT_ALGORITHM;
  // Per-account display nicknames: the 64-char archive hash stays internal.
  if (value.nicknames && typeof value.nicknames === 'object' && !Array.isArray(value.nicknames)) {
    for (const [key, nickname] of Object.entries(value.nicknames)) {
      if (!/^[a-f0-9]{64}$/.test(key)) continue;
      if (typeof nickname !== 'string') continue;
      const trimmed = normalizeNickname(nickname);
      if (trimmed) output.nicknames[key] = trimmed;
    }
  }
  // v1 shipped with listener/audio enabled. Version 2 intentionally starts all
  // global input features off and migrates older settings to that safe default.
  if (value.schema === DEFAULT_SETTINGS.schema &&
      value.input && typeof value.input === 'object') {
    for (const key of Object.keys(output.input)) {
      if (typeof value.input[key] === 'boolean') output.input[key] = value.input[key];
    }
  }
  return output;
}

function normalizeNickname(value) {
  return String(value ?? '')
    .replace(/[\r\n\t]/g, ' ')
    .trim()
    .slice(0, 24);
}


async function steamRoots() {
  const roots = new Set();
  for (const env of ['ProgramFiles(x86)', 'ProgramFiles']) {
    if (process.env[env]) roots.add(path.join(process.env[env], 'Steam'));
  }
  roots.add('C:\\Steam');
  for (const hive of ['HKCU\\Software\\Valve\\Steam', 'HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam']) {
    try {
      const { stdout } = await execFileAsync('reg.exe', ['query', hive, '/v', 'SteamPath'], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 2500
      });
      const match = /SteamPath\s+REG_SZ\s+(.+)\s*$/im.exec(stdout);
      if (match) roots.add(match[1].trim().replace(/\//g, '\\'));
    } catch {
      // A missing registry value is not an error; explicit folder selection remains available.
    }
  }
  const existing = [];
  for (const root of roots) {
    try {
      if ((await fs.stat(root)).isDirectory()) existing.push(path.resolve(root));
    } catch {}
  }
  return [...new Set(existing)];
}

function truncateRating(value, digits = 3) {
  const match = /^(\d+)\.(\d{1,12})$/.exec(String(value));
  if (!match) return '--';
  return match[1] + '.' + (match[2] + '000').slice(0, digits);
}

function exactDelta(before, after, digits = 3) {
  const scale = 10n ** BigInt(digits);
  const beforeN = BigInt(before.rating_exact?.numerator || 0);
  const beforeD = BigInt(before.rating_exact?.denominator || 1);
  const afterN = BigInt(after.rating_exact?.numerator || 0);
  const afterD = BigInt(after.rating_exact?.denominator || 1);
  const beforeUnits = beforeN * scale / beforeD;
  const afterUnits = afterN * scale / afterD;
  const delta = afterUnits - beforeUnits;
  const negative = delta < 0n;
  const raw = (negative ? -delta : delta).toString().padStart(digits + 1, '0');
  return (negative ? '-' : '+') + raw.slice(0, -digits) + '.' + raw.slice(-digits);
}

/** Parse a truncated rating text ("12.223") into integer thousandths. */
function ratingUnits(text, digits = 3) {
  const match = /^(-?)(\d+)\.(\d+)$/.exec(String(text ?? ''));
  if (!match) return null;
  const fraction = (match[3] + '0'.repeat(digits)).slice(0, digits);
  const units = BigInt(match[2] + fraction);
  return match[1] ? -units : units;
}

/**
 * Delta of two already-truncated rating texts, e.g. "12.222" -> "12.223" = "+0.001".
 * This is what the overlay shows, so the visible change always equals new - old
 * as printed on screen.
 */
function truncatedDelta(beforeText, afterText, digits = 3) {
  const before = ratingUnits(beforeText, digits);
  const after = ratingUnits(afterText, digits);
  if (before === null || after === null) return null;
  const delta = after - before;
  const negative = delta < 0n;
  const raw = (negative ? -delta : delta).toString().padStart(digits + 1, '0');
  return (negative ? '-' : '+') + raw.slice(0, -digits) + '.' + raw.slice(-digits);
}

/** 比较两个精确有理数：-1 小于、0 相等、1 大于。 */
function compareExact(a, b) {
  if (!a || !b || a.numerator === undefined || b.numerator === undefined) return 0;
  const left = BigInt(a.numerator) * BigInt(b.denominator);
  const right = BigInt(b.numerator) * BigInt(a.denominator);
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * 界面显示的本次变化。
 *
 * 正常情况下就是「新三位 − 旧三位」。但当真实变化小于显示精度（例如 0.0004）
 * 时，三位相减会得到 +0.000，看起来像没变。这时用精确值判断是否真的变了，
 * 改成 "+<0.001"，让用户能区分「确实没变」和「变了但很小」。
 */
function ratingDeltaText(beforeResult, afterResult, digits = 3) {
  const text = truncatedDelta(beforeResult?.rating_text, afterResult?.rating_text, digits);
  if (text === null) return null;
  const zero = '0.' + '0'.repeat(digits);
  if (text !== '+' + zero && text !== '-' + zero) return text;
  const order = compareExact(afterResult?.rating_exact, beforeResult?.rating_exact);
  if (order === 0) return text;
  const smallest = '<0.' + '0'.repeat(digits - 1) + '1';
  return order > 0 ? '+' + smallest : '-' + smallest;
}


class HelperService {
  constructor({ appRoot, appHome, dataRoot, emit }) {
    this.appRoot = path.resolve(appRoot);
    this.appHome = path.resolve(appHome || appRoot);
    this.dataRoot = path.resolve(dataRoot || path.join(this.appRoot, 'user_data'));
    this.emit = typeof emit === 'function' ? emit : () => {};
    this.storeRoot = this.dataRoot;
    this.catalogRoot = path.join(this.dataRoot, 'catalog_data');
    this.store = new SafeStore(this.storeRoot);
    // Changes every launch: used as the cover-art cache key in Chromium.
    this.runToken = Date.now().toString(36);
    this.settings = clone(DEFAULT_SETTINGS);
    // 精确定数的当前表与默认表由独立模块维护，这里只持有引用。
    this.constants = new PreciseConstants(this);
    this.installation = null;
    this.catalogData = null;
    this.accounts = [];
    this.selectedAccount = null;
    this.archive = null;
    this.current = null;
    this.previousRating = null;
    this.ratingChange = null;
    this.lastRatingChange = null;
    this.lastPlay = null;
    this.lastScanAt = null;
    this.lastError = null;
    this.lastLoggedError = '';
    this.coverStatus = { updated: 0, missing: [], error: null, updated_at: null };
    this.phase = { phase: 'Unknown', pid: 0, reason: 'not_started', notice: '等待游戏连接' };
    this.inputStatus = { running: false, enabled: true, message: '输入服务尚未启动' };
    this.scanning = false;
    this.timer = null;
    this.archiveStore = new ArchiveStore(this);
  }

  async initialize() {
    await this.store.init();
    const savedSettings = await this.store.read('settings.json');
    this.settings = normalizeSettings(savedSettings);
    if (savedSettings && savedSettings.schema !== this.settings.schema) {
      await this.store.write('settings.json', this.settings, { backup: true });
    }
    await this.constants.loadDefaults();
    await this.constants.loadCurrent();
    this.invalidateEffectiveCatalog();
    await this.loadCatalog();
    await this.restoreInstallation();
    await this.scanSaves(true);
    this.timer = setInterval(() => {
      this.scanSaves(false).catch(error => this.recordError(error, 'SCAN_FAILED'));
    }, 1000);
    return this.getState();
  }

  /** Cover URL with a per-launch version token so Chromium can cache the images. */
  coverUrl(id) {
    return `helper-asset://cover/${id}?v=${this.runToken}`;
  }

  async loadCatalog() {
    this.catalogData = await loadActive(this.catalogRoot);
    this.invalidateEffectiveCatalog();
  }

  /** Drop the cached effective catalog; call it whenever constants or game data change. */
  invalidateEffectiveCatalog() {
    this._effectiveCatalog = null;
    this._effectiveCharts = null;
    this._baseCharts = null;
    this._mappingBySong = null;
  }

  async restoreInstallation() {
    let saved = null;
    try {
      saved = await this.store.read('installation.json');
    } catch {}
    if (saved?.game_root) {
      try {
        this.installation = await inspectInstall(saved.game_root);
        this.installation.path = this.installation.gameRoot;
        await this.ensureCatalogForInstall(false);
        return;
      } catch {}
    }
    try {
      const roots = await steamRoots();
      const found = await findInstall({ steamRoots: roots, saved });
      this.installation = { ...found, path: found.gameRoot };
      await this.ensureCatalogForInstall(false);
      await this.store.write('installation.json', {
        schema: 'infalsus-installation/v1',
        game_root: found.gameRoot,
        build_id: found.build_id
      }, { backup: true });
    } catch (error) {
      this.installation = null;
      if (!['GAME_NOT_FOUND', 'STEAM_NOT_FOUND', 'AMBIGUOUS_GAME_INSTALL'].includes(error.message)) {
        this.recordError(error, 'INSTALL_FAILED');
      }
    }
  }

  async ensureCatalogForInstall(force = false) {
    if (!this.installation) throw new Error('GAME_NOT_FOUND');
    const active = await loadActive(this.catalogRoot);
    if (force || !active.source || active.source.build_id !== this.installation.build_id) {
      await checkUpdate({
        install: this.installation,
        storeRoot: this.catalogRoot
      });
      await this.loadCatalog();
    }
    await this.refreshCoverCache();
  }

  async refreshCoverCache() {
    const bundled = path.join(this.appRoot, 'assets', 'covers');
    const writable = path.join(this.dataRoot, 'covers');
    // Two directory listings beat 160 individual existence probes.
    const known = new Set();
    for (const dir of [writable, bundled]) {
      try {
        for (const name of await fs.readdir(dir)) {
          if (name.endsWith('.webp')) known.add(name.slice(0, -5));
        }
      } catch {}
    }
    const missing = (this.catalogData?.catalog?.songs || [])
      .map(song => song.id)
      .filter(id => !known.has(id));
    if (!missing.length) {
      this.coverStatus = { updated: 0, missing: [], error: null, updated_at: new Date().toISOString() };
      return this.coverStatus;
    }

    const scriptExe = asarUnpacked(path.join(this.appRoot, 'scripts', 'cover-extractor.exe'));
    const scriptPy = asarUnpacked(path.join(this.appRoot, 'scripts', 'cover_extractor.py'));
    let command = process.env.PYTHON || 'python';
    let args = [scriptPy];
    try {
      await fs.access(scriptExe);
    } catch {
      command = scriptExe;
      args = [];
    }
    args.push(
      '--game', this.installation.gameRoot,
      '--catalog', path.join(this.catalogRoot, 'active.json'),
      '--output', writable,
      '--existing', bundled
    );
    const result = await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: path.dirname(scriptExe),
        windowsHide: true,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        reject(new Error('COVER_SCAN_TIMEOUT'));
      }, 180000);
      child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
      child.on('error', error => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('exit', code => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(stderr.trim() || 'COVER_SCAN_FAILED'));
        try {
          const lines = stdout.trim().split(/\r?\n/);
          resolve(JSON.parse(lines[lines.length - 1]));
        } catch {
          reject(new Error('COVER_SCAN_INVALID_RESULT'));
        }
      });
    }).catch(error => ({ updated: 0, missing, error: error.message }));
    this.coverStatus = {
      updated: result.updated || 0,
      missing: result.missing || [],
      error: result.error || null,
      updated_at: new Date().toISOString()
    };
    return this.coverStatus;
  }

  async locateGame(exeOrDirectory) {
    if (typeof exeOrDirectory !== 'string' || !path.isAbsolute(exeOrDirectory)) {
      throw new Error('INVALID_GAME_PATH');
    }
    let gameRoot = path.resolve(exeOrDirectory);
    try {
      if ((await fs.stat(gameRoot)).isFile()) gameRoot = path.dirname(gameRoot);
    } catch {
      throw new Error('GAME_NOT_FOUND');
    }
    const found = await inspectInstall(gameRoot);
    this.installation = { ...found, path: found.gameRoot };
    await this.ensureCatalogForInstall(true);
    await this.store.write('installation.json', {
      schema: 'infalsus-installation/v1',
      game_root: found.gameRoot,
      build_id: found.build_id
    }, { backup: true });
    this.lastError = null;
    return this.getState();
  }

  async autoLocateGame() {
    const roots = await steamRoots();
    const found = await findInstall({ steamRoots: roots });
    this.installation = { ...found, path: found.gameRoot };
    await this.ensureCatalogForInstall(false);
    await this.store.write('installation.json', {
      schema: 'infalsus-installation/v1',
      game_root: found.gameRoot,
      build_id: found.build_id
    }, { backup: true });
    this.lastError = null;
    return this.getState();
  }

  async refreshCatalog() {
    await this.ensureCatalogForInstall(true);
    return this.getState();
  }

  async setSettings(patch) {
    const previousDeveloperMode = this.settings.developerMode;
    const previousAlgorithm = this.settings.ratingAlgorithm;
    const candidate = {
      ...this.settings,
      ...(patch || {}),
      input: {
        ...this.settings.input,
        ...((patch && patch.input) || {})
      }
    };
    this.settings = normalizeSettings(candidate);
    if (previousDeveloperMode !== this.settings.developerMode) {
      this.lastRatingChange = null;
      this.invalidateEffectiveCatalog();
    }
    // Switching algorithms changes every single-chart value, so the previous
    // "rating change" delta no longer means anything.
    if (previousAlgorithm !== this.settings.ratingAlgorithm) this.lastRatingChange = null;
    await this.store.write('settings.json', this.settings, { backup: true });
    this.recalculateCurrent();
    this.emit('settings', this.settings);
    return this.getState();
  }

  effectiveConstant(chart) {
    return this.constants.effective(chart, this.settings.developerMode);
  }

  effectiveCatalog() {
    if (this._effectiveCatalog) return this._effectiveCatalog;
    this._effectiveCatalog = {
      ...this.catalogData.catalog,
      songs: this.catalogData.catalog.songs.map(song => ({
        ...song,
        charts: Object.fromEntries(Object.entries(song.charts).map(([difficulty, chart]) => [
          difficulty,
          { ...chart, rating: this.effectiveConstant(chart) }
        ]))
      }))
    };
    return this._effectiveCatalog;
  }

  baseChartMap() {
    if (this._baseCharts) return this._baseCharts;
    const map = new Map();
    for (const song of this.catalogData?.catalog?.songs || []) {
      for (const chart of Object.values(song.charts || {})) {
        map.set(chart.id, { ...chart, song });
      }
    }
    this._baseCharts = map;
    return map;
  }

  recalculateCurrent() {
    if (!this.archive || !this.current) return;
    const calculated = this.calculateArchive(this.archive);
    calculated.result.top30 = calculated.result.top30.map(entry => ({
      ...entry,
      cover_url: this.coverUrl(entry.chart_id)
    }));
    calculated.result.rating_change = this.lastRatingChange;
    calculated.result.last_play = this.lastPlay;
    if (this.lastPlay) {
      const one = rating.evaluatePlay({
        chart_id: this.lastPlay.chart_id,
        score: this.lastPlay.score,
        counts: this.lastPlay.counts
      }, this.effectiveCatalog(), null, this.settings.ratingAlgorithm);
      this.lastPlay.single_rating_display = one.rating_display;
      this.lastPlay.single_rating_text = truncateRating(one.rating_display, this.settings.ratingDigits);
      calculated.result.last_play = this.lastPlay;
    }
    this.current = calculated.result;
  }

  // --- 精确定数：对外 API，具体实现在 precise-constants.js -------------------

  async savePreciseConstants(values) {
    await this.constants.save(values, this.baseChartMap());
    this.lastRatingChange = null;
    this.invalidateEffectiveCatalog();
    this.recalculateCurrent();
    return this.getState();
  }

  async savePreciseDefaults() {
    await this.constants.saveAsDefaults();
    this.lastRatingChange = null;
    this.recalculateCurrent();
    return this.getState();
  }

  async resetPreciseConstants() {
    await this.constants.resetToDefaults();
    this.lastRatingChange = null;
    this.invalidateEffectiveCatalog();
    this.recalculateCurrent();
    return this.getState();
  }

  /**
   * 记录错误：界面只显示简短原因，完整堆栈追加到 runtime/errors.log，
   * 方便排查而不用把内部路径暴露在界面上。
   */
  recordError(error, fallback = 'UNKNOWN') {
    const message = error?.message || String(error) || fallback;
    this.lastError = error?.code || message;
    if (!message || message === this.lastLoggedError) return;
    this.lastLoggedError = message;
    const dir = path.join(this.dataRoot, 'runtime');
    const line = `[${new Date().toISOString()}] ${message}\n${error?.stack || ''}\n\n`;
    fs.mkdir(dir, { recursive: true })
      .then(() => fs.appendFile(path.join(dir, 'errors.log'), line, 'utf8'))
      .catch(() => {});
  }

  setPhase(update) {
    this.phase = update;
    this.emit('state', update);
  }

  setInputStatus(update) {
    this.inputStatus = { ...this.inputStatus, ...update };
    this.emit('state', update);
  }

  chartMap() {
    if (this._effectiveCharts) return this._effectiveCharts;
    const map = new Map();
    const base = this.baseChartMap();
    for (const song of this.effectiveCatalog().songs || []) {
      for (const chart of Object.values(song.charts || {})) {
        map.set(chart.id, {
          ...chart,
          base_rating: base.get(chart.id)?.rating,
          song
        });
      }
    }
    this._effectiveCharts = map;
    return map;
  }

  mappingBySong() {
    if (this._mappingBySong) return this._mappingBySong;
    const map = new Map();
    for (const item of this.catalogData?.mapping?.songs || []) {
      map.set(item.game_song_id, item);
    }
    this._mappingBySong = map;
    return map;
  }

  projectRecord(record, bySong, charts) {
    const song = bySong.get(record.song_id);
    const difficulty = DIFFICULTIES[record.difficulty_flag];
    const chart = song?.charts?.[String(record.difficulty_flag)];
    if (!song || !chart) return null;
    const meta = charts.get(chart.chart_id);
    if (!meta) return null;
    return {
      record_id: record.id,
      chart_id: chart.chart_id,
      title: meta.title,
      difficulty: meta.difficulty,
      constant: meta.rating,
      constant_display: Number(meta.rating).toFixed(1),
      score: String(record.score),
      counts: record.counts,
      clear: record.result_clear,
      lamp: record.lamp,
      slot: record.slot,
      history_order: record.history_order,
      observed_at: record.first_observed_at || null
    };
  }

  /** Project a merged per-chart best entry (may come from the best-score table). */
  projectBestEntry(entry, bySong, charts) {
    const song = bySong.get(entry.song_id);
    const chart = song?.charts?.[String(entry.difficulty_flag)];
    if (!song || !chart) return null;
    const meta = charts.get(chart.chart_id);
    if (!meta) return null;
    return {
      record_id: `best:${entry.song_id}:${entry.difficulty_flag}`,
      chart_id: chart.chart_id,
      title: meta.title,
      difficulty: meta.difficulty,
      constant: meta.rating,
      constant_display: Number(meta.rating).toFixed(1),
      score: String(entry.score),
      counts: entry.counts,
      counts_unreliable: entry.counts_unreliable === true,
      source: entry.source || 'history',
      clear: null,
      lamp: null,
      slot: null,
      history_order: null,
      observed_at: entry.updated_at || null
    };
  }

  calculateArchive(archive) {
    const bySong = this.mappingBySong();
    const charts = this.chartMap();
    const plays = [];
    const evaluatedRecords = [];
    // Prefer the merged per-chart best map: it also covers plays that the game's
    // 1024-slot history ring has already overwritten.
    const bestScores = archive.best_scores;
    const hasBest = bestScores && typeof bestScores === 'object' &&
      Object.keys(bestScores).length > 0;
    const projected = hasBest
      ? Object.values(bestScores).map(entry => this.projectBestEntry(entry, bySong, charts))
      : archive.records.map(record => this.projectRecord(record, bySong, charts));
    for (const item of projected) {
      if (!item) continue;
      plays.push({
        chart_id: item.chart_id,
        score: item.score,
        counts: item.counts,
        counts_unreliable: item.counts_unreliable === true
      });
      evaluatedRecords.push(item);
    }
    const result = rating.calculate({
      schema: rating.INPUT_SCHEMA,
      plays
    }, this.effectiveCatalog(), {
      algorithm: this.settings.ratingAlgorithm
    });
    result.rating_text = truncateRating(result.rating_display, this.settings.ratingDigits);
    return { result, evaluatedRecords };
  }

  /**
   * 扫描存档。拆成三步：选定账号 → 同步档案 → 重算并广播。
   * 任何一步失败都只记录错误，不抛出（定时器每秒调用一次）。
   */
  async scanSaves(initial) {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const selected = await this.resolveAccount();
      if (!selected) {
        this.current = null;
        this.lastScanAt = new Date().toISOString();
        return;
      }
      const scanned = await this.archiveStore.sync(selected, !initial);
      this.archive = scanned.archive;
      // 存档没变化：沿用上次结果，跳过重算与写盘。
      if (scanned.unchanged && !initial && this.current) {
        this.lastScanAt = new Date().toISOString();
        return;
      }
      await this.applyScanResult(selected, scanned);
      this.lastScanAt = new Date().toISOString();
      this.lastError = null;
    } catch (error) {
      this.recordError(error, 'SAVE_READ_FAILED');
    } finally {
      this.scanning = false;
    }
  }

  /** 发现账号并确定当前使用的那个；返回 null 表示无可用账号。 */
  async resolveAccount() {
    this.accounts = await discover();
    if (!this.accounts.length) return null;
    const selected = this.accounts.find(account => account.key === this.settings.selectedAccount)
      || (this.accounts.length === 1 ? this.accounts[0] : null);
    if (!selected) {
      this.selectedAccount = null;
      return null;
    }
    if (selected.key !== this.selectedAccount) {
      // 换了账号：上一次的结果作废，也不能让"存档未变"的快路径复用它。
      this.selectedAccount = selected.key;
      this.lastRatingChange = null;
      this.lastPlay = null;
      this.current = null;
      this.archiveStore.sourceStamp = null;
      if (this.settings.selectedAccount !== selected.key) {
        this.settings = { ...this.settings, selectedAccount: selected.key };
        await this.store.write('settings.json', this.settings, { backup: true });
      }
    }
    return selected;
  }

  /** 重算评分、更新「本次变化」、落盘并广播。 */
  async applyScanResult(selected, scanned) {
    // 「变化前」必须用同步前的最佳成绩快照。若沿用 scanned.archive.best_scores，
    // 新旧两份就完全一样，差值恒为 +0.000。
    const before = this.calculateArchive({
      ...scanned.archive,
      best_scores: scanned.previousBest || {},
      records: scanned.archive.records.filter(record =>
        !scanned.added.some(item => item.id === record.id))
    });
    const after = this.calculateArchive(scanned.archive);
    after.result.top30 = after.result.top30.map(entry => ({
      ...entry,
      cover_url: this.coverUrl(entry.chart_id)
    }));
    const hadPrior = !!scanned.archive.last_rating &&
      scanned.added.length > 0 &&
      scanned.archive.records.length > scanned.added.length;
    this.previousRating = hadPrior ? before.result : null;
    this.current = after.result;
    // 变化量 = 新总 Rating(3位) − 旧总 Rating(3位)，与界面显示完全一致。
    this.current.rating_change = hadPrior
      ? ratingDeltaText(before.result, after.result, this.settings.ratingDigits)
      : this.lastRatingChange;
    if (hadPrior) this.lastRatingChange = this.current.rating_change;
    this.current.previous_rating = hadPrior ? before.result.rating_text : null;

    const lastRaw = scanned.added[scanned.added.length - 1] || null;
    if (lastRaw) {
      this.lastPlay = this.projectRecord(lastRaw, this.mappingBySong(), this.chartMap());
    }
    if (this.lastPlay) {
      const one = rating.evaluatePlay({
        chart_id: this.lastPlay.chart_id,
        score: this.lastPlay.score,
        counts: this.lastPlay.counts
      }, this.effectiveCatalog(), null, this.settings.ratingAlgorithm);
      this.lastPlay.single_rating_display = one.rating_display;
      this.lastPlay.single_rating_text = truncateRating(one.rating_display, this.settings.ratingDigits);
    }
    this.current.last_play = this.lastPlay;
    this.archive.last_rating = {
      value: after.result.rating,
      display: after.result.rating_display,
      updated_at: new Date().toISOString()
    };
    await this.store.write(`accounts/${selected.key}/archive.json`, this.archive, { backup: true });
    if (scanned.added.length) this.emit('rating', {
      rating: this.current.rating_text,
      change: this.current.rating_change,
      lastPlay: this.lastPlay
    });
  }

  async selectAccount(key) {
    if (!this.accounts.some(account => account.key === key)) throw new Error('UNKNOWN_ACCOUNT');
    await this.setSettings({ selectedAccount: key });
    this.selectedAccount = null;
    await this.scanSaves(false);
    return this.getState();
  }

  currentAccount() {
    return this.accounts.find(account => account.key === this.selectedAccount) || null;
  }

  accountView(account) {
    const nickname = this.settings.nicknames[account.key] || '';
    return {
      key: account.key,
      short: account.key.slice(0, 8),
      nickname,
      // Only place the raw archive id stays visible is the "存档账号" field.
      label: nickname || account.key.slice(0, 8)
    };
  }

  displayName() {
    const account = this.currentAccount();
    if (!account) return 'LOCAL PLAYER';
    return this.settings.nicknames[account.key] || account.key.slice(0, 8);
  }

  async setNickname(value) {
    if (!this.selectedAccount) throw new Error('NO_ACCOUNT_SELECTED');
    const nickname = normalizeNickname(value);
    const nicknames = { ...this.settings.nicknames };
    if (nickname) nicknames[this.selectedAccount] = nickname;
    else delete nicknames[this.selectedAccount];
    this.settings = { ...this.settings, nicknames };
    await this.store.write('settings.json', this.settings, { backup: true });
    this.emit('settings', this.settings);
    return this.getState();
  }

  catalogView() {
    return (this.catalogData?.catalog?.songs || []).map(song => ({
      id: song.id,
      game_song_id: song.game_song_id,
      title: song.title,
      title_en: song.title_en,
      artist: song.artist,
      pack: song.pack,
      cover_url: this.coverUrl(song.id),
      charts: Object.values(song.charts || {}).map(chart => ({
        chart_id: chart.id,
        difficulty: chart.difficulty,
        constant: Number(this.effectiveConstant(chart)),
        constant_display: this.effectiveConstant(chart),
        base_constant: chart.rating,
        base_constant_display: Number(chart.rating).toFixed(1),
        modified: Object.hasOwn(this.constants.values, chart.id),
        designer: chart.designer,
        cover_url: this.coverUrl(chart.id)
      }))
    }));
  }

  recordsView(limit = 300) {
    if (!this.archive || !this.current) return [];
    const charts = this.chartMap();
    const bySong = this.mappingBySong();
    const catalog = this.effectiveCatalog();
    // Build the chart lookup once; rebuilding it per record made this O(n × charts).
    const ratingMap = rating.buildChartMap(catalog);
    return this.archive.records
      .map(record => {
        const projected = this.projectRecord(record, bySong, charts);
        if (!projected) return null;
        const one = rating.evaluatePlay({
          chart_id: projected.chart_id,
          score: projected.score,
          counts: projected.counts
        }, catalog, ratingMap, this.settings.ratingAlgorithm);
        return {
          ...projected,
          single_rating: one.rating,
          single_rating_display: one.rating_display,
          single_rating_text: truncateRating(one.rating_display, this.settings.ratingDigits)
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        const aOrder = Number.isInteger(a.history_order) ? a.history_order : -1;
        const bOrder = Number.isInteger(b.history_order) ? b.history_order : -1;
        if (aOrder !== bOrder) return bOrder - aOrder;
        return String(b.observed_at).localeCompare(String(a.observed_at));
      })
      .slice(0, limit);
  }

  getState() {
    return {
      schema: 'infalsus-helper-state/v1',
      installed: !!this.installation,
      installation: this.installation ? {
        path: this.installation.gameRoot,
        build_id: this.installation.build_id,
        exe: path.join(this.installation.gameRoot, 'infalsus.exe')
      } : null,
      catalog: this.catalogData ? {
        song_count: this.catalogData.catalog.songs.length,
        chart_count: this.catalogData.catalog.songs.length * 4,
        source: this.catalogData.source ? 'game' : 'bundled',
        build_id: this.catalogData.source?.build_id || null,
        updated_at: this.catalogData.source?.checked_at || null,
        cover_update: this.coverStatus,
        // 曲库来自旧的游戏 build：定数可能已过期，界面要提示重新读取。
        stale: !!(this.installation?.build_id && this.catalogData.source?.build_id &&
          this.catalogData.source.build_id !== this.installation.build_id)
      } : null,
      accounts: this.accounts.map(account => this.accountView(account)),
      selected_account: this.selectedAccount,
      nickname: this.displayName(),
      selected_short_id: this.currentAccount()?.key.slice(0, 8) || null,
      observed_count: this.archive?.records?.length || 0,
      best_score_count: Object.keys(this.archive?.best_scores || {}).length,
      coverage: this.archive?.coverage || null,
      result: this.current,
      rating_change: this.current?.rating_change || null,
      last_play: this.lastPlay,
      phase: this.phase,
      input: {
        settings: this.settings.input,
        status: this.inputStatus
      },
      settings: this.settings,
      precise_constants: this.constants.values,
      // 算法元信息（名字、标签、规则、公式说明）由后端统一下发，界面不再硬编码。
      algorithms: {
        current: this.settings.ratingAlgorithm,
        order: rating.ALGORITHMS,
        list: rating.ALGORITHM_META,
        zones: rating.ZONE_LABELS
      },
      last_scan_at: this.lastScanAt,
      error: this.lastError
    };
  }

  listCatalog() {
    return this.catalogView();
  }

  listRecords(limit) {
    return this.recordsView(limit);
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = {
  HelperService,
  DEFAULT_SETTINGS,
  normalizeSettings,
  normalizeNickname,
  truncateRating,
  exactDelta,
  truncatedDelta,
  ratingDeltaText,
  compareExact,
  ratingUnits,
  steamRoots
};
