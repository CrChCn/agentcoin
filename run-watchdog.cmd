@echo off
setlocal
cd /d "%~dp0"
set "AGT_NODE_EXE="
where node.exe >nul 2>&1
if not errorlevel 1 set "AGT_NODE_EXE=node.exe"
if not defined AGT_NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "AGT_NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined AGT_NODE_EXE (
  echo [FAIL] Node.js not found in PATH or ProgramFiles.
  exit /b 2
)
"%AGT_NODE_EXE%" "%~dp0watchdog.mjs"  >> "%~dp0log-watchdog.txt" 2>&1
exit /b %errorlevel%
