@echo off
rem === AGT auto-miner task wrapper: лог в log-miner.txt ===
cd /d "%~dp0"
rem с 2026-11-02 майним на фонд-казну AGT11a01a… (запрошено владельцем): адрес сверён с data/wallets.json — typos-f758 больше не повторяются
rem прежний майнер = hop-sender-1791936955985 (f755)
"C:\Program Files\nodejs\node.exe" auto-miner.mjs 9335 AGT11a01a612a422dff68f7558eefbd9ab3a991439a 60 >> log-miner.txt 2>&1
