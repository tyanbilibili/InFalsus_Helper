'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

const { SafeStore } = require('./store.cjs');
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


class HelperService {
  constructor({ appRoot, appHome, dataRoot, emit }) {
    this.appRoot = path.resolve(appRoot);
    this.appHome = path.resolve(appHome || appRoot);
    this.dataRoot = path.resolve(dataRoot || path.join(this.appRoot, 'user_data'));
    this.emit = typeof emit === 'function' ? emit : () => {};
    this.storeRoot = this.dataRoot;
    this.catalogRoot = path.join(this.dataRoot, 'catalog_data');
    this.store = new SafeStore(this.storeRoot);
    this.settings = clone(DEFAULT_SETTINGS);
    this.preciseConstants = {};
    this.preciseDefaults = {};
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
    this.coverStatus = { updated: 0, missing: [], error: null, updated_at: null };
    this.phase = { phase: 'Unknown', pid: 0, reason: 'not_started', notice: '等待游戏连接' };
    this.inputStatus = { running: false, enabled: true, message: '输入服务尚未启动' };
    this.scanning = false;
    this.timer = null;
  }

  async initialize() {
    await this.store.init();
    const savedSettings = await this.store.read('settings.json');
    this.settings = normalizeSettings(savedSettings);
    if (savedSettings && savedSettings.schema !== this.settings.schema) {
      await this.store.write('settings.json', this.settings, { backup: true });
    }
    await this.loadPreciseDefaults();
    await this.loadPreciseConstants();
    await this.loadCatalog();
    await this.restoreInstallation();
    await this.scanSaves(true);
    this.timer = setInterval(() => {
      this.scanSaves(false).catch(error => {
        this.lastError = error.code || 'SCAN_FAILED';
      });
    }, 1000);
    return this.getState();
  }

  async loadCatalog() {
    this.catalogData = await loadActive(this.catalogRoot);
  }

  async loadPreciseConstants() {
    const stored = await this.store.read('precise-constants.json');
    // A fresh install (no local edits yet) starts from the packaged default table,
    // so a release can ship one curated precise-constant table.
    this.preciseConstants = stored === null
      ? { ...this.preciseDefaults }
      : this.preciseValuesOf(stored);
  }

  /** Portable default table next to the executable (easy to inspect/replace). */
  externalDefaultsPath() {
    return path.join(this.appHome, 'data', 'precise-defaults.json');
  }

  /** Fallback copy bundled inside the app resources. */
  bundledDefaultsPath() {
    return path.join(this.appRoot, 'data', 'precise-defaults.json');
  }

  preciseValuesOf(stored) {
    return stored?.schema === 'infalsus-precise-constants/v1' &&
      stored.values && typeof stored.values === 'object' && !Array.isArray(stored.values)
      ? { ...stored.values }
      : {};
  }

  async readPreciseDefaults(file) {
    try {
      return this.preciseValuesOf(JSON.parse(await fs.readFile(file, 'utf8')));
    } catch {
      return {};
    }
  }

