' 无窗口启动 ps5watch 控制台服务，输出写入 state\server.log
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = root
sh.Run "cmd /c node --no-warnings=ExperimentalWarning server\index.mjs >> state\server.log 2>&1", 0, False
