@echo off
rem === AGT node 9335 task wrapper: лог в log-node.txt ===
cd /d "%~dp0"
rem ТЗ-1 (аудит 2026-10-15): токен охраны деструктивных POST читается из gitignored-файла
if exist "%~dp0data-agtx\admin-token.txt" (
  for /f "usebackq delims=" %%T in ("%~dp0data-agtx\admin-token.txt") do set "AGT_ADMIN_TOKEN=%%T"
)
"C:\Program Files\nodejs\node.exe" node.mjs 9335 >> log-node.txt 2>&1
