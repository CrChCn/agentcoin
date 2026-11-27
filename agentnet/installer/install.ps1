# Agentcoin Core installer — устанавливает две службы, GUI-ярлык и правила firewall.
# Запускается из установщика (setup.exe) уже с правами администратора.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [int]$P2PPort = 19444,
  [int]$ApiPort = 9333,
  [int]$GatewayPort = 9334,
  [switch]$NoFirewall
)

$ErrorActionPreference = 'Stop'
$Version     = '0.2.0'
$Target      = Join-Path $env:ProgramFiles 'AgentcoinCore'
$DataRoot    = Join-Path $env:ProgramData 'AgentcoinCore'
$Data        = Join-Path $DataRoot 'data'
$LogFile     = Join-Path $DataRoot 'install.log'
$Stage       = Join-Path $DataRoot 'staging'

function Log([string]$message) {
  $line = '{0} {1}' -f (Get-Date).ToUniversalTime().ToString('o'), $message
  Write-Host $message
  try { Add-Content -Path $LogFile -Value $line -Encoding UTF8 } catch { }
}

New-Item -ItemType Directory -Force -Path $DataRoot | Out-Null
Log "Agentcoin Core $Version installer: source=$Source target=$Target api=$ApiPort p2p=$P2PPort"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'The installer must run as administrator.'
}

# --- 1. распаковка payload ---------------------------------------------------
if (Test-Path $Stage) { Remove-Item -Recurse -Force $Stage }
New-Item -ItemType Directory -Force -Path $Stage | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory((Join-Path $Source 'payload.zip'), $Stage)
Log 'payload extracted'

# --- 2. остановка прошлой установки -----------------------------------------
foreach ($name in @('AgentcoinGuard', 'AgentcoinNode')) {
  $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
  if ($svc -and $svc.Status -ne 'Stopped') {
    Log "stopping existing service $name"
    Stop-Service -Name $name -Force -ErrorAction SilentlyContinue
  }
}

# --- 3. файлы ----------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $Target | Out-Null
Copy-Item -Path (Join-Path $Stage '*') -Destination $Target -Recurse -Force
New-Item -ItemType Directory -Force -Path $Data | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Data 'logs') | Out-Null

$peersFile = Join-Path $Data 'peers.txt'
if (-not (Test-Path $peersFile)) {
  $seedPeers = Join-Path $Target 'peers.txt'
  if (Test-Path $seedPeers) { Copy-Item $seedPeers $peersFile -Force }
}
Log "files installed to $Target"

$NodeExe    = Join-Path $Target 'node.exe'
$HostExe    = Join-Path $Target 'AgentcoinServiceHost.exe'
$Launcher   = Join-Path $Target 'app\launcher.mjs'
$GuardJs    = Join-Path $Target 'app\guard.mjs'
foreach ($f in @($NodeExe, $HostExe, $Launcher, $GuardJs)) {
  if (-not (Test-Path $f)) { throw "installer payload incomplete: $f" }
}

# --- 4. службы ---------------------------------------------------------------
# binPath — одна строка: хост-служба запускает node.exe с аргументами ноды.
$nodeChild = '"{0}" "{1}" --service --data="{2}" --p2p={3} --api={4} --api-host=127.0.0.1 --gateway-port={5} --gateway-host=127.0.0.1 --listen=0.0.0.0' -f `
  $NodeExe, $Launcher, $Data, $P2PPort, $ApiPort, $GatewayPort
$nodeBin = '"{0}" --name AgentcoinNode --log "{1}" --cwd "{2}" -- {3}' -f `
  $HostExe, (Join-Path $Data 'logs\node-service.log'), $Target, $nodeChild

  $guardChild = '"{0}" "{1}" --service=AgentcoinNode --api-host=127.0.0.1 --api={2} --interval=15 --fail=3 --log-file="{3}"' -f `
  $NodeExe, $GuardJs, $ApiPort, (Join-Path $Data 'logs\guard.log')
$guardBin = '"{0}" --name AgentcoinGuard --log "{1}" --cwd "{2}" -- {3}' -f `
  $HostExe, (Join-Path $Data 'logs\guard-service.log'), $Target, $guardChild

foreach ($name in @('AgentcoinGuard', 'AgentcoinNode')) {
  if (Get-Service -Name $name -ErrorAction SilentlyContinue) {
    Log "removing previous service $name"
    & sc.exe delete $name | Out-Null
    Start-Sleep -Milliseconds 1200
  }
}

