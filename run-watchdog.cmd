@echo off
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" watchdog.mjs >> log-watchdog.txt 2>&1
