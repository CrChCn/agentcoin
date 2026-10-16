@echo off
rem === AGT node 9337: цепь в своём data-dir (масштабирование AGIP-9) ===
cd /d "%~dp0"
set AGT_DATA_DIR=%~dp0data-n4
"C:\Program Files\nodejs\node.exe" node.mjs 9337 >> log-node9337.txt 2>&1
