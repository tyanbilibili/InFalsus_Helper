'use strict';
// Copies the release-only files that cannot live inside resources/app:
// the editable default precise-constant table and the top-level docs.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'dist', 'InFalsusHelper-win32-x64');

const copies = [
  ['README.md', 'README.md'],
  ['启动.bat', '启动.bat'],
  ['VERSION.txt', 'VERSION.txt'],
  ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
  ['THIRD_PARTY_NOTICES_live.md', 'THIRD_PARTY_NOTICES_live.md'],
  // 默认精确定数表：放在 exe 同级的 data\ 下，方便直接查看和替换。
  ['app/data/precise-defaults.json', 'data/precise-defaults.json']
];

for (const [from, to] of copies) {
  const source = path.join(root, from);
  if (!fs.existsSync(source)) {
    console.warn('skip (missing):', from);
    continue;
  }
  const target = path.join(out, to);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  console.log('copied:', to);
}

// Electron ships ~49 MB of locale packs for languages this tool never renders.
// Keeping only Simplified Chinese and English saves ~47 MB with no behaviour change.
const KEEP_LOCALES = new Set(['zh-CN.pak', 'en-US.pak']);
const localesDir = path.join(out, 'locales');
if (fs.existsSync(localesDir)) {
  let removed = 0;
  let freed = 0;
  for (const entry of fs.readdirSync(localesDir)) {
    if (KEEP_LOCALES.has(entry)) continue;
    const target = path.join(localesDir, entry);
    freed += fs.statSync(target).size;
    fs.unlinkSync(target);
    removed += 1;
  }
  console.log(`locales: kept ${KEEP_LOCALES.size}, removed ${removed} (${(freed / 1048576).toFixed(1)} MB)`);
}
