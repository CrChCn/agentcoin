@echo off
rem === AGTHealthCheck task wrapper: одно-прогонный контроль здоровья ===
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" health-check.mjs 9335 >> log-healthcheck.txt 2>&1
