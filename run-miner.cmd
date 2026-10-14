@echo off
rem === AGT auto-miner task wrapper: лог в log-miner.txt ===
cd /d <PROJECT_DIR>
"C:\Program Files\nodejs\node.exe" auto-miner.mjs 9335 AGT11a01a612a422dff68f758eefbd9ab3a991439a 60 >> log-miner.txt 2>&1
