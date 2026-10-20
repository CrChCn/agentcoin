@echo off
rem ============================================================
rem RESTART-TS-NODE — запускать НА VM с нодой 9336 (tailnet).
rem Останавливает точно тот процесс, который слушает 9336
rem (taskkill по конкретному PID, никогда по имени node.exe),
rem ждёт освобождения порта и поднимает run-node-ts.cmd
rem с проверкой начала прослушивания. Проверка не эмули erfolgreichen старт:
rem дальше ОБЯЗАТЕЛЬНО запустите tools\verify-node.mjs (runbook, шаг 5).
rem
rem Правильно используется состояние: run-node-ts.cmd в репо уже содержит
rem более неактуальный pin AGT_PASSPORT_ISSUER_FINGERPRINT (ef653a51...);
rem перед этим узловой каталог ДОЛЖЕН лежать в выписанной таблице check-out
rem версии repo (git pull к актуальному main).
setlocal enabledelayedexpansion
cd /d "%~dp0.."
set "PORT=9336"

rem --- 1. Текущий PID, слушающий порт (для журнала) ---
set "OLDPID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r "TCP.*:%PORT% .*LISTENING"') do if not defined OLDPID set "OLDPID=%%p"
echo [restart-ts] порт %PORT% текущий PID: !OLDPID!

rem --- 2. Точная остановка по PID ---
if defined OLDPID (
  taskkill /PID %OLDPID% /F
) else (
  echo [restart-ts] на порту %PORT%слухающий процесс не найден — стартуем свежим процессом.
)

rem --- 3. Ждать освобождение порта, максимум ~30с ---
set /a WAITED=0
:waitport
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r "TCP.*:%PORT% .*LISTENING"') do set "BUSY=%%p"
if defined BUSY (
  if %WAITED% geq 30 (
    echo [restart-ts] FAIL: порт %PORT% всё ещё занят PID !BUSY! после 30с.
    exit /b 2
  )
  timeout /t 2 /nobreak >nul
  set /a WAITED+=2
  set "BUSY="
  goto waitport
)
echo [restart-ts] порт %PORT% свободен.

rem --- 4. Старт штатной обёртки (новый процесс, свой stdout в лог) ---
start "" /min cmd /c "%~dp0..\run-node-ts.cmd"
echo [restart-ts] run-node-ts.cmd запущена, попытка подключения. Ждать прослушивания:
set /a WAITED=0
:waitup
rem Watson: curl может отсутствовать на VM — проверяем PowerShell' ом, он есть всегда.
powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:%PORT%/health' -TimeoutSec 4).StatusCode } catch { $rc_= 'no' ; if ($_.Exception.Response) { $_.Exception.Response.StatusCode.value__ } }" | findstr /r "^[0-9]" >nul
if errorlevel 1 (
  if %WAITED% geq 60 (
    echo [restart-ts] FAIL: нода не подняла порт за 60с — смотреть %~dp0..\log-node-ts.txt
    exit /b 3
  )
  timeout /t 3 /nobreak >nul
  set /a WAITED+=3
  goto waitup
)
echo [restart-ts] порт %PORT% слушает, процесс поднят.
echo [restart-ts] ДАЛЬШЕ обязательно: node tools\verify-node.mjs http://127.0.0.1:%PORT% ^| ssh см. runbook.
exit /b 0
