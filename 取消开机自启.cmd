@echo off
cd /d "%~dp0"
rem Turn off autostart (remove the Startup shortcut).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tray.ps1" -Action stop
timeout /t 8 >nul
exit /b 0
