@echo off
rem === AGT auto-miner task wrapper: лог в log-miner.txt ===
cd /d "%~dp0"
rem с 2026-11-02 майним на фонд-казну AGT11a01a… (запрошено владельцем): адрес сверён с data/wallets.json — typos-f758 больше не повторяются
rem прежний майнер = hop-sender-1791936955985 (f755)
rem с 2026-11-23 ротация: 9 адресов владельца (запрошено владельцем), round-robin каждый тик
"C:\Program Files\nodejs\node.exe" auto-miner.mjs 9335 AGT808ab82969151514cf090aa80ef51cc904522b20,AGT85ee0f073931b0c22907dc7beea91552152943e2,AGT9120b1704493736a5af9317c3814d1940732b658,AGTc2aa7abbda6cc0d418c495f13595433fa00f9761,AGTf1510106a2b02bff7dee96ab40a1a1adaf2c64ce,AGTc0eba9749aa3200cd314e8f4afd8eb8a8e240a65,AGT12390d63b25aab09bbc69925919c02233f52197d,AGT3130ddb0f7978cf1364b3999bec7e5e7617378a9,AGT5476bf4bf653ea87aa7639324f09745b6d535761 60 >> log-miner.txt 2>&1
