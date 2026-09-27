@echo off
cd /d "%~dp0"
rem Turn on autostart: put a shortcut into the Windows Startup folder.
if /i "%~1"=="off" goto off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tray.ps1" -Action start
rem (Chinese output is printed by tray.ps1 / PowerShell, which handles encoding.)
timeout /t 8 >nul
exit /b 0

:off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tray.ps1" -Action stop
timeout /t 8 >nul
exit /b 0
