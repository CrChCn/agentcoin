@echo off
rem === AGTThinMiner2 task wrapper: тонкий майнер поверх ноды 9335 (вторая машина РОЛЬ) ===
cd /d <PROJECT_DIR>
"C:\Program Files\nodejs\node.exe" miner-client.mjs http://127.0.0.1:9335 >> log-miner-client.txt 2>&1
