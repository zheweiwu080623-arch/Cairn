' Start Codex Planner tray (background, hidden console).
' Double-click this file, or put a shortcut to it in shell:startup for auto-start.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
' 用脚本自身所在目录：换台机器 / 换个安装位置都不用改这里
proj = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = proj
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & proj & "\tray.ps1""", 0, False
