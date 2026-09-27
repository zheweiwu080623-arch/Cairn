@echo off
cd /d "%~dp0"
rem Start the background tray without a console window (no WScript dependency).
rem All Chinese output comes from tray.ps1, which is UTF-8 with BOM.
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0tray.ps1"
exit /b 0
