'use strict';
// A directory preference only: native rendering/output is a separate responsibility.
const fs = require('node:fs/promises');
const path = require('node:path');
const { noLinks } = require('./store.cjs');
const FILE = 'export-settings.json';
const SCHEMA = 'infalsus-export-settings/v1';
const inside = (file, root) => file === root || file.startsWith(root + path.sep);

async function validateDirectory(value, storeRoot) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048 || !path.isAbsolute(value)) {
    throw new Error('EXPORT_DIRECTORY_REQUIRED');
  }
  const directory = path.resolve(value);
  if (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(directory)) {
    throw new Error('EXPORT_LOCAL_DIRECTORY_REQUIRED');
  }
  await noLinks(directory);
  if (!(await fs.stat(directory)).isDirectory()) throw new Error('EXPORT_DIRECTORY_UNAVAILABLE');
  const root = path.resolve(__dirname, '../..');
  const protectedRoots = [
    storeRoot, path.join(root, 'data'), path.join(root, 'sources'),
    path.join(root, 'InFalsus_Rating/user_data'), path.join(root, 'InFalsus_Rating/catalog_data'),
    path.join(root, 'InFalsus_Rating/assets'), path.join(root, 'InFalsus_Rating/live'),
  ].map(p => path.resolve(p).toLowerCase());
  if (protectedRoots.some(p => inside(directory.toLowerCase(), p))
      || /[\\/]LocalLow[\\/]lowiro[\\/]infalsus(?:[\\/]|$)/i.test(directory)) {
    throw new Error('EXPORT_PROTECTED_DIRECTORY');
  }
  for (let current = directory; ; current = path.dirname(current)) {
    for (const marker of ['infalsus.exe', 'infalsus_Data', 'savestate_V3.sav']) {
      try {
        await fs.lstat(path.join(current, marker));
        throw new Error('EXPORT_PROTECTED_DIRECTORY');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (current === path.dirname(current)) break;
  }
  return directory;
}

async function readSettings(store) {
  const value = await store.read(FILE, { schema: SCHEMA, directory: '' });
  if (value?.schema !== SCHEMA || typeof value.directory !== 'string') throw new Error('EXPORT_SETTINGS_INVALID');
  return value;
}

async function saveSettings(store, value) {
  const directory = await validateDirectory(value, store.root);
  const settings = { schema: SCHEMA, directory };
  await store.write(FILE, settings);
  return settings;
}

module.exports = { readSettings, saveSettings, validateDirectory };
