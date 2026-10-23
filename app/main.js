'use strict';

const { app, BrowserWindow, ipcMain, dialog, screen, protocol, net, globalShortcut, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { spawn, spawnSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { HelperService } = require('./backend/helper-service.js');
const execFileAsync = promisify(execFile);

const APP_ROOT = __dirname;
const EXE_ROOT = path.dirname(process.execPath);
// Portable home of the whole program: the exe folder after packaging, the app
// folder while running from source. Used for the editable default table.
const APP_HOME = process.env.HELPER_APP_HOME
  ? path.resolve(process.env.HELPER_APP_HOME)
  : app.isPackaged ? EXE_ROOT : APP_ROOT;
const DATA_ROOT = process.env.HELPER_DATA_ROOT
  ? path.resolve(process.env.HELPER_DATA_ROOT)
  : path.join(app.isPackaged ? EXE_ROOT : path.dirname(APP_ROOT), 'user_data');
const RUNTIME_ROOT = path.join(DATA_ROOT, 'runtime');
const INPUT_CONFIG = path.join(RUNTIME_ROOT, 'input-config.json');
const INPUT_STATUS = path.join(RUNTIME_ROOT, 'input-status.json');
const PHASE_STATUS = path.join(RUNTIME_ROOT, 'phase-status.json');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'helper-asset',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
  }
]);
app.setPath('userData', path.join(DATA_ROOT, 'electron-profile'));

let mainWindow = null;
let overlayWindow = null;
let service = null;
let inputProcess = null;
let phaseProcess = null;
let inputOutput = '';
let phaseOutput = '';
let pollTimer = null;
let overlayExpanded = false;
let overlayVisible = false;
let manualOverlay = false;
let hoverOverlay = false;
let hoverLeaveAt = 0;
let lastStateSignature = '';
let gameLaunchLockedUntil = 0;
let lastOverlayPhase = 'Unknown';

// Cursor-distance trigger at the top-centre of the screen (see cursorInOverlayHotzone).
const OVERLAY_HOTZONE_HEIGHT = 22;
const OVERLAY_HOVER_HOLD_MS = 1500;

function helperScript(name) {
  const exe = path.join(APP_ROOT, 'scripts', name.replace(/_/g, '-') + '.exe');
  return { exe, py: path.join(APP_ROOT, 'scripts', name + '.py') };
}

function spawnPython(name, args) {
  const candidate = helperScript(name);
  try {
    require('node:fs').accessSync(candidate.exe);
    return spawn(candidate.exe, args, {
      cwd: APP_ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
    });
  } catch {
    return spawn(process.env.PYTHON || 'python', [candidate.py, ...args], {
      cwd: APP_ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
    });
  }
}

function terminateProcessTree(child) {
  if (!child || !child.pid) return;
  try {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 3000
    });
  } catch {}
  try { child.kill(); } catch {}
}

async function ensureRuntime() {
  await fs.mkdir(RUNTIME_ROOT, { recursive: true });
}

async function loadRuntimeState() {
  try {
    return JSON.parse(await fs.readFile(INPUT_STATUS, 'utf8'));
  } catch {
    return {};
  }
}

async function writeInputConfig(input) {
  await ensureRuntime();
  const temporary = INPUT_CONFIG + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(input, null, 2), 'utf8');
  await fs.rename(temporary, INPUT_CONFIG);
}

function startInputService(input) {
  if (inputProcess && !inputProcess.killed) return;
  writeInputConfig(input).then(() => {
    inputProcess = spawnPython('input_service', ['--config', INPUT_CONFIG, '--status', INPUT_STATUS]);
    inputProcess.stdout.on('data', chunk => {
      inputOutput += chunk.toString('utf8');
      const lines = inputOutput.split(/\r?\n/);
      inputOutput = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('INPUT ')) continue;
        try {
          service.setInputStatus(JSON.parse(line.slice(6)));
        } catch {}
      }
    });
    inputProcess.stderr.on('data', chunk => {
      service.setInputStatus({ running: false, error: chunk.toString('utf8').trim() });
    });
    inputProcess.on('exit', (code, signal) => {
      service.setInputStatus({
        running: false,
        error: code === 0 ? null : `输入服务退出：${code ?? signal ?? 'unknown'}`
      });
      inputProcess = null;
    });
  }).catch(error => service.setInputStatus({ running: false, error: error.message }));
}

