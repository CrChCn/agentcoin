@echo off
rem ============================================================
rem AGT: «нежубивые» ноды — задачи Windows schtasks
rem Стартуют при загрузке машины, watchdog перезапускает при сбое.
rem Запуск ОДИН РАЗ от АДМИНИСТРАТОРА (правый клик → Запуск от имени администратора):
rem   tools\nodes-autostart.cmd install    — установить рабочий состав (9335/9341/9342/9336+watchdog)
rem   tools\nodes-autostart.cmd verify     — сверить установленные задачи (безопасно, без изменений)
rem   tools\nodes-autostart.cmd uninstall  — убрать автозадачи
rem
rem Согласовано с runbook-ом восстановления (2026-10-17):
rem   · имена задач ТОП-уровня и совпадают с self-heal health-check'а (AGTNode9335 и пр.);
rem   · отключённые ноды 9337–9339 (AGIP-24) задачи НЕ создают;
rem   · легаси-дубликаты (AGTNodeA/B/C и папка AGTNode\*) удаляются: у AGTNodeA
rem     отсутствовал AGT_DATA_DIR — двойной процесс на одном каталоге = порча.
rem A-7 (аудит 2026-10-18): раньше после create/delete безусловно печаталось «Готово»
rem   и exit /b 0 — сбой schtasks (Access denied) оставался незамеченным. Теперь:
rem   · права администратора проверяются ДО изменений;
rem   · каждой ошибки nакапливаются, код возврата = число неудач;
rem   · неустранимый legacy-«Access denied» отличён от «задачи нет»;
rem   · после установки выполняется verify (сверка TaskName/TaskToRun/Пользователь).
rem ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0.."
set ERRORS=0
set CREATED=0

if /i "%1"=="verify" goto verify
if /i "%1"=="install" goto admincheck
if /i "%1"=="uninstall" goto admincheck
echo Usage: nodes-autostart.cmd install^|verify^|uninstall
exit /b 1

:admincheck
rem A-7: проверяем права ДО любых изменений (schtasks с /ru SYSTEM требует админа).
net session >nul 2>&1
if errorlevel 1 (
  echo [FAIL] Нет прав администратора: запрос "%1" не выполнен. Правый клик ^> Запуск от имени администратора.
  exit /b 1
)
if /i "%1"=="install" goto install
goto uninstall

:install
call :create "AGTNode9335" "%cd%\run-node.cmd"
call :create "AGTNode9341" "%cd%\run-node2.cmd"
call :create "AGTNode9342" "%cd%\run-node3.cmd"
call :create "AGTNodeTs"   "%cd%\run-node-ts.cmd"
call :create "AGTWatchdog" "%cd%\run-watchdog.cmd"
rem Легаси-дубликаты: удаляем тихо, «задачи не было» — не ошибка; «доступ запрещён» — ошибка.
call :deleteLegacy "AGTNodeA"
call :deleteLegacy "AGTNodeB"
call :deleteLegacy "AGTNodeC"
for %%a in (9335 9336 9337 9338 9339 9341 9342 watchdog) do call :deleteLegacy "AGTNode\%%a"
echo Установлено задач: !CREATED! из 5. Ошибок: !ERRORS!.

:verify
set VERIFYONLY=1
rem Сверка: задача существует, исполнитель и аргументы совпадают, владелец SYSTEM.
call :check "AGTNode9335" "run-node.cmd"
call :check "AGTNode9341" "run-node2.cmd"
call :check "AGTNode9342" "run-node3.cmd"
call :check "AGTNodeTs"   "run-node-ts.cmd"
call :check "AGTWatchdog" "run-watchdog.cmd"
rem A-7: второй владелец запуска (легаси-дубликат должен отсутствовать).
for %%a in ("AGTNodeA" "AGTNodeB" "AGTNodeC") do (
  schtasks /query /tn "%%~a" >nul 2>&1 && (
    echo [FAIL] Легаси-дубликат ещё жив: %%~a (второй владелец запуска — удалить)
    set /a ERRORS+=1
  )
)
if %ERRORS%==0 (
  echo [OK] Сверка автозапуска: 5/5 задач на месте, легаси-дубликатов нет.
  exit /b 0
) else (
  echo Сверка автозапуска: указано несовпадений: %ERRORS%.
  exit /b %ERRORS%
)

:create
schtasks /create /tn "%~1" /tr "\"%~2\"" /sc onstart /ru SYSTEM /rl HIGHEST /f >nul 2>&1
if errorlevel 1 (
  echo [FAIL] Не создана задача %~1 ^<- "%~2" (код %errorlevel%).
  set /a ERRORS+=1
) else (
  echo [OK] Задача %~1 создана.
  set /a CREATED+=1
)
goto :eof

:deleteLegacy
schtasks /delete /tn "%~1" /f >nul 2>&1
if errorlevel 1 (
  schtasks /query /tn "%~1" >nul 2>&1 && (
    rem задача ЕСТЬ и не удалилась → не «кода не было», а реальный отказ
    echo [FAIL] Легаси-задача %~1 существует и не удалилась (проверьте права).
    set /a ERRORS+=1
  )
  rem задача отсутствует → норма
)
goto :eof

:check
rem Локализация schtasks вариативна — сверяем через PowerShell (TaskName/Execute/Arguments).
rem Коды: 0 = ок; 2 = задача отсутствует; 3 = исполнитель не совпал; 1 = прочая ошибка.
powershell -NoProfile -Command "$t=Get-ScheduledTask -TaskName '%~1' -ErrorAction SilentlyContinue; if(-not $t){exit 2}; $a=($t.Actions|ForEach-Object{$_.Execute+' '+$_.Arguments}) -join ' '; if($a -notlike '*%~2*'){exit 3} exit 0" >nul 2>&1
set RC=%errorlevel%
if "%RC%"=="0" (
  echo [OK] Задача %~1: исполнитель "%~2".
) else if "%RC%"=="2" (
  echo [FAIL] Задача %~1 отсутствует ^(подъём ноды при загрузке не гарантирован^).
  set /a ERRORS+=1
) else if "%RC%"=="3" (
  echo [FAIL] Задача %~1: исполнитель не содержит "%~2".
  set /a ERRORS+=1
) else (
  echo [FAIL] Задача %~1: ошибка запроса ^(код %RC%^).
  set /a ERRORS+=1
)
goto :eof
