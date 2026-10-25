'use strict';
// 打包前保护：如果发行目录里的默认精确定数表比源码那份更新（说明是手工改过的），
// 先同步回 app/data，避免被 electron-packager --overwrite 覆盖掉。
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'app', 'data', 'precise-defaults.json');
const shipped = path.join(root, 'dist', 'InFalsusHelper-win32-x64', 'data', 'precise-defaults.json');

if (!fs.existsSync(shipped) || !fs.existsSync(source)) {
  console.log('默认精确定数表：无需同步');
  process.exit(0);
}

const sourceText = fs.readFileSync(source, 'utf8');
const shippedText = fs.readFileSync(shipped, 'utf8');
const count = text => Object.keys(JSON.parse(text).values || {}).length;

// 内容一致就不动；内容不同且发行目录那份更新，才判定为手工改动。
if (sourceText !== shippedText && fs.statSync(shipped).mtimeMs > fs.statSync(source).mtimeMs) {
  fs.copyFileSync(shipped, source, fs.constants.COPYFILE_FICLONE);
  console.log(`默认精确定数表：发行目录那份更新（${count(shippedText)} 项），已同步回 app/data 防止丢失`);
} else if (sourceText !== shippedText) {
  console.log(`默认精确定数表：两份内容不同，以源码版为准（${count(sourceText)} 项）`);
} else {
  console.log(`默认精确定数表：已一致（${count(sourceText)} 项）`);
}