New-Service -Name 'AgentcoinNode' -BinaryPathName $nodeBin -DisplayName 'Agentcoin Node' `
  -Description 'Agentcoin P2P node (agentnet): public P2P on 19444, local GUI on 127.0.0.1:9333' `
  -StartupType Automatic | Out-Null
New-Service -Name 'AgentcoinGuard' -BinaryPathName $guardBin -DisplayName 'Agentcoin Guard' `
  -Description 'Restarts Agentcoin Node if it stops answering on 127.0.0.1:9333' `
  -StartupType Automatic | Out-Null

& sc.exe failure AgentcoinNode reset= 86400 actions= restart/5000/restart/15000/restart/60000 | Out-Null
& sc.exe failure AgentcoinGuard reset= 86400 actions= restart/5000/restart/15000/restart/60000 | Out-Null
Log 'services created'

# --- 5. firewall -------------------------------------------------------------
if (-not $NoFirewall) {
  foreach ($rule in @(
      @{ Name = "Agentcoin P2P $P2PPort (TCP)"; Proto = 'TCP'; Port = $P2PPort },
      @{ Name = 'Agentcoin LAN discovery 9337 (UDP)'; Proto = 'UDP'; Port = 9337 }
    )) {
    Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue |
      Remove-NetFirewallRule -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName $rule.Name -Direction Inbound -Action Allow `
      -Protocol $rule.Proto -LocalPort $rule.Port -Profile Any -Program $NodeExe | Out-Null
    Log "firewall allow $($rule.Proto)/$($rule.Port)"
  }
}

# --- 6. запуск и проверка ----------------------------------------------------
Start-Service -Name 'AgentcoinNode'
Start-Service -Name 'AgentcoinGuard'
Log 'services started'

$ready = $false
$deadline = (Get-Date).AddSeconds(150)
while ((Get-Date) -lt $deadline) {
  try {
    $info = Invoke-RestMethod -Uri "http://127.0.0.1:$ApiPort/info" -TimeoutSec 3
    if ($info.state -eq 'running') { $ready = $true; break }
  } catch { Start-Sleep -Seconds 2 }
}
Log "local API ready: $ready"

# --- 7. ярлыки ---------------------------------------------------------------
$menu = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Agentcoin'
New-Item -ItemType Directory -Force -Path $menu | Out-Null
$guiUrl = Join-Path $menu 'Agentcoin GUI.url'
"[InternetShortcut]`r`nURL=http://127.0.0.1:$ApiPort/gui`r`nIconFile=$NodeExe`r`nIconIndex=0`r`n" |
  Set-Content -Path $guiUrl -Encoding ASCII

$uninstallCmd = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{0}"' -f (Join-Path $Target 'uninstall.ps1')
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut((Join-Path $menu 'Uninstall Agentcoin Core.lnk'))
$lnk.TargetPath = 'powershell.exe'
$lnk.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f (Join-Path $Target 'uninstall.ps1')
$lnk.WorkingDirectory = $Target
$lnk.Save()
Log 'start menu shortcuts created'

# --- 8. отчёт ----------------------------------------------------------------
$status = @{}
foreach ($name in @('AgentcoinNode', 'AgentcoinGuard')) {
  $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
  $status[$name] = if ($svc) { $svc.Status.ToString() } else { 'missing' }
}
$report = [ordered]@{
  product     = 'Agentcoin Core'
  version     = $Version
  installedAt = (Get-Date).ToUniversalTime().ToString('o')
  target      = $Target
  data        = $Data
  api         = "http://127.0.0.1:$ApiPort"
  gui         = "http://127.0.0.1:$ApiPort/gui"
  p2p         = "0.0.0.0:$P2PPort + [::]:$P2PPort"
  services    = $status
  apiReady    = $ready
}
$report | ConvertTo-Json | Set-Content -Path (Join-Path $DataRoot 'install.json') -Encoding UTF8

Write-Host ''
Write-Host 'Agentcoin Core installed.'
Write-Host ("  GUI:      http://127.0.0.1:{0}/gui" -f $ApiPort)
Write-Host ("  P2P:      0.0.0.0:{0} and [::]:{0}" -f $P2PPort)
Write-Host ("  services: AgentcoinNode={0}  AgentcoinGuard={1}" -f $status['AgentcoinNode'], $status['AgentcoinGuard'])
Write-Host ("  data:     {0}" -f $Data)
Write-Host '  inbound peers need TCP 19444 forwarded on the router (or UPnP/NAT-PMP).'
