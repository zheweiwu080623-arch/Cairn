@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装 Node.js 22 或更高版本。
  pause
  exit /b 1
)
echo 启动 Codex Planner 桌面端...
rem 顺便把后台托盘（看门狗）拉起来：窗口关掉后服务仍受保护，掉线会自动重启
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0tray.ps1"
set OPEN_BROWSER=1
node launcher.mjs
pause
