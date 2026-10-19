@echo off
setlocal
cd /d "%~dp0"
set "AGT_DATA_DIR=%~dp0data-node2"
set "AGT_BIND=127.0.0.1"
if not defined AGT_ADMIN_MODE set "AGT_ADMIN_MODE=local"
set "AGT_BOOTSTRAP_FILE=%~dp0data-agtx\bootstrap-local.json"
set "AGT_MONITOR_TARGETS_FILE=%~dp0data-agtx\monitor-targets.json"
set "AGT_IDENTITY_ROLE=replica"
set "AGT_TRUSTED_ISSUERS_FILE=%~dp0data-agtx\trusted-issuers.json"
set "AGT_PASSPORT_ISSUER_FINGERPRINT=sha256:91002b4db204851c42d8c75b04932902b03b59135e8a4310adfc5c7d4ca9f4a1"
set "AGT_IDENTITY_AUDIENCE=agentcoin-node:9341"
set "AGT_NODE_EXE="
where node.exe >nul 2>&1
if not errorlevel 1 set "AGT_NODE_EXE=node.exe"
if not defined AGT_NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "AGT_NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined AGT_NODE_EXE (
  echo [FAIL] Node.js not found in PATH or ProgramFiles.
  exit /b 2
)
rem node.mjs reads the ignored admin-token file itself; never echo secrets.
"%AGT_NODE_EXE%" "%~dp0node.mjs" 9341 >> "%~dp0log-node2.txt" 2>&1
exit /b %errorlevel%
