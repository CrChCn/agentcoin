@echo off
rem === AGT node 9339: цепь в своём data-dir (масштабирование AGIP-9) ===
cd /d "%~dp0"
set AGT_DATA_DIR=%~dp0data-n6
"C:\Program Files\nodejs\node.exe" node.mjs 9339 >> log-node9339.txt 2>&1
