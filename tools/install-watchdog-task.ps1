# Установка задачи автозапуска watchdog'а AGT (user-level, без админа).
# Повторяет состав tools/nodes-autostart.cmd install, но только для AGTWatchdog
# и без /ru SYSTEM: все существующие AGT-задачи ходят от пользователя Mark,
# поэтому SYSTEM-podjём здесь не нужен и не требовал бы UAC.
$ErrorActionPreference = 'Stop'
$root = 'C:\Users\Mark\Desktop\agentcoin'
$action = New-ScheduledTaskAction -Execute 'wscript.exe' `
  -Argument ('"' + $root + '\run-hidden.vbs" "cmd.exe" /c "' + $root + '\run-watchdog.cmd"') `
  -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogon -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName 'AGTWatchdog' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
$t = Get-ScheduledTask -TaskName 'AGTWatchdog'
Write-Output ('OK: ' + $t.TaskName + ' state=' + $t.State)
Write-Output ('action: ' + (($t.Actions | ForEach-Object { $_.Execute + ' ' + $_.Arguments }) -join ' '))
Write-Output ('trigger: logon for ' + $trigger.UserId)
