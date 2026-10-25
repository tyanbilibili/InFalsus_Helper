@echo off
cd /d "%~dp0"
if exist "node_modules\electron\dist\electron.exe" (
  start "" "node_modules\electron\dist\electron.exe" "%~dp0"
) else if exist "InFalsus Helper.exe" (
  start "" "%~dp0InFalsus Helper.exe"
) else if exist "InFalsusHelper.exe" (
  start "" "%~dp0InFalsusHelper.exe"
) else (
  echo 未找到 Electron 运行环境，请先执行 npm install。
  pause
)
