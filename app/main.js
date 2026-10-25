'use strict';

const { app, BrowserWindow, ipcMain, dialog, screen, protocol, net, globalShortcut, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { spawn, spawnSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { HelperService } = require('./backend/helper-service.js');
const OVERLAY_STATE = require('./backend/overlay-state.js');
const execFileAsync = promisify(execFile);

const APP_ROOT = __dirname;
const EXE_ROOT = path.dirname(process.execPath);
// Portable home of the whole program: the exe folder after packaging, the app
// folder while running from source. Used for the editable default table.
const APP_HOME = process.env.HELPER_APP_HOME
  ? path.resolve(process.env.HELPER_APP_HOME)
  : app.isPackaged ? EXE_ROOT : APP_ROOT;
// 发布根目录：VERSION.txt / README 等随包文件所在的位置。
const RELEASE_ROOT = app.isPackaged ? EXE_ROOT : path.dirname(APP_ROOT);
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
// Whole drawer state lives in one object; see backend/overlay-state.js.
let overlay = OVERLAY_STATE.INITIAL;
let lastStateSignature = '';
let lastOverlayBounds = null;
let gameLaunchLockedUntil = 0;

// Cursor-distance trigger at the top-centre of the screen (see cursorInOverlayHotzone).
const OVERLAY_HOTZONE_HEIGHT = 22;

/** Executables cannot be spawned from inside app.asar; they live in app.asar.unpacked. */
function asarUnpacked(target) {
  return target.includes('app.asar') ? target.replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked') : target;
}

function helperScript(name) {
  const dir = path.join(APP_ROOT, 'scripts');
  return {
    exe: asarUnpacked(path.join(dir, name.replace(/_/g, '-') + '.exe')),
    py: path.join(dir, name + '.py')
  };
}

function spawnPython(name, args) {
  const candidate = helperScript(name);
  // cwd must be a real directory; an asar path would fail for both branches.
  const cwd = path.dirname(candidate.exe);
  try {
    require('node:fs').accessSync(candidate.exe);
    return spawn(candidate.exe, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
    });
  } catch {
    return spawn(process.env.PYTHON || 'python', [asarUnpacked(candidate.py), ...args], {
      cwd,
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

/**
 * Primary display bounds, cached until the OS reports a display change.
 * Re-querying it on every 120 ms hover tick was needless work.
 */
let primaryBoundsCache = null;

function primaryBounds() {
  if (!primaryBoundsCache) {
    const area = screen.getPrimaryDisplay().bounds;
    primaryBoundsCache = { x: area.x, y: area.y, width: area.width, height: area.height };
  }
  return primaryBoundsCache;
}

function overlayWidth() {
  const area = primaryBounds();
  return Math.max(520, Math.min(704, Math.round(area.width * 0.32 / 32) * 32));
}

/**
 * 展开时的高度。
 *
 * 游戏一般按 16:9 居中显示，屏幕上下留出的黑边就是浮窗可用的高度
 * （2560×1600 屏跑 2560×1440 游戏时只有约 70px）。所以这里固定 66px，
 * 既装得下放大后的数字，又不会盖住游戏画面。
 */
const OVERLAY_EXPANDED_HEIGHT = 66;

function overlayExpandedHeight() {
  return OVERLAY_EXPANDED_HEIGHT;
}

function overlayBounds(expanded) {
  const area = primaryBounds();
  const w = overlayWidth();
  const h = expanded ? overlayExpandedHeight() : 18;
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
function cursorInOverlayHotzone(expanded) {
  const point = screen.getCursorScreenPoint();
  const area = primaryBounds();
  const w = overlayWidth();
  const left = area.x + Math.floor((area.width - w) / 2);
  const height = expanded ? overlayExpandedHeight() : OVERLAY_HOTZONE_HEIGHT;
  return point.x >= left && point.x <= left + w &&
    point.y >= area.y && point.y <= area.y + height;
}

/**
 * Advance the drawer state machine and mirror the result onto the window.
 * Returns true when the open/closed state changed.
 */
function evalOverlay(state, sampleCursor = true) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return false;
  const phase = state.phase?.phase || 'Unknown';
  const enabled = state.settings?.overlayEnabled !== false;
  const next = OVERLAY_STATE.overlayNext(overlay, {
    phase,
    enabled,
    cursorInside: sampleCursor ? cursorInOverlayHotzone(overlay.expanded) : false,
    now: Date.now()
  });
  const changed = next.expanded !== overlay.expanded;
  overlay = next;
  if (changed) syncOverlayWindow(state);
  return changed;
}

/** Push the current drawer state onto the real window. */
function syncOverlayWindow(state) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const bounds = overlayBounds(overlay.expanded);
  // setBounds is a cross-process call; skip it when nothing actually moved.
  if (!lastOverlayBounds ||
      lastOverlayBounds.x !== bounds.x || lastOverlayBounds.y !== bounds.y ||
      lastOverlayBounds.width !== bounds.width || lastOverlayBounds.height !== bounds.height) {
    overlayWindow.setBounds(bounds, false);
    lastOverlayBounds = bounds;
  }
  if (overlay.expanded) {
    overlayWindow.setOpacity(0.94);
    overlayWindow.showInactive();
  } else {
    overlayWindow.hide();
  }
  overlayWindow.webContents.send('overlay-state', {
    state,
    expanded: overlay.expanded,
    visible: overlay.expanded
  });
}

function broadcastState() {
  if (!service) return;
  const state = service.getState();
  const overlayChanged = evalOverlay(state);
  const signature = JSON.stringify({
    phase: state.phase,
    rating: state.result?.rating_display,
    change: state.rating_change,
    observed: state.observed_count,
    best: state.best_score_count,
    nickname: state.nickname,
    error: state.error,
    input: state.input.status,
    installation: state.installation
  });
  if (signature !== lastStateSignature || overlayChanged) {
    lastStateSignature = signature;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('state-update', state);
    syncOverlayWindow(state);
  } else if (overlay.expanded && overlayWindow && !overlayWindow.isDestroyed()) {
    // Nothing to show: don't keep pushing IPC into a hidden window.
    overlayWindow.webContents.send('overlay-state', {
      state,
      expanded: overlay.expanded,
      visible: overlay.expanded
    });
  }
}

/**
 * Event-driven broadcast: anything that changes state asks for a push instead of
 * the old fixed 120 ms poll. Coalesced so a burst of events costs one update.
 */
let broadcastPending = false;
function requestBroadcast() {
  // Before the main window exists there is nobody to update; bootstrap sends one
  // broadcast explicitly once the windows are ready.
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (broadcastPending) return;
  broadcastPending = true;
  setImmediate(() => {
    broadcastPending = false;
    broadcastState();
  });
}

/** Low-frequency tick: samples the cursor and advances the drawer state machine. */
function overlayTick() {
  if (!service) return;
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const state = service.getState();
  const phase = state.phase?.phase || 'Unknown';
  // 光标采样是同步系统调用，只在浮窗有机会出现时才做。
  if (!OVERLAY_STATE.isSummonable(phase) && !overlay.expanded) {
    evalOverlay(state, false);
    return;
  }
  evalOverlay(state, true);
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
    const state = service?.getState();
    if (!state) return;
    const phase = state.phase?.phase || 'Unknown';
    if (!OVERLAY_STATE.isSummonable(phase)) return;
    overlay = OVERLAY_STATE.overlayToggle(overlay);
    // Recompute `expanded` from the new manual flag, then repaint everywhere.
    evalOverlay(state);
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

/**
 * Relaunch with an elevated token via UAC.
 *
 * Why a VBScript and not PowerShell:
 *  - `spawn(..., { detached: true })` on Windows made powershell.exe exit with
 *    code 0 without running anything (verified: the child wrote no output at all),
 *    and a non-detached child is killed the moment this process quits.
 *  - wscript.exe is a GUI-subsystem host that outlives us, and Shell.Application's
 *    ShellExecute supports the "runas" verb directly — no PowerShell quoting,
 *    no UAC timing race.
 * The single-instance lock is released first, otherwise the elevated copy would
 * start, see the old instance and quit immediately.
 */
async function relaunchAdmin() {
  const exe = process.execPath;
  // Packaged: just the exe. From source: electron.exe needs the project root.
  const args = app.isPackaged ? process.argv.slice(1) : [path.dirname(APP_ROOT)];
  const workDir = path.dirname(exe);
  const vbsQuote = value => '"' + String(value).replace(/"/g, '""') + '"';
  const paramLine = args
    .map(arg => (/\s/.test(arg) ? `"${arg}"` : arg))
    .join(' ');
  const vbs = [
    'Set sh = CreateObject("Shell.Application")',
    `sh.ShellExecute ${vbsQuote(exe)}, ${vbsQuote(paramLine)}, ${vbsQuote(workDir)}, "runas", 1`
  ].join('\r\n');

  const vbsPath = path.join(RUNTIME_ROOT, 'relaunch-admin.vbs');
  try {
    await ensureRuntime();
    // wscript requires UTF-16LE with a BOM; this also keeps non-ASCII paths intact.
    await fs.writeFile(vbsPath, Buffer.concat([
      Buffer.from([0xFF, 0xFE]),
      Buffer.from(vbs, 'utf16le')
    ]));
  } catch (error) {
    dialog.showErrorBox('无法以管理员身份重启', String(error?.message || error));
    return false;
  }

  try {
    spawn('wscript.exe', ['//B', '//nologo', vbsPath], {
      cwd: workDir,
      windowsHide: true,
      stdio: 'ignore'
    }).unref();
  } catch (error) {
    dialog.showErrorBox('无法以管理员身份重启', String(error?.message || error));
    return false;
  }

  // Let wscript hand the launch to the shell before this instance disappears.
  await new Promise(resolve => setTimeout(resolve, 600));
  app.releaseSingleInstanceLock();
  app.quit();
  return true;
}

function registerIpc() {
  // --- 状态与列表 ---
  ipcMain.handle('state:get', () => service.getState());
  ipcMain.handle('catalog:list', () => service.listCatalog());
  ipcMain.handle('constants:save', (_event, values) => service.savePreciseConstants(values));
  ipcMain.handle('constants:set-default', () => service.savePreciseDefaults());
  ipcMain.handle('constants:reset-default', () => service.resetPreciseConstants());
  ipcMain.handle('nickname:set', (_event, value) => service.setNickname(value));
  ipcMain.handle('records:list', (_event, limit) => service.listRecords(
    Number.isSafeInteger(limit) ? Math.max(1, Math.min(1000, limit)) : 300
  ));
  // --- 游戏定位与启动 ---
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
  // --- 账号与设置 ---
  ipcMain.handle('account:select', (_event, key) => service.selectAccount(key));
  ipcMain.handle('settings:update', async (_event, patch) => {
    const state = await service.setSettings(patch);
    await updateInputFromState();
    setGlobalOverlayKey(state.settings.overlayKey);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('state-update', state);
    return state;
  });
  // --- 输入服务与窗口 ---
  ipcMain.handle('input:restart', async () => {
    await restartInputService();
    return service.getState();
  });
  ipcMain.handle('archive:reveal', async () => {
    await shell.openPath(path.join(DATA_ROOT, 'accounts'));
    return true;
  });
  // --- 导出 ---
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
  // --- 窗口控制 ---
  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.handle('window:close', () => mainWindow?.close());
  ipcMain.handle('app:relaunch-admin', () => relaunchAdmin());
  ipcMain.handle('app:version', async () => {
    // VERSION.txt 是发布版号的唯一来源；读取失败时退回 package.json 的版本。
    let version = app.getVersion();
    let versionSource = 'package.json';
    try {
      const raw = await fs.readFile(path.join(RELEASE_ROOT, 'VERSION.txt'), 'utf8');
      const match = /v?(\d+(?:\.\d+)*)/.exec(raw.trim());
      if (match) {
        version = match[1];
        versionSource = 'VERSION.txt';
      }
    } catch {}
    return {
      version,
      version_source: versionSource,
      electron: process.versions.electron,
      node: process.versions.node,
      root: DATA_ROOT
    };
  });
}

async function bootstrap() {
  await ensureRuntime();
  // Drop the elevated-relaunch helper left behind by a previous run.
  await fs.unlink(path.join(RUNTIME_ROOT, 'relaunch-admin.vbs')).catch(() => {});
  // Display geometry is cached for the hover probe; drop it when the OS changes it.
  const resetDisplayCache = () => {
    primaryBoundsCache = null;
    lastOverlayBounds = null;
  };
  screen.on('display-metrics-changed', resetDisplayCache);
  screen.on('display-added', resetDisplayCache);
  screen.on('display-removed', resetDisplayCache);
  registerAssetProtocol();
  const smoke = process.env.HELPER_SMOKE === '1';
  service = new HelperService({
    appRoot: APP_ROOT,
    appHome: APP_HOME,
    dataRoot: DATA_ROOT,
    emit: (type, value) => {
      // Every service event means UI state may have changed; coalesce a broadcast.
      requestBroadcast();
      if (type !== 'state' && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('backend-event', { type, value });
      }
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
  // Broadcasts are event-driven now; this tick only samples the cursor for the
  // top-centre summon hotzone.
  pollTimer = setInterval(overlayTick, 200);
  requestBroadcast();
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
                const buffer = await window.IFHExport.buildTop30Image(window.__IFH.state);
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
          // Cover art never changes within one run; the version query in the URL
          // already rotates per launch, so let Chromium cache it aggressively.
          'Cache-Control': 'public, max-age=31536000, immutable'
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