  async writePreciseDefaults(values, file = this.externalDefaultsPath()) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = file + '.tmp';
    await fs.writeFile(temporary, JSON.stringify({
      schema: 'infalsus-precise-constants/v1',
      updated_at: new Date().toISOString(),
      values
    }, null, 2) + '\n', 'utf8');
    await fs.rename(temporary, file);
  }

  async loadPreciseDefaults() {
    const externalPath = this.externalDefaultsPath();
    const bundledPath = this.bundledDefaultsPath();
    const external = await this.readPreciseDefaults(externalPath);
    if (Object.keys(external).length) {
      this.preciseDefaults = external;
      return;
    }
    if (externalPath !== bundledPath) {
      const bundled = await this.readPreciseDefaults(bundledPath);
      if (Object.keys(bundled).length) {
        this.preciseDefaults = bundled;
        // Mirror the bundled table to the visible location next to the executable.
        await this.writePreciseDefaults(bundled, externalPath).catch(() => {});
        return;
      }
    }
    // Older 1.1.0 builds parked the default table inside user_data; adopt and move it.
    const legacy = this.preciseValuesOf(await this.store.read('precise-defaults.json'));
    if (!Object.keys(legacy).length) {
      this.preciseDefaults = {};
      return;
    }
    this.preciseDefaults = legacy;
    const moved = await this.writePreciseDefaults(legacy, externalPath).then(() => true, () => false);
    if (moved) {
      await fs.unlink(path.join(this.dataRoot, 'precise-defaults.json')).catch(() => {});
    }
  }

  /** Copy the current precise table into the default table shipped with releases. */
  async savePreciseDefaults() {
    this.preciseDefaults = { ...this.preciseConstants };
    try {
      await this.writePreciseDefaults(this.preciseDefaults);
    } catch {
      try {
        await this.writePreciseDefaults(this.preciseDefaults, this.bundledDefaultsPath());
      } catch (error) {
        throw new Error('无法写入默认精确定数表，请把程序放在可写目录后再试。' +
          (error?.message ? `（${error.message}）` : ''));
      }
    }
    this.lastRatingChange = null;
    this.recalculateCurrent();
    return this.getState();
  }

  /** Replace the current precise table with the stored default table. */
  async resetPreciseConstants() {
    this.preciseConstants = { ...this.preciseDefaults };
    this.lastRatingChange = null;
    await this.store.write('precise-constants.json', {
      schema: 'infalsus-precise-constants/v1',
      updated_at: new Date().toISOString(),
      values: this.preciseConstants
    }, { backup: true });
    this.recalculateCurrent();
    return this.getState();
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
        this.lastError = error.message;
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
    const missing = [];
    for (const song of this.catalogData?.catalog?.songs || []) {
      let found = false;
      for (const root of [writable, bundled]) {
        try {
          await fs.access(path.join(root, song.id + '.webp'));
          found = true;
          break;
        } catch {}
      }
      if (!found) missing.push(song.id);
    }
    if (!missing.length) {
      this.coverStatus = { updated: 0, missing: [], error: null, updated_at: new Date().toISOString() };
      return this.coverStatus;
    }

    const scriptExe = path.join(this.appRoot, 'scripts', 'cover-extractor.exe');
    const scriptPy = path.join(this.appRoot, 'scripts', 'cover_extractor.py');
    let command = process.env.PYTHON || 'python';
    let args = [scriptPy];
    try {
      await fs.access(scriptPy);
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
        cwd: this.appRoot,
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
    const candidate = {
      ...this.settings,
      ...(patch || {}),
      input: {
        ...this.settings.input,
        ...((patch && patch.input) || {})
      }
    };
    this.settings = normalizeSettings(candidate);
    if (previousDeveloperMode !== this.settings.developerMode) this.lastRatingChange = null;
    await this.store.write('settings.json', this.settings, { backup: true });
    this.recalculateCurrent();
    this.emit('settings', this.settings);
    return this.getState();
  }

  effectiveConstant(chart) {
    const edited = this.settings.developerMode ? this.preciseConstants[chart.id] : null;
    return edited ?? Number(chart.rating).toFixed(1);
  }

  effectiveCatalog() {
    return {
      ...this.catalogData.catalog,
      songs: this.catalogData.catalog.songs.map(song => ({
        ...song,
        charts: Object.fromEntries(Object.entries(song.charts).map(([difficulty, chart]) => [
          difficulty,
          { ...chart, rating: this.effectiveConstant(chart) }
        ]))
      }))
    };
  }

  baseChartMap() {
    const map = new Map();
    for (const song of this.catalogData?.catalog?.songs || []) {
      for (const chart of Object.values(song.charts || {})) {
        map.set(chart.id, { ...chart, song });
      }
    }
    return map;
  }

  recalculateCurrent() {
    if (!this.archive || !this.current) return;
    const calculated = this.calculateArchive(this.archive);
    calculated.result.top30 = calculated.result.top30.map(entry => ({
      ...entry,
      cover_url: `helper-asset://cover/${entry.chart_id}`
    }));
    calculated.result.rating_change = this.lastRatingChange;
    calculated.result.last_play = this.lastPlay;
    if (this.lastPlay) {
      const one = rating.evaluatePlay({
        chart_id: this.lastPlay.chart_id,
        score: this.lastPlay.score
      }, this.effectiveCatalog());
      this.lastPlay.single_rating_display = one.rating_display;
      this.lastPlay.single_rating_text = truncateRating(one.rating_display, this.settings.ratingDigits);
      calculated.result.last_play = this.lastPlay;
    }
    this.current = calculated.result;
  }

  async savePreciseConstants(values) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw new Error('INVALID_PRECISE_CONSTANTS');
    }
    const charts = this.baseChartMap();
    const normalized = {};
    for (const [chartId, value] of Object.entries(values)) {
      const chart = charts.get(chartId);
      if (!chart || !/^\d{1,2}(?:\.\d)?$/.test(String(value))) {
        throw new Error('INVALID_PRECISE_CONSTANT');
      }
      const numeric = Number(value);
      if (!(numeric >= 0 && numeric <= 99.9)) throw new Error('INVALID_PRECISE_CONSTANT');
      if (Math.round(numeric * 10) !== Math.round(Number(chart.rating) * 10)) {
        normalized[chartId] = numeric.toFixed(1);
      }
    }
    this.preciseConstants = normalized;
    this.lastRatingChange = null;
    await this.store.write('precise-constants.json', {
      schema: 'infalsus-precise-constants/v1',
      updated_at: new Date().toISOString(),
      values: normalized
    }, { backup: true });
    this.recalculateCurrent();
    return this.getState();
  }

  setPhase(update) {
    this.phase = update;
  }

  setInputStatus(update) {
    this.inputStatus = { ...this.inputStatus, ...update };
  }

  chartMap() {
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
    return map;
  }

  mappingBySong() {
    const map = new Map();
    for (const item of this.catalogData?.mapping?.songs || []) {
      map.set(item.game_song_id, item);
    }
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

  async readArchive(key) {
    const file = `accounts/${key}/archive.json`;
    const found = await this.store.read(file);
    if (found?.schema === 'infalsus-helper-archive/v1' &&
        found.account_key === key && Array.isArray(found.records)) {
      return found;
    }
    return {
      schema: 'infalsus-helper-archive/v1',
      account_key: key,
      created_at: new Date().toISOString(),
      updated_at: null,
      records: [],
      last_source_hash: null,
      last_rating: null
    };
  }

  async archiveAccount(account, announce) {
    const stable = await readStable(account.file);
    const archive = await this.readArchive(account.key);
    const needsHistoryUpgrade = archive.records.some(record =>
      !Number.isInteger(record.slot) || !Number.isInteger(record.history_order));
    if (archive.last_source_hash === stable.sha256 && !needsHistoryUpgrade) {
      return { archive, added: [] };
    }
    const parsed = parseSave(stable.buffer);
    const known = new Map(archive.records.map(record => [record.id, record]));
    const added = [];
    const now = new Date().toISOString();
    for (const record of parsed.history) {
      const existing = known.get(record.id);
      if (existing) {
        existing.slot = record.slot;
        existing.history_order = record.history_order;
      } else {
        const stored = { ...record, first_observed_at: now };
        known.set(record.id, stored);
        added.push(stored);
      }
    }
    const next = {
      ...archive,
      records: [...known.values()],
      updated_at: now,
      last_source_hash: stable.sha256,
      coverage: {
        history_occupied: parsed.occupied,
        history_capacity: parsed.slots,
        highscore_count: parsed.highscores.length
      }
    };
    await this.store.write(`accounts/${account.key}/archive.json`, next, { backup: true });
    if (announce) {
      this.emit('archive', { account_key: account.key, added: added.length, total: next.records.length });
    }
    return { archive: next, added };
  }

  calculateArchive(archive) {
    const bySong = this.mappingBySong();
    const charts = this.chartMap();
    const plays = [];
    const evaluatedRecords = [];
    for (const record of archive.records) {
      const projected = this.projectRecord(record, bySong, charts);
      if (!projected) continue;
      plays.push({ chart_id: projected.chart_id, score: projected.score, counts: projected.counts });
      evaluatedRecords.push(projected);
    }
    const result = rating.calculate({
      schema: rating.INPUT_SCHEMA,
      plays
    }, this.effectiveCatalog());
    result.rating_text = truncateRating(result.rating_display, this.settings.ratingDigits);
    return { result, evaluatedRecords };
  }

  async scanSaves(initial) {
    if (this.scanning) return;
    this.scanning = true;
    try {
      this.accounts = await discover();
      if (!this.accounts.length) {
        this.current = null;
        this.lastScanAt = new Date().toISOString();
        return;
      }
      const selected = this.accounts.find(account => account.key === this.settings.selectedAccount)
        || (this.accounts.length === 1 ? this.accounts[0] : null);
      if (!selected) {
        this.selectedAccount = null;
        this.current = null;
        return;
      }
      if (selected.key !== this.selectedAccount) {
        this.selectedAccount = selected.key;
        this.lastRatingChange = null;
        this.lastPlay = null;
        if (this.settings.selectedAccount !== selected.key) {
          this.settings = { ...this.settings, selectedAccount: selected.key };
          await this.store.write('settings.json', this.settings, { backup: true });
        }
      }
      const scanned = await this.archiveAccount(selected, !initial);
      this.archive = scanned.archive;
      const before = this.calculateArchive({
        ...scanned.archive,
        records: scanned.archive.records.filter(record =>
          !scanned.added.some(item => item.id === record.id))
      });
      const after = this.calculateArchive(scanned.archive);
      after.result.top30 = after.result.top30.map(entry => ({
        ...entry,
        cover_url: `helper-asset://cover/${entry.chart_id}`
      }));
      const hadPrior = !!scanned.archive.last_rating &&
        scanned.added.length > 0 &&
        scanned.archive.records.length > scanned.added.length;
      this.previousRating = hadPrior ? before.result : null;
      this.current = after.result;
      // Delta is computed from the two truncated 3-decimal totals, so the value in
      // the overlay is exactly (new total) - (old total) as printed on screen.
      this.current.rating_change = hadPrior
        ? truncatedDelta(before.result.rating_text, after.result.rating_text, this.settings.ratingDigits)
        : this.lastRatingChange;
      if (hadPrior) this.lastRatingChange = this.current.rating_change;
      this.current.previous_rating = hadPrior ? before.result.rating_text : null;
      const lastRaw = scanned.added[scanned.added.length - 1] || null;
      if (lastRaw) {
        this.lastPlay = this.projectRecord(lastRaw, this.mappingBySong(), this.chartMap());
      }
      if (this.lastPlay && this.current) {
        const one = rating.evaluatePlay({
          chart_id: this.lastPlay.chart_id,
          score: this.lastPlay.score
        }, this.effectiveCatalog());
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
      this.lastScanAt = new Date().toISOString();
      this.lastError = null;
      if (scanned.added.length && !initial) {
        this.emit('rating', {
          rating: this.current.rating_text,
          change: this.current.rating_change,
          lastPlay: this.lastPlay
        });
      }
    } catch (error) {
      this.lastError = error.message || 'SAVE_READ_FAILED';
    } finally {
      this.scanning = false;
    }
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
      cover_url: `helper-asset://cover/${song.id}`,
      charts: Object.values(song.charts || {}).map(chart => ({
        chart_id: chart.id,
        difficulty: chart.difficulty,
        constant: Number(this.effectiveConstant(chart)),
        constant_display: this.effectiveConstant(chart),
        base_constant: chart.rating,
        base_constant_display: Number(chart.rating).toFixed(1),
        modified: Object.hasOwn(this.preciseConstants, chart.id),
        designer: chart.designer,
        cover_url: `helper-asset://cover/${chart.id}`
      }))
    }));
  }

  recordsView(limit = 300) {
    if (!this.archive || !this.current) return [];
    const charts = this.chartMap();
    const bySong = this.mappingBySong();
    return this.archive.records
      .map(record => {
        const projected = this.projectRecord(record, bySong, charts);
        if (!projected) return null;
        const one = rating.evaluatePlay({
          chart_id: projected.chart_id,
          score: projected.score
        }, this.effectiveCatalog());
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
        cover_update: this.coverStatus
      } : null,
      accounts: this.accounts.map(account => this.accountView(account)),
      selected_account: this.selectedAccount,
      nickname: this.displayName(),
      selected_short_id: this.currentAccount()?.key.slice(0, 8) || null,
      observed_count: this.archive?.records?.length || 0,
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
      precise_constants: this.preciseConstants,
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
  ratingUnits,
  steamRoots
};