async function restartInputService() {
  if (inputProcess && !inputProcess.killed) {
    inputProcess.kill();
    inputProcess = null;
  }
  const state = service.getState();
  startInputService(state.settings.input);
}

function startPhaseMonitor(simulate = false) {
  if (phaseProcess && !phaseProcess.killed) return;
  phaseProcess = spawnPython('phase_monitor', [
    ...(simulate ? ['--simulate'] : []),
    '--status',
    PHASE_STATUS
  ]);
  phaseProcess.stdout.on('data', chunk => {
    phaseOutput += chunk.toString('utf8');
    const lines = phaseOutput.split(/\r?\n/);
    phaseOutput = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('PHASE ')) continue;
      try {
        service.setPhase(JSON.parse(line.slice(6)));
      } catch {}
    }
  });
  phaseProcess.stderr.on('data', chunk => {
    service.setPhase({
      phase: 'Unknown',
      pid: 0,
      reason: 'monitor_error',
      notice: chunk.toString('utf8').trim() || '阶段监控不可用',
      supported: false
    });
  });
  phaseProcess.on('exit', (code, signal) => {
    if (!app.isQuitting) {
      service.setPhase({
        phase: 'Unknown',
        pid: 0,
        reason: 'monitor_stopped',
        notice: `阶段监控停止：${code ?? signal ?? 'unknown'}`,
        supported: false
      });
    }
    phaseProcess = null;
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1080,
    minHeight: 720,
    frame: false,
    backgroundColor: '#0e1523',
    show: false,
    roundedCorners: false,
    webPreferences: {
      preload: path.join(APP_ROOT, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });
  mainWindow.loadFile(path.join(APP_ROOT, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
    app.quit();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function overlayWidth() {
  const area = screen.getPrimaryDisplay().bounds;
  return Math.max(520, Math.min(704, Math.round(area.width * 0.32 / 32) * 32));
}

function overlayBounds(expanded) {
  const display = screen.getPrimaryDisplay();
  const area = display.bounds;
  const w = overlayWidth();
  const base = Math.max(62, Math.round(w * 76 / 640));
  const h = expanded ? base : 18;
  return {
    x: area.x + Math.floor((area.width - w) / 2),
    y: area.y,
    width: w,
    height: h
  };
}

/**
 * Screen-top summon zone. While the drawer is open the zone grows to the drawer
 * height so the cursor can stay inside it; it collapses back to a thin strip
 * once the drawer hides again.
 */
function cursorInOverlayHotzone() {
  const point = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(point).bounds;
  const w = overlayWidth();
  const left = area.x + Math.floor((area.width - w) / 2);
  const height = overlayExpanded
    ? Math.max(22, overlayBounds(true).height)
    : OVERLAY_HOTZONE_HEIGHT;
  return point.x >= left && point.x <= left + w &&
    point.y >= area.y && point.y <= area.y + height;
}

/** Poll the cursor; returns true when the summon state changed this tick. */
function pumpOverlayHover(state) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return false;
  const phase = state.phase?.phase || 'Unknown';
  const enabled = state.settings?.overlayEnabled !== false;
  const before = hoverOverlay;
  if (!(enabled && (phase === 'Results' || phase === 'Menu'))) {
    hoverOverlay = false;
    hoverLeaveAt = 0;
    return before !== hoverOverlay;
  }
  if (cursorInOverlayHotzone()) {
    hoverOverlay = true;
    hoverLeaveAt = 0;
  } else if (hoverOverlay) {
    if (!hoverLeaveAt) hoverLeaveAt = Date.now() + OVERLAY_HOVER_HOLD_MS;
    if (Date.now() >= hoverLeaveAt) {
      hoverOverlay = false;
      hoverLeaveAt = 0;
    }
  }
  return before !== hoverOverlay;
}

/**
 * Results -> open. Returning to the song select screen (Menu) keeps it open.
 * Starting a chart (Playing) or closing the game hides it again.
 */
function syncOverlayPhase(phase) {
  if (phase === 'Results' && lastOverlayPhase !== 'Results') {
    manualOverlay = true;
  } else if (phase === 'Playing' && lastOverlayPhase !== 'Playing') {
    manualOverlay = false;
    hoverOverlay = false;
    hoverLeaveAt = 0;
  } else if (phase === 'Unknown') {
    manualOverlay = false;
    hoverOverlay = false;
    hoverLeaveAt = 0;
  }
  lastOverlayPhase = phase;
}

function refreshOverlayWindow(state) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const phase = state.phase?.phase || 'Unknown';
  const enabled = state.settings?.overlayEnabled !== false;
  const summonable = enabled && (phase === 'Results' || phase === 'Menu');
  const expanded = summonable && (manualOverlay || hoverOverlay);
  const visible = expanded;
  overlayVisible = visible;
  overlayExpanded = expanded;
  const bounds = overlayBounds(expanded);
  overlayWindow.setBounds(bounds, false);
  if (overlayVisible) {
    overlayWindow.setOpacity(0.94);
    overlayWindow.showInactive();
  } else {
    overlayWindow.hide();
  }
  overlayWindow.webContents.send('overlay-state', {
    state,
    expanded,
    visible
  });
}

function broadcastState() {
  if (!service) return;
  const state = service.getState();
  syncOverlayPhase(state.phase?.phase || 'Unknown');
  const hoverChanged = pumpOverlayHover(state);
  const signature = JSON.stringify({
    phase: state.phase,
    rating: state.result?.rating_display,
    change: state.rating_change,
    observed: state.observed_count,
    nickname: state.nickname,
    error: state.error,
    input: state.input.status,
    installation: state.installation
  });
  if (signature !== lastStateSignature || hoverChanged) {
    lastStateSignature = signature;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('state-update', state);
    refreshOverlayWindow(state);
  } else if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('overlay-state', {
      state,
      expanded: overlayExpanded,
      visible: overlayVisible
    });
  }
}

function createOverlayWindow() {
  const bounds = overlayBounds(false);
  overlayWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(APP_ROOT, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.loadFile(path.join(APP_ROOT, 'renderer', 'overlay.html'));
  overlayWindow.once('ready-to-show', () => overlayWindow.hide());
}

async function updateInputFromState() {
  const state = service.getState();
  await writeInputConfig(state.settings.input);
  if (!inputProcess) startInputService(state.settings.input);
}

function setGlobalOverlayKey(key) {
  globalShortcut.unregisterAll();
  const ok = globalShortcut.register(key || 'F5', () => {
    const phase = service?.getState().phase?.phase || 'Unknown';
    if (!['Results', 'Menu'].includes(phase)) return;
    manualOverlay = !manualOverlay;
    broadcastState();
  });
  return ok;
}

async function launchGame() {
  const state = service.getState();
  if (!state.installation?.exe) throw new Error('请先定位 In Falsus 游戏目录');
  const pids = await findGameProcesses();
  if (pids.length) {
    await focusGameWindow(pids[0]);
    return { alreadyRunning: true, viaSteam: false };
  }
  if (Date.now() < gameLaunchLockedUntil) {
    return { alreadyRunning: false, launching: true, viaSteam: true };
  }
  gameLaunchLockedUntil = Date.now() + 8000;
  const steamExe = path.join(
    path.dirname(path.dirname(path.dirname(state.installation.path))),
    'steam.exe'
  );
  try {
    await fs.access(steamExe);
    const child = spawn(steamExe, ['-applaunch', '3971950'], {
      cwd: path.dirname(steamExe),
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
    return { alreadyRunning: false, launching: true, viaSteam: true };
  } catch {
    try {
      await shell.openExternal('steam://rungameid/3971950');
      return { alreadyRunning: false, launching: true, viaSteam: true };
    } catch {
      const child = spawn(state.installation.exe, [], {
        cwd: state.installation.path,
        detached: true,
        stdio: 'ignore',
        windowsHide: false
      });
      child.unref();
      return { alreadyRunning: false, launching: true, viaSteam: false };
    }
  }
}

async function findGameProcesses() {
  try {
    const { stdout } = await execFileAsync(
      'tasklist.exe',
      ['/FI', 'IMAGENAME eq infalsus.exe', '/FO', 'CSV', '/NH'],
      { windowsHide: true, encoding: 'utf8', timeout: 3000 }
    );
    return [...stdout.matchAll(/"infalsus\.exe","(\d+)"/gi)].map(match => Number(match[1]));
  } catch {
    return [];
  }
}

async function focusGameWindow(pid) {
  const script = [
    "Add-Type @'",
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class FocusWindow {',
    '  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
    '}',
    "'@",
    `$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue`,
    'if ($p -and $p.MainWindowHandle -ne 0) {',
    '  [FocusWindow]::ShowWindowAsync($p.MainWindowHandle, 9) | Out-Null',
    '  [FocusWindow]::SetForegroundWindow($p.MainWindowHandle) | Out-Null',
    '}'
  ].join('\n');
  await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], {
    windowsHide: true,
    timeout: 3000
  }).catch(() => {});
}

async function relaunchAdmin() {
  const exe = process.execPath;
  const args = process.argv.slice(app.isPackaged ? 1 : 1);
  const command = `Start-Process -FilePath ${JSON.stringify(exe)} -ArgumentList ${JSON.stringify(args.join(' '))} -Verb RunAs`;
  spawn('powershell.exe', ['-NoProfile', '-Command', command], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore'
  }).unref();
  app.quit();
}

function registerIpc() {
  ipcMain.handle('state:get', () => service.getState());
  ipcMain.handle('catalog:list', () => service.listCatalog());
  ipcMain.handle('constants:save', (_event, values) => service.savePreciseConstants(values));
  ipcMain.handle('constants:set-default', () => service.savePreciseDefaults());
  ipcMain.handle('constants:reset-default', () => service.resetPreciseConstants());
  ipcMain.handle('nickname:set', (_event, value) => service.setNickname(value));
  ipcMain.handle('records:list', (_event, limit) => service.listRecords(
    Number.isSafeInteger(limit) ? Math.max(1, Math.min(1000, limit)) : 300
  ));
  ipcMain.handle('game:auto-locate', () => service.autoLocateGame());
  ipcMain.handle('game:refresh-catalog', () => service.refreshCatalog());
  ipcMain.handle('game:launch', () => launchGame());
  ipcMain.handle('game:choose', async () => {
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: '选择 In Falsus 游戏目录或 infalsus.exe',
      properties: ['openFile', 'openDirectory'],
      filters: [{ name: 'In Falsus', extensions: ['exe'] }]
    });
    if (picked.canceled || !picked.filePaths[0]) return null;
    return service.locateGame(picked.filePaths[0]);
  });
  ipcMain.handle('account:select', (_event, key) => service.selectAccount(key));
  ipcMain.handle('settings:update', async (_event, patch) => {
    const state = await service.setSettings(patch);
    await updateInputFromState();
    setGlobalOverlayKey(state.settings.overlayKey);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('state-update', state);
    return state;
  });
  ipcMain.handle('input:restart', async () => {
    await restartInputService();
    return service.getState();
  });
  ipcMain.handle('archive:reveal', async () => {
    await shell.openPath(path.join(DATA_ROOT, 'accounts'));
    return true;
  });
  ipcMain.handle('export:save', async (_event, payload) => {
    if (!payload || !(payload.data instanceof Uint8Array) || payload.data.length > 64 * 1024 * 1024) {
      throw new Error('导出数据无效');
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出 Top 30 分表',
      defaultPath: path.join(app.getPath('pictures'), `InFalsus_Top30_${stamp}.png`),
      filters: [{ name: 'PNG 图片', extensions: ['png'] }]
    });
    if (result.canceled || !result.filePath) return null;
    await fs.writeFile(result.filePath, Buffer.from(payload.data));
    return result.filePath;
  });
  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.handle('window:close', () => mainWindow?.close());
  ipcMain.handle('app:relaunch-admin', () => relaunchAdmin());
  ipcMain.handle('app:version', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    root: DATA_ROOT
  }));
}

