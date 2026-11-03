@echo off
rem === AGT node 9345: цепь в своём data-dir (масштабирование AGIP-9, нода-наблюдатель I) ===
cd /d "%~dp0"
set AGT_DATA_DIR=%~dp0data-n9
rem SPORE (AGIP-18 MVP): слой узла-организма — геном/физарум/метаболизм (канарейка I)
set AGT_SPORE=1
set AGT_HOST_CAL=85
"C:\Program Files\nodejs\node.exe" node.mjs 9345 >> log-node9345.txt 2>&1
