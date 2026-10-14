' run-hidden.vbs — запускает переданную команду ПОЛНОСТЬЮ скрыто (windowstyle = 0).
' Используется задачами планировщика AGT (wscript.exe run-hidden.vbs <execute> <args...>),
' чтобы cmd-обёртки нод/майнеров не выбрасывали окна консоли в сеанс пользователя.
Option Explicit
Dim shell, cmdline, i
Set shell = CreateObject("WScript.Shell")
cmdline = ""
For i = 0 To WScript.Arguments.Count - 1
  If i > 0 Then cmdline = cmdline & " "
  cmdline = cmdline & Chr(34) & WScript.Arguments(i) & Chr(34)
Next
shell.Run cmdline, 0, False