async function bootstrap() {
  await ensureRuntime();
  registerAssetProtocol();
  const smoke = process.env.HELPER_SMOKE === '1';
  service = new HelperService({
    appRoot: APP_ROOT,
    appHome: APP_HOME,
    dataRoot: DATA_ROOT,
    emit: (type, value) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('backend-event', { type, value });
    }
  });
  registerIpc();
  if (!smoke) startPhaseMonitor();
  await service.initialize();
  const initial = service.getState();
  const runtime = await loadRuntimeState();
  if (runtime && Object.keys(runtime).length) service.setInputStatus(runtime);
  if (!smoke) startInputService(initial.settings.input);
  setGlobalOverlayKey(initial.settings.overlayKey);
  createMainWindow();
  createOverlayWindow();
  pollTimer = setInterval(broadcastState, 120);
  if (smoke) {
    startPhaseMonitor(true);
    const smokeDelay = Math.max(1200, Number(process.env.HELPER_SMOKE_DELAY || 2400));
    setTimeout(async () => {
      try {
        if (process.env.HELPER_TEST_LAUNCH === '1' && mainWindow && !mainWindow.isDestroyed()) {
          const launched = await mainWindow.webContents.executeJavaScript('window.helperAPI.launchGame()');
          if (process.env.HELPER_TEST_RESULT) {
            await fs.writeFile(process.env.HELPER_TEST_RESULT, JSON.stringify(launched, null, 2));
          }
        }
        const page = process.env.HELPER_CAPTURE_PAGE;
        if (page && mainWindow && !mainWindow.isDestroyed()) {
          await mainWindow.webContents.executeJavaScript(
            `document.querySelector('[data-page="${String(page).replace(/[^a-z]/gi, '')}"]')?.click()`
          );
          await new Promise(resolve => setTimeout(resolve, 700));
        }
        const target = process.env.HELPER_CAPTURE_PATH;
        if (target && mainWindow && !mainWindow.isDestroyed()) {
          const image = await mainWindow.webContents.capturePage();
          await fs.writeFile(target, image.toPNG());
        }
        const overlayTarget = process.env.HELPER_OVERLAY_CAPTURE_PATH;
        if (overlayTarget && overlayWindow && !overlayWindow.isDestroyed()) {
          const image = await overlayWindow.webContents.capturePage();
          await fs.writeFile(overlayTarget, image.toPNG());
        }
        const exportTarget = process.env.HELPER_TOP30_CAPTURE_PATH;
        if (exportTarget && mainWindow && !mainWindow.isDestroyed()) {
          const rendered = await mainWindow.webContents.executeJavaScript(`
            (async () => {
              try {
                const buffer = await buildTop30Image();
                const bytes = new Uint8Array(buffer);
                let text = '';
                for (let i = 0; i < bytes.length; i += 0x8000) {
                  text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
                }
                return { ok: true, base64: btoa(text) };
              } catch (error) {
                return { ok: false, message: error?.message || String(error), stack: error?.stack || null };
              }
            })()
          `);
          if (!rendered?.ok) throw new Error(rendered?.message || 'Top30 渲染失败');
          await fs.writeFile(exportTarget, Buffer.from(rendered.base64, 'base64'));
        }
      } catch (error) {
        if (process.env.HELPER_CAPTURE_ERROR) {
          const diagnostic = {
            message: error?.message || String(error),
            stack: error?.stack || null,
            detail: error?.detail || null,
            raw: (() => { try { return JSON.stringify(error); } catch { return null; } })()
          };
          await fs.writeFile(process.env.HELPER_CAPTURE_ERROR, JSON.stringify(diagnostic, null, 2));
        }
      } finally {
        app.isQuitting = true;
        app.exit(0);
      }
    }, smokeDelay);
  }
}

