@echo off
rem === AGT node 9344: цепь в своём data-dir (масштабирование AGIP-9, нода-наблюдатель H) ===
cd /d "%~dp0"
set AGT_DATA_DIR=%~dp0data-n8
rem SPORE (AGIP-18 MVP): слой узла-организма — геном/физарум/метаболизм (канарейка H)
set AGT_SPORE=1
set AGT_HOST_CAL=55
"C:\Program Files\nodejs\node.exe" node.mjs 9344 >> log-node9344.txt 2>&1
