// P0-1 п.5 (аудит AUDIT-20261018-01): read-only обход chain.json — есть ли исторические
// транзакции, где addressFromPub(fromPub) !== from. Ничего не изменяет, только печатает.
// Совпадение адрес/ключ теперь строго требуется ядром; здесь мы оцениваем НАСЛЕДИЕ.
// Запуск: node scripts/check-historical-pub-binding.mjs [data-dir ...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addressFromPub } from '../core.mjs';

// __dirname в ESM нет — резолвим от корня репозитория (родитель scripts/)
const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDirs = (process.argv.slice(2).length ? process.argv.slice(2) : ['data', 'data-node2', 'data-node3', 'data-node-ts', 'data-vps', 'data-agtx'])
  .map(d => path.join(here, d))
  .filter(d => fs.existsSync(path.join(d, 'chain.json')));

let grandTotal = 0, grandBad = 0;
for (const d of dataDirs) {
  const file = path.join(d, 'chain.json');
  let chain;
  try { chain = JSON.parse(fs.readFileSync(file, 'utf8')).chain || []; } catch (e) { console.log(`[${d}] не читается: ${e.message}`); continue; }
  let ordinary = 0, bad = 0, system = 0;
  const specimens = [];
  for (const blk of chain) {
    for (const tx of blk.txs || []) {
      if (!tx || !tx.from) continue;
      if (tx.from === 'COINBASE' || tx.from === 'AGENT_REWARD_POOL') { system++; continue; }
      // эскроу-адреса (ESCROW_*, ESCROW-*, ESCROW#*) проверяются своими правилами verifyEscrowTx (escProof/открытие) — не обычные tx:
      if (typeof tx.from === 'string' && /^ESCROW[-_#]/.test(tx.from)) continue;
      ordinary++;
      if (tx.fromPub && typeof tx.fromPub === 'string') {
        let derived = null;
        try { derived = addressFromPub(tx.fromPub); } catch { derived = 'UNPARSEABLE'; }
        if (derived !== tx.from) {
          bad++;
          if (specimens.length < 5) specimens.push({ height: blk.height ?? '?', txid: String(tx.txid || '').slice(0, 16), from: tx.from, derived });
        }
      } else {
        bad++;
        if (specimens.length < 5) specimens.push({ height: blk.height ?? '?', txid: String(tx.txid || '').slice(0, 16), from: tx.from, note: 'no fromPub' });
      }
    }
  }
  grandTotal += ordinary; grandBad += bad;
  console.log(`[${path.basename(d)}] блоков=${chain.length} обычных_tx=${ordinary} системных=${system} несоответствий_адрес/ключ=${bad}`);
  for (const s of specimens) console.log(`   ⚠ ${JSON.stringify(s)}`);
}
console.log(`\nИТОГО: обычных_tx=${grandTotal}, несоответствий=${grandBad}${grandBad === 0 ? ' — историческая цепь чиста, строгая проверка безопасна' : ` — строгая проводка validate(true) по этим местам зачтётся как 'tx signature fail' (это ожидаемый полный-аудит режим)`}`);
process.exit(0);
