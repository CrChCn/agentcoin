@echo off
rem === AGT node 9335 task wrapper: лог в log-node.txt ===
cd /d <PROJECT_DIR>
"C:\Program Files\nodejs\node.exe" node.mjs 9335 >> log-node.txt 2>&1
