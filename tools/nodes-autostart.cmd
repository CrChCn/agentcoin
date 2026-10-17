@echo off
rem ============================================================
rem AGT: «нежубивые» ноды — задачи Windows schtasks
rem Стартуют при загрузке машины, watchdog перезапускает при сбое.
rem Запуск ОДИН РАЗ от АДМИНИСТРАТОРА (правый клик → Запуск от имени администратора):
rem   tools\nodes-autostart.cmd install    — установить рабочий состав (9335/9341/9342/9336+watchdog)
rem   tools\nodes-autostart.cmd uninstall  — убрать автозадачи
rem
rem Согласовано с runbook-ом восстановления (2026-10-17):
rem   · имена задач ТОП-уровня и совпадают с self-heal health-check'а (AGTNode9335 и пр.);
rem   · отключённые ноды 9337–9339 (AGIP-24) задачи НЕ создают;
rem   · легаси-дубликаты (AGTNodeA/B/C и папка AGTNode\*) удаляются: у AGTNodeA
rem     отсутствовал AGT_DATA_DIR — двойной процесс на одном каталоге = порча.
rem ============================================================
setlocal
cd /d "%~dp0.."

if /i "%1"=="install" goto install
if /i "%1"=="uninstall" goto uninstall
echo Usage: nodes-autostart.cmd install^|uninstall
exit /b 1

:install
schtasks /create /tn "AGTNode9335" /tr "\"%cd%\run-node.cmd\""     /sc onstart /ru SYSTEM /rl HIGHEST /f && echo [OK] 9335
schtasks /create /tn "AGTNode9341" /tr "\"%cd%\run-node2.cmd\""     /sc onstart /ru SYSTEM /rl HIGHEST /f && echo [OK] 9341
schtasks /create /tn "AGTNode9342" /tr "\"%cd%\run-node3.cmd\""     /sc onstart /ru SYSTEM /rl HIGHEST /f && echo [OK] 9342
schtasks /create /tn "AGTNodeTs"   /tr "\"%cd%\run-node-ts.cmd\""  /sc onstart /ru SYSTEM /rl HIGHEST /f && echo [OK] 9336 (tailscale)
schtasks /create /tn "AGTWatchdog" /tr "\"%cd%\run-watchdog.cmd\""  /sc onstart /ru SYSTEM /rl HIGHEST /f && echo [OK] watchdog
schtasks /delete /tn "AGTNodeA" /f >nul 2>&1
schtasks /delete /tn "AGTNodeB" /f >nul 2>&1
schtasks /delete /tn "AGTNodeC" /f >nul 2>&1
for %%a in (9335 9336 9337 9338 9339 9341 9342 watchdog) do schtasks /delete /tn "AGTNode\%%a" /f >nul 2>&1
echo Готово: ноды поднимутся сами при загрузке Windows; пока жив watchdog — падшие рестартятся.
exit /b 0

:uninstall
for %%a in (AGTNode9335 AGTNode9341 AGTNode9342 AGTNodeTs AGTWatchdog) do schtasks /delete /tn "%%a" /f >nul 2>&1 && echo [DEL] %%a
for %%a in (9335 9336 9337 9338 9339 9341 9342 watchdog) do schtasks /delete /tn "AGTNode\%%a" /f >nul 2>&1
exit /b 0
