@echo off
setlocal
cd /d "%~dp0"
set "AGT_DATA_DIR=%~dp0data-node-ts"
set "AGT_ADMIN_MODE=token"
if not defined AGT_TS_BIND if exist "%~dp0data-agtx\ts-bind.txt" set /p "AGT_TS_BIND="<"%~dp0data-agtx\ts-bind.txt"
if not defined AGT_TS_BIND (
  echo [FAIL] Set AGT_TS_BIND or data-agtx\ts-bind.txt to this machine's tailnet IP.
  exit /b 2
)
set "AGT_NODE_EXE="
where node.exe >nul 2>&1
if not errorlevel 1 set "AGT_NODE_EXE=node.exe"
if not defined AGT_NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "AGT_NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined AGT_NODE_EXE (
  echo [FAIL] Node.js not found in PATH or ProgramFiles.
  exit /b 2
)
rem Validate from the environment, without interpolating configuration into JS.
"%AGT_NODE_EXE%" -e "const net=require('node:net');const ip=(process.env.AGT_TS_BIND||'').trim();if(!net.isIP(ip)||ip==='0.0.0.0'||ip==='::')process.exit(2)"
if errorlevel 1 (
  echo [FAIL] AGT_TS_BIND must be a specific valid IP address, never a wildcard.
  exit /b 2
)
set "AGT_BIND=%AGT_TS_BIND%"
set "AGT_BOOTSTRAP_FILE=%~dp0data-agtx\bootstrap-local.json"
set "AGT_MONITOR_TARGETS_FILE=%~dp0data-agtx\monitor-targets.json"
set "AGT_IDENTITY_ROLE=replica"
set "AGT_TRUSTED_ISSUERS_FILE=%~dp0data-agtx\trusted-issuers.json"
set "AGT_PASSPORT_ISSUER_FINGERPRINT=sha256:91002b4db204851c42d8c75b04932902b03b59135e8a4310adfc5c7d4ca9f4a1"
set "AGT_IDENTITY_AUDIENCE=agentcoin-node:9336"
rem node.mjs reads the ignored admin-token file itself; missing token stays locked.
"%AGT_NODE_EXE%" "%~dp0node.mjs" 9336 >> "%~dp0log-node-ts.txt" 2>&1
exit /b %errorlevel%
