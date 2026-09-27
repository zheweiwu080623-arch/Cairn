@echo off
setlocal
cd /d "%~dp0"

set CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe
set SDK=%~dp0sdk
set OUT=%~dp0dist

if not exist "%CSC%" (
  echo [ERROR] compiler not found: %CSC%
  exit /b 1
)
if not exist "%SDK%\Microsoft.Web.WebView2.WinForms.dll" (
  echo [ERROR] WebView2 SDK missing in %SDK%
  exit /b 1
)
if not exist "%OUT%" mkdir "%OUT%"

echo Building PlannerShell.exe ...
"%CSC%" /nologo /target:winexe /platform:x64 /optimize+ /out:"%OUT%\PlannerShell.exe" /r:"%SDK%\Microsoft.Web.WebView2.Core.dll" /r:"%SDK%\Microsoft.Web.WebView2.WinForms.dll" /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll PlannerShell.cs
if errorlevel 1 (
  echo [FAILED] compilation error
  exit /b 1
)

copy /y "%SDK%\Microsoft.Web.WebView2.Core.dll" "%OUT%\" >nul
copy /y "%SDK%\Microsoft.Web.WebView2.WinForms.dll" "%OUT%\" >nul
copy /y "%SDK%\WebView2Loader.dll" "%OUT%\" >nul
if exist "%~dp0app.ico" copy /y "%~dp0app.ico" "%OUT%\" >nul

echo BUILD OK - output in %OUT%
dir /b "%OUT%"
endlocal
