@echo off
setlocal
cd /d "%~dp0"
set "AGT_DATA_DIR=%~dp0data-node3"
set "AGT_BIND=127.0.0.1"
if not defined AGT_ADMIN_MODE set "AGT_ADMIN_MODE=local"
set "AGT_NODE_EXE="
where node.exe >nul 2>&1
if not errorlevel 1 set "AGT_NODE_EXE=node.exe"
if not defined AGT_NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "AGT_NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined AGT_NODE_EXE (
  echo [FAIL] Node.js not found in PATH or ProgramFiles.
  exit /b 2
)
rem node.mjs reads the ignored admin-token file itself; never echo secrets.
"%AGT_NODE_EXE%" "%~dp0node.mjs" 9342 >> "%~dp0log-node3.txt" 2>&1
exit /b %errorlevel%
