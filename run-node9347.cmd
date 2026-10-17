@echo off
rem === AGT node 9347: цепь в своём data-dir (масштабирование AGIP-9, свежая нода K — распределение нагрузки) ===
cd /d "%~dp0"
set AGT_DATA_DIR=%~dp0data-n9
"C:\Program Files\nodejs\node.exe" node.mjs 9347 >> log-node9347.txt 2>&1
