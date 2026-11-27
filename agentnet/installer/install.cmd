@echo off
setlocal enableextensions
cd /d "%~dp0"
net session >nul 2>&1
if %errorlevel% equ 0 goto elevated
echo Requesting administrator rights...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~dp0install.ps1' -Verb RunAs -ArgumentList @('-Source','%~dp0')"
exit /b 0
:elevated
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Source "%~dp0"
set "RC=%ERRORLEVEL%"
echo.
echo Installer exit code: %RC%
timeout /t 10 >nul
exit /b %RC%
