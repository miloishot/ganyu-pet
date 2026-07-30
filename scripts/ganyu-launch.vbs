' Launch Ganyu detached and windowless.
'
' Run this via explorer.exe or a Startup shortcut, NOT from a terminal: a pet
' started as a child of a shell dies when that shell's process tree is torn
' down, which is the "she keeps disappearing" bug. Launching through Explorer
' reparents her, and window style 0 keeps the console hidden.
Option Explicit
Dim fso, sh, scriptDir, repoRoot, exe
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
repoRoot = fso.GetParentFolderName(scriptDir)
exe = fso.BuildPath(repoRoot, "node_modules\electron\dist\electron.exe")

If Not fso.FileExists(exe) Then
  MsgBox "Electron is not installed. Run 'npm install' in " & repoRoot, 48, "Ganyu"
  WScript.Quit 1
End If

sh.CurrentDirectory = repoRoot
sh.Run """" & exe & """ """ & repoRoot & """", 0, False
