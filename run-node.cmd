@echo off
setlocal
cd /d "%~dp0"
set "AGT_DATA_DIR=%~dp0data"
set "AGT_BIND=127.0.0.1"
if not defined AGT_ADMIN_MODE set "AGT_ADMIN_MODE=local"
set "AGT_BOOTSTRAP_FILE=%~dp0data-agtx\bootstrap-local.json"
set "AGT_MONITOR_TARGETS_FILE=%~dp0data-agtx\monitor-targets.json"
set "AGT_IDENTITY_ROLE=issuer"
rem SITE-ACTIVATE (issue 6298050853): serve verified checkout site for ALL pages
rem instead of stale owner-approved cache; release.json on disk is bytes-verified by build-site-release --check.
set "AGT_SITE_SYNC=0"
set "AGT_NODE_EXE="
where node.exe >nul 2>&1
if not errorlevel 1 set "AGT_NODE_EXE=node.exe"
if not defined AGT_NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "AGT_NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined AGT_NODE_EXE (
  echo [FAIL] Node.js not found in PATH or ProgramFiles.
  exit /b 2
)
"%AGT_NODE_EXE%" "%~dp0node.mjs" 9335 >> "%~dp0log-node.txt" 2>&1
exit /b %errorlevel%
