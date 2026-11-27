# Agentcoin Core uninstaller: останавливает и удаляет службы, правила firewall,
# ярлыки и файлы программы. Данные ноды (цепь, ключ, пиры) сохраняются,
# если не указан -Purge.
[CmdletBinding()]
param(
  [switch]$Purge,
  [switch]$KeepFiles
)

$ErrorActionPreference = 'Continue'
$Target   = Join-Path $env:ProgramFiles 'AgentcoinCore'
$DataRoot = Join-Path $env:ProgramData 'AgentcoinCore'
$LogFile  = Join-Path $DataRoot 'uninstall.log'

function Log([string]$message) {
  $line = '{0} {1}' -f (Get-Date).ToUniversalTime().ToString('o'), $message
  Write-Host $message
  try { Add-Content -Path $LogFile -Value $line -Encoding UTF8 } catch { }
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host 'Requesting administrator rights...'
  Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath,
    $(if ($Purge) { '-Purge' } else { '-KeepFiles' })
  )
  exit 0
}

foreach ($name in @('AgentcoinGuard', 'AgentcoinNode')) {
  $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
  if ($svc) {
    if ($svc.Status -ne 'Stopped') { Stop-Service -Name $name -Force -ErrorAction SilentlyContinue }
    & sc.exe delete $name | Out-Null
    Log "service removed: $name"
  }
}

foreach ($rule in @('Agentcoin P2P 19444 (TCP)', 'Agentcoin LAN discovery 9337 (UDP)', 'Agentcoin P2P 9336 (TCP)')) {
  Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction SilentlyContinue
  Log "firewall rule removed: $rule"
}

$menu = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Agentcoin'
if (Test-Path $menu) { Remove-Item -Recurse -Force $menu; Log 'shortcuts removed' }

if (-not $KeepFiles -and (Test-Path $Target)) {
  Remove-Item -Recurse -Force $Target
  Log "program files removed: $Target"
}

if ($Purge -and (Test-Path $DataRoot)) {
  Remove-Item -Recurse -Force $DataRoot
  Log "data removed: $DataRoot"
} else {
  Log "node data kept in $DataRoot (use -Purge to delete it)"
}

Write-Host 'Agentcoin Core uninstalled.'
timeout /t 6 >nul
