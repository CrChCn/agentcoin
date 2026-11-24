@echo off
rem Pillar Agentcoin: нода + встроенный майнинг. Как у Bitcoin: держишь ноду — майнишь.
rem   start-pillar.cmd                                        — столп по умолчанию (0.0.0.0:9335)
rem   start-pillar.cmd --port 9335 --public http://ТВОЙ-IP:9335
setlocal enableextensions
cd /d "%~dp0\..\.." 2>nul
if not exist "node.mjs" cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 ( echo [FAIL] нужен Node 20+ в PATH & pause & exit /b 66 )
if not exist "data-pillar" mkdir "data-pillar" >nul
echo == PILLAR: нода + майнинг | порт по умолчанию 9335
echo == Данные: data-pillar ^| Админ-токен: data-pillar\pillar-admin-token.txt
echo == Остановка: Ctrl+C
echo.
node "packaging\pillar\pillar.mjs" %*
pause
