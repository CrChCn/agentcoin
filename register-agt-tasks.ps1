# ============ Register AGTNode9335 + AGTAutoMiner (boot/logon + recovery, non-admin) ============
# По образцу agents/windows/register-heartbeat-task.ps1 (CyberGuardMoltbookHeartbeat):
#   - Execute: ПОЛНЫЙ путь к node.exe (планировщик не ищет в PATH как шелл);
#   - WorkingDirectory = папка проекта (data/*.json резолвятся рядом);
#   - AllowStartIfOnBatteries + DontStopIfGoingOnBatteries (ноутбук);
#   - StartWhenAvailable: проспал/выключен → запуск догоняет при пробуждении;
#   -Чтобы нода и майнер ВЫЖИВАЛИ после сна/перезагрузки: триггеры AtLogOn + AtStartup
#    плюс RepeatIndefinitely-репитер каждые 5 минут как watchdog (задача сама
#    поднимет мёртвый процесс; повторный запуск node.mjs привяжется к занятому
#    порту и тихо выйдет — дубликатов не будет).
#   - IgnoreNew + честный тайм-лимит: у ноды Unlimited (это сервис), у авто-майнера 10 мин.
# Без admin (RunLevel Limited), свой аккаунт.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$node = Join-Path $env:ProgramFiles 'nodejs\node.exe'
if (-not (Test-Path $node)) { throw "node.exe not found: $node" }
$proj = '<PROJECT_DIR>'
if (-not (Test-Path (Join-Path $proj 'node.mjs'))) { throw "node.mjs not found: $proj" }

function Register-AGTTask($name, $argStr, $limit) {
  $act = New-ScheduledTaskAction -Execute $node -Argument $argStr -WorkingDirectory $proj
  $trgLogon = New-ScheduledTaskTrigger -AtLogOn
  # AtStartup требует админ-права; логон после перезагрузки + 5-мин watchdog равнозначно покрывает
  # RepetitionDuration MaxValue невалидна в XML планировщика — берём 10 лет
  $trgKeep  = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
  $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit $limit -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $name -Action $act -Trigger $trgLogon,$trgKeep -Settings $set -RunLevel Limited -Force | Select-Object TaskName, State
}

Register-AGTTask 'AGTNode9335'  'node.mjs 9335' ([TimeSpan]::FromDays(365)) | Out-Null
# miner-адрес берётся из data/wallets.json первым ключом (treasury-майнер)
$miner = (Get-Content (Join-Path $proj 'data\wallets.json') -Raw | ConvertFrom-Json).PSObject.Properties | Select-Object -First 1 -ExpandProperty Name
Register-AGTTask 'AGTAutoMiner' ("auto-miner.mjs 9335 $miner 60") ([TimeSpan]::FromMinutes(10)) | Out-Null

Write-Host '--- verify ---'
foreach ($t in 'AGTNode9335','AGTAutoMiner') {
  if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
    $s = (Get-ScheduledTask -TaskName $t).Settings
    [PSCustomObject]@{
      Task = $t
      StartWhenAvailable = $s.StartWhenAvailable
      DisallowStartIfOnBatteries = $s.DisallowStartIfOnBatteries
      MultipleInstances = $s.MultipleInstances
    } | Format-List
  }
}
Write-Host '--- запуск AGTNode9335 сейчас (schtasks) ---'
Start-ScheduledTask -TaskName 'AGTNode9335'
Start-Sleep -Seconds 6
Get-ScheduledTaskInfo -TaskName 'AGTNode9335' -ErrorAction SilentlyContinue | Select-Object LastRunTime, LastTaskResult
