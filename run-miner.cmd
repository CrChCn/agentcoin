@echo off
rem === AGT auto-miner task wrapper: лог в log-miner.txt ===
cd /d <PROJECT_DIR>
rem адрес майнера = hop-sender-1791936955985 (f755): с 2026-10-14Coinbase-typos-f758 заблокировал ~13.6k AGT навсегда — больше не повторяется
"C:\Program Files\nodejs\node.exe" auto-miner.mjs 9335 AGT11a01a612a422dff68f7558eefbd9ab3a991439a 60 >> log-miner.txt 2>&1
