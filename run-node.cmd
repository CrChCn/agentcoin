@echo off
rem === AGT node 9335 task wrapper: лог в log-node.txt ===
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" node.mjs 9335 >> log-node.txt 2>&1
