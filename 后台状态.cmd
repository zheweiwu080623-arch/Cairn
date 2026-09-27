@echo off
cd /d "%~dp0"
rem Show background status (all Chinese output comes from tray.ps1 -Action info).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tray.ps1" -Action info
pause
