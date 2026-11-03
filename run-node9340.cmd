@echo off
rem === AGT node 9340: цепь в своём data-dir (масштабирование AGIP-9, нода-наблюдатель G) ===
cd /d "%~dp0"
set AGT_DATA_DIR=%~dp0data-n7
rem SPORE (AGIP-18 MVP): слой узла-организма — геном/физарум/метаболизм (канарейка G)
set AGT_SPORE=1
set AGT_HOST_CAL=75
"C:\Program Files\nodejs\node.exe" node.mjs 9340 >> log-node9340.txt 2>&1
