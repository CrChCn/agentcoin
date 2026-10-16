@echo off
rem === AGT node 9338: цепь в своём data-dir (масштабирование AGIP-9) ===
cd /d "%~dp0"
set AGT_DATA_DIR=%~dp0data-n5
"C:\Program Files\nodejs\node.exe" node.mjs 9338 >> log-node9338.txt 2>&1