function registerAssetProtocol() {
  protocol.handle('helper-asset', async request => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'cover') return new Response('Not found', { status: 404 });
      const chart = decodeURIComponent(url.pathname.replace(/^\//, ''));
      const songId = chart.replace(/-(?:min|evo|ult|fbd)$/i, '');
      if (!/^if-(?:wiki|local)-[a-zA-Z0-9-]+$/.test(songId)) {
        return new Response('Not found', { status: 404 });
      }
      let bytes;
      try {
        bytes = await fs.readFile(path.join(DATA_ROOT, 'covers', songId + '.webp'));
      } catch {
        bytes = await fs.readFile(path.join(APP_ROOT, 'assets', 'covers', songId + '.webp'));
      }
      return new Response(bytes, {
        headers: {
          'Content-Type': 'image/webp',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store'
        }
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.whenReady().then(bootstrap).catch(error => {
    dialog.showErrorBox('InFalsus Helper 启动失败', String(error?.stack || error));
    app.quit();
  });
}

app.on('window-all-closed', () => app.exit(0));
app.on('before-quit', () => {
  app.isQuitting = true;
  globalShortcut.unregisterAll();
  if (pollTimer) clearInterval(pollTimer);
  service?.close();
  terminateProcessTree(inputProcess);
  terminateProcessTree(phaseProcess);
  inputProcess = null;
  phaseProcess = null;
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
});
