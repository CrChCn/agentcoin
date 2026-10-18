param([string]$PeerUrl=$env:AGENTCOIN_PEER_URL,[switch]$ClientOnly,[switch]$NonInteractive)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Remove-Item Env:NODE_OPTIONS,Env:NODE_PATH -ErrorAction SilentlyContinue
Get-ChildItem Env: | Where-Object { $_.Name -like 'AGT_*' } | ForEach-Object { Remove-Item ('Env:'+$_.Name) }
if (-not $PeerUrl) { throw 'Supply the selected node HTTPS origin as -PeerUrl.' }
$Base=if($env:AGENTCOIN_BASE){$env:AGENTCOIN_BASE}else{Join-Path $env:USERPROFILE '.agentcoin'}
if(-not [IO.Path]::IsPathRooted($Base)){throw 'AGENTCOIN_BASE must be absolute.'}
if((Test-Path $Base) -and ((Get-Item $Base).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Refusing a reparse-point install directory.'}
New-Item -ItemType Directory -Force -Path $Base | Out-Null
# Protect only the new application directory; do not alter system policy or the user's profile ACL.
$Sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $Base /inheritance:r /grant:r "*${Sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
if($LASTEXITCODE -ne 0){throw 'Could not restrict installation directory ACL.'}
$Programs=Join-Path $Base 'programs'
New-Item -ItemType Directory -Force -Path $Programs | Out-Null
$Stage=Join-Path $Programs ('.download-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Stage | Out-Null
try {
  $Ref=$env:AGENTCOIN_SOURCE_REF
  if(-not $Ref){$Ref=(Invoke-RestMethod -Uri 'https://api.github.com/repos/CrChCn/agentcoin/git/ref/heads/main' -Headers @{'User-Agent'='AgentcoinInstaller'} -TimeoutSec 30).object.sha}
  if($Ref -notmatch '^[a-f0-9]{40}$'){throw 'Expected the full approved source commit.'}
  $Release=Join-Path $Programs $Ref
  if(-not (Test-Path $Release)){
    $Zip=Join-Path $Stage 'source.zip'
    Invoke-WebRequest -UseBasicParsing -Uri "https://codeload.github.com/CrChCn/agentcoin/zip/$Ref" -OutFile $Zip -TimeoutSec 180
    Expand-Archive -LiteralPath $Zip -DestinationPath $Stage
    $Tree=Join-Path $Stage "agentcoin-$Ref"
    if(-not(Test-Path (Join-Path $Tree 'tools/easy-install.mjs'))){throw 'This approved release has no easy installer.'}
    Move-Item -LiteralPath $Tree -Destination $Release
  }
  if((Get-Item $Release).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Invalid source directory.'}
  $Node=$null
  $Installed=Get-Command node.exe -ErrorAction SilentlyContinue
  if($Installed){& $Installed.Source -e 'process.exit(parseInt(process.versions.node,10)>=24?0:1)' 2>$null; if($LASTEXITCODE -eq 0){$Node=$Installed.Source}}
  if(-not $Node){
    $Cpu=if($env:PROCESSOR_ARCHITEW6432){$env:PROCESSOR_ARCHITEW6432}else{$env:PROCESSOR_ARCHITECTURE}
    $Arch=switch($Cpu){'AMD64' {'x64'}; 'ARM64' {'arm64'}; default {throw 'Install Node.js 24+ manually for this CPU.'}}
    $Runtime=Get-Content -LiteralPath (Join-Path $Release 'install/runtime.json') -Raw | ConvertFrom-Json
    if($Runtime.version -notmatch '^v24\.[0-9]+\.[0-9]+$' -or $Runtime.origin -ne 'https://nodejs.org/dist'){throw 'Invalid runtime release.'}
    $Entry=$Runtime.files.PSObject.Properties["win-$Arch"].Value
    if($Entry.sha256 -notmatch '^[a-f0-9]{64}$' -or $Entry.file -ne "node-$($Runtime.version)-win-$Arch.zip"){throw 'Invalid runtime checksum metadata.'}
    $Zip=Join-Path $Stage 'node.zip'
    Invoke-WebRequest -UseBasicParsing -Uri "$($Runtime.origin)/$($Runtime.version)/$($Entry.file)" -OutFile $Zip -TimeoutSec 180
    if((Get-FileHash -LiteralPath $Zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Entry.sha256){throw 'Node.js checksum mismatch; nothing executed.'}
    $Runtimes=Join-Path $Base 'runtimes';New-Item -ItemType Directory -Force -Path $Runtimes | Out-Null
    $RuntimeDir=Join-Path $Runtimes "node-$($Runtime.version)-win-$Arch"
    if(-not(Test-Path $RuntimeDir)){Expand-Archive -LiteralPath $Zip -DestinationPath $Stage;Move-Item -LiteralPath (Join-Path $Stage "node-$($Runtime.version)-win-$Arch") -Destination $RuntimeDir}
    $Node=Join-Path $RuntimeDir 'node.exe'
  }
  $env:AGENTCOIN_SOURCE_REF=$Ref
  if(-not $env:AGENTCOIN_INSTALL_ROOT){$env:AGENTCOIN_INSTALL_ROOT=Join-Path $Base 'agent'}
  $Arguments=@((Join-Path $Release 'tools/easy-install.mjs'),'install','--peer-url',$PeerUrl)
  if($ClientOnly){$Arguments+='--client-only'}
  if($NonInteractive){$Arguments+='--non-interactive'}
  & $Node @Arguments
  if($LASTEXITCODE -ne 0){throw "Agentcoin setup failed (exit $LASTEXITCODE); existing keys were preserved."}
} finally {Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue}
