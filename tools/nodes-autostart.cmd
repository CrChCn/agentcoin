@echo off
rem ============================================================
rem AGT: «нежубивые» ноды — задачи Windows schtasks
rem Стартуют при загрузке машины, watchdog перезапускает при сбое.
rem Запуск ОДИН РАЗ от АДМИНИСТРАТОРА (правый клик → Запуск от имени администратора):
rem   tools\nodes-autostart.cmd install    — установить все 7 нод + watchdog
rem   tools\nodes-autostart.cmd uninstall  — убрать автозадачи
rem ============================================================
setlocal
cd /d "%~dp0.."

if /i "%1"=="install" goto install
if /i "%1"=="uninstall" goto uninstall
echo Usage: nodes-autostart.cmd install^|uninstall
exit /b 1

:install
schtasks /create /tn "AGTNode\9335"     /tr "\"%cd%\run-node.cmd\""      /sc onstart /ru SYSTEM /rl HIGHEST /f && echo [OK] 9335
schtasks /create /tn "AGTNode\9336"     /tr "\"%cd%\run-node-ts.cmd\""   /sc onstart /ru SYSTEM /rl HIGHEST /f && echo [OK] 9336 (tailscale)
schtasks /create /tn "AGTNode\9337"     /tr "\"%cd%\run-node9337.cmd\""  /sc onstart /ru SYSTEM /rl HIGHEST /f && echo [OK] 9337
schtasks /create /tn "AGTNode\9338"     /tr "\"%cd%\run-node9338.cmd\""  /sc onstart /ru SYSTEM /rl HIGHEST /f && echo [OK] 9338
schtasks /create /tn "AGTNode\9339"     /tr "\"%cd%\run-node9339.cmd\""  /sc onstart /ru SYSTEM /rl HIGHEST /f && echo [OK] 9339
schtasks /create /tn "AGTNode\9341"     /tr "\"%cd%\run-node2.cmd\""     /sc onstart /ru SYSTEM /rl HIGHEST /f && echo [OK] 9341
schtasks /create /tn "AGTNode\9342"     /tr "\"%cd%\run-node3.cmd\""     /sc onstart /ru SYSTEM /rl HIGHEST /f && echo [OK] 9342
schtasks /create /tn "AGTNode\watchdog" /tr "\"%cd%\run-watchdog.cmd\""  /sc onstart /ru SYSTEM /rl HIGHEST /f && echo [OK] watchdog
echo Готово: ноды поднимутся сами при загрузке Windows; пока жив watchdog — падшие рестартятся.
exit /b 0

:uninstall
for %%a in (9335 9336 9337 9338 9339 9341 9342 watchdog) do schtasks /delete /tn "AGTNode\%%a" /f >nul 2>&1 && echo [DEL] %%a
exit /b 0
