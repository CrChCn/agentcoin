Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match 'network-guard\.mjs' -and $_.ProcessId -ne (Get-Content (Join-Path (Get-Location) 'data-agtx\guard.lock') -ErrorAction SilentlyContinue) } |
  ForEach-Object {
    Write-Output ("убить дубликат guard PID {0}" -f $_.ProcessId)
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
Start-Sleep -Seconds 2
$n = (Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'network-guard\.mjs' } | Measure-Object).Count
Write-Output ("осталось guard-процессов: {0}" -f $n)
