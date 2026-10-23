'use strict';
// Shared resource I/O only. This module has no catalog extraction or save parsing dependency.
const fs = require('node:fs/promises');
const {noLinks} = require('./store.cjs');

async function readFile(file, limit) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('INVALID_RESOURCE_LIMIT');
  await noLinks(file);
  const handle = await fs.open(file, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit || before.nlink > 1) {
      throw new Error('INVALID_LOCAL_RESOURCE');
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const {bytesRead} = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error('GAME_FILES_CHANGING');
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('GAME_FILES_CHANGING');
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

module.exports = {readFile};
