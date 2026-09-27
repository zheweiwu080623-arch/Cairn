@echo off
rem 把当前改动提交进本地 git 仓库（安全：只 init/config/add/commit，不推送、不删文件）
rem 中文输出全部来自 scripts\local-commit.ps1（UTF-8 with BOM）
chcp 65001 >nul
cd /d "%~dp0"
set MSG=%*
if "%MSG%"=="" set MSG=Planner 本地提交
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\local-commit.ps1" -Message "%MSG%"
echo.
pause
