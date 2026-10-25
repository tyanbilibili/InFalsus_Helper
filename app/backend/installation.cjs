'use strict';
// First-run discovery owns only launcher-private state. Game metadata stays read-only.
const fs = require('node:fs/promises');
const path = require('node:path');
const {SafeStore, noLinks} = require('./store.cjs');
const {readFile} = require('./readonly-resource.cjs');
const {vdf, discoverInstall, checkUpdate} = require('./catalog-update.cjs');
const {loadActive, DEFAULT_ROOT} = require('./catalog-data.cjs');
const fail = code => { throw new Error(code); };
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

async function inspectInstall(gameRoot) {
    if (typeof gameRoot !== 'string' || !path.isAbsolute(gameRoot)) fail('GAME_NOT_FOUND');
    gameRoot = path.resolve(gameRoot);
    await noLinks(gameRoot);
    const common = path.dirname(gameRoot), apps = path.dirname(common);
    if (path.basename(common).toLowerCase() !== 'common' ||
        path.basename(apps).toLowerCase() !== 'steamapps') fail('INVALID_STEAM_MANIFEST');
    const manifest = path.join(apps, 'appmanifest_3971950.acf');
    const state = vdf((await readFile(manifest, 1024 * 1024)).toString('utf8')).AppState;
    if (state?.appid !== '3971950' || typeof state.installdir !== 'string' ||
        /[\\/:]|^\.{1,2}$/.test(state.installdir) ||
        !samePath(path.join(common, state.installdir), gameRoot)) fail('INVALID_STEAM_MANIFEST');
    if (!/^\d+$/.test(state.buildid) || state.StateFlags !== '4' ||
        state.TargetBuildID && state.TargetBuildID !== state.buildid) fail('GAME_UPDATE_IN_PROGRESS');
    const exe = path.join(gameRoot, 'infalsus.exe');
    await noLinks(exe);
    if (!(await fs.stat(exe)).isFile()) fail('GAME_NOT_FOUND');
    return {gameRoot, manifest, build_id: state.buildid};
}

async function findInstall({steamRoots = [], gameRoot = null, saved = null} = {}) {
    // Explicit selection and an already verified user preference take precedence.
    if (gameRoot) return inspectInstall(gameRoot);
    if (saved?.game_root) {
        try { return await inspectInstall(saved.game_root); }
        catch (e) { if (e.message === 'GAME_UPDATE_IN_PROGRESS') throw e; }
    }
    const found = new Map();
    let lastError = null;
    for (const root of steamRoots) {
        try {
            const candidate = await discoverInstall(root);
            const checked = await inspectInstall(candidate.gameRoot);
            found.set(path.resolve(checked.gameRoot).toLowerCase(), checked);
        } catch (e) {
            // Never silently select one installation when another is ambiguous/updating.
            if (['AMBIGUOUS_GAME_INSTALL', 'GAME_UPDATE_IN_PROGRESS'].includes(e.message)) throw e;
            if (!['ENOENT', 'GAME_NOT_FOUND', 'STEAM_NOT_FOUND'].includes(e.code || e.message)) lastError = e;
        }
    }
    if (found.size > 1) fail('AMBIGUOUS_GAME_INSTALL');
    if (found.size === 1) return [...found.values()][0];
    if (lastError) throw lastError;
    fail('GAME_NOT_FOUND');
}

async function prepareInstallation({steamRoots = [], gameRoot = null, force = false,
    storeRoot = path.join(__dirname, '../user_data'), catalogRoot = DEFAULT_ROOT,
    extract = undefined} = {}) {
    if (!Array.isArray(steamRoots) || steamRoots.length > 16 ||
        steamRoots.some(p => typeof p !== 'string' || !path.isAbsolute(p)) ||
        typeof force !== 'boolean') fail('INVALID_INSTALL_REQUEST');
    const store = new SafeStore(storeRoot);
    await store.init();
    const saved = await store.read('installation.json');
    if (saved && (saved.schema !== 'infalsus-installation/v1' || typeof saved.game_root !== 'string'))
        fail('STORE_CORRUPT_KEEP_FILES');
    const install = await findInstall({steamRoots, gameRoot, saved});
    const active = await loadActive(catalogRoot);
    const needsUpdate = force || !saved || !samePath(saved.game_root, install.gameRoot) ||
        saved.build_id !== install.build_id || !active.source || active.source.build_id !== install.build_id;
    let result;
    if (needsUpdate) {
        result = await checkUpdate({install, storeRoot: catalogRoot, ...(extract ? {extract} : {})});
        // Check once more before remembering a location; never cache a partial Steam update.
        const after = await inspectInstall(install.gameRoot);
        if (after.build_id !== result.build_id) fail('GAME_FILES_CHANGING');
        await store.write('installation.json', {schema: 'infalsus-installation/v1',
            game_root: install.gameRoot, build_id: result.build_id}, {backup: true});
    } else {
        result = {schema: 'infalsus-catalog-check/v1', status: 'current',
            build_id: install.build_id, song_count: active.catalog.songs.length,
            chart_count: active.catalog.songs.length * 4, added_songs: 0, changed_charts: 0,
            message: '当前曲库已为最新！'};
    }
    return {...result, game_root: install.gameRoot};
}

if (require.main === module) (async () => {
    if (process.argv.length !== 2) fail('INVALID_INSTALL_REQUEST');
    let input = '';
    for await (const chunk of process.stdin) {
        input += chunk;
        if (Buffer.byteLength(input, 'utf8') > 32768) fail('INVALID_INSTALL_REQUEST');
    }
    const request = JSON.parse(input);
    if (!request || typeof request !== 'object' || Array.isArray(request) ||
        Object.keys(request).some(k => !['steamRoots', 'gameRoot', 'force'].includes(k))) fail('INVALID_INSTALL_REQUEST');
    console.log(JSON.stringify(await prepareInstallation(request)));
})().catch(e => {
    console.error(/^[A-Z][A-Z_0-9]{2,80}$/.test(e.message) ? e.message : 'INSTALL_DISCOVERY_IO_ERROR');
    process.exitCode = 1;
});
module.exports = {inspectInstall, findInstall, prepareInstallation};
