@echo off
cd /d "%~dp0"
rem 2026-09-26：一键"重启后台托盘"——结束记在 tray.pid 里的旧托盘，再拉起一个新的（图标会回到右下角）。
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tray.ps1" -Action restart
pause
