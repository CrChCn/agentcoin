@echo off
rem Pillar Agentcoin: node + built-in mining. Who holds a node, mines.
rem   start-pillar.cmd                                         - copy behind NAT (default port), mines to own wallet
rem   start-pillar.cmd 9340 --public http://YOUR-IP:9340      - real pillar (needs port forward + white IP)
setlocal enableextensions
cd /d "%~dp0"

set "PORT=%~1"
if "%PORT%"=="" set "PORT=@PORT@"

if not exist "node.exe" goto no_node
if not exist "pillar\pillar.mjs" goto no_pillar
if not exist "app\node.mjs" goto no_app

echo == PILLAR: node + mining ^| port %PORT% ^| seed @SEED@
echo == data: %CD%\data-pillar ^| stop: Ctrl+C or close this window
echo.
"node.exe" "pillar\pillar.mjs" --port %PORT% --bind 127.0.0.1 %2 %3 %4 %5 %6 %7 %8 %9
set "RC=%ERRORLEVEL%"
echo.
echo == pillar stopped (exit %RC%)
pause
exit /b %RC%

:no_node
echo [FAIL] node.exe is missing next to start-pillar.cmd
pause
exit /b 66

:no_pillar
echo [FAIL] pillar\pillar.mjs is missing - the bundle is incomplete
pause
exit /b 66

:no_app
echo [FAIL] app\node.mjs is missing - the bundle is incomplete
pause
exit /b 66
