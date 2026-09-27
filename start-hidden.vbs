' Launch Codex Planner as a standalone desktop app (no browser tab).
' 1) keeps the background tray (watchdog) running  2) runs the Node server hidden  3) opens an Edge --app window.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
Dim proj
' 用脚本自身所在目录：换台机器 / 换个安装位置都不用改这里
proj = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = proj
' Background tray + watchdog. It exits by itself if the desktop shell (PlannerShell.exe) is already running,
' so this never produces a second tray icon.
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & proj & "\tray.ps1""", 0, False
' Start the server if needed and open the app window.
sh.Run "cmd /c node launcher.mjs", 0, False
