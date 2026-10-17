@echo off
rem === AGT node 9346: цепь в своём data-dir (масштабирование AGIP-9, свежая нода J — распределение нагрузки) ===
cd /d "%~dp0"
set AGT_DATA_DIR=%~dp0data-n8
"C:\Program Files\nodejs\node.exe" node.mjs 9346 >> log-node9346.txt 2>&1
