/* cabinet-cancel-unit.mjs — ядро-уровень приёмки отмены ордера кабинета.
   HTTP /dxe/order и /dxe/callback формируют РОВНО те же memo-tx (dxe|O|…, dxe|C|…),
   что и Кабинет; здесь проверяем ту же логику прямо на Blockchain + dxeState —
   детерминированное состояние книги, одинаковое на любой ноде:
     1) sell-ордер → cancel → canceled, из книги (asks) исчез;
     2) buy-ордер → cancel → canceled, из книги (bids) исчез;
     3) ЧУЖАЯ отмена (maker ≠ ордер) индексером игнорируется — ордер ещё open.
   Запуск: node test/cabinet-cancel-unit.mjs. Exit 0 = ok. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Blockchain, createWallet, signTransaction } from '../core.mjs';
import { dxeState, dxeBook } from '../dxe.mjs';

const fails = [];
const ok = (m) => console.log('  ok: ' + m);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-cx-'));
const bc = new Blockchain(dir); // genesis сразу

const wMaker = createWallet('maker');
const wOther = createWallet('stranger');

// баланс мейкера = coinbase: майним несколько блоков ему
for (let i = 0; i < 5; i++) bc.mineOnce(wMaker.address);
const bal = bc.balances()[wMaker.address] || 0;
if (!(bal > 0)) fails.push(`coinbase не дал балансу мейкера (bal=${bal})`);
else ok(`мейкер нащупал coinbase: ${bal} AGT`);

function submitTx(fromWallet, memo, amount = 0.001) {
  const tx = { from: fromWallet.address, to: fromWallet.address, amount, nonce: Date.now() + Math.random(), ts: Date.now(), memo };
  tx.fromPub = fromWallet.pub;
  tx.signature = signTransaction(tx, fromWallet.privKey);
  const r = bc.addTransaction(tx);
  if (!r.ok) fails.push(`addTransaction(${memo.slice(0, 18)}…): ${r.reason}`);
  return tx.txid;
}

async function mineAnd(fnName, check) {
  const before = bc.blockCount();
  bc.mineOnce(wMaker.address);
  if (bc.blockCount() !== before + 1) { fails.push(`блок не закоммичен (${fnName})`); }
  const ds = dxeState(bc); // важно: cacheHeight сместился — пересчёт обязателен
  check(ds);
}

const ITEM = 'test:cancel-accept';
const ref = () => Math.random().toString(36).slice(2, 10).padEnd(8, '0').slice(0, 8);

/* --- 1. SELL --- */
const R1 = ref();
submitTx(wMaker, `dxe|O|s|${ITEM}|10|2.5|${R1}`);
await mineAnd('sell-order', (ds) => {
  const o = ds.orders.find(x => x.ref === R1);
  if (!o || o.status !== 'open') fails.push(`sell-ордер после блока: status=${o && o.status}`);
  else ok('sell-ордер open в книге (высота ' + o.height + ')');
});
submitTx(wMaker, `dxe|C|${R1}`);
await mineAnd('sell-cancel', (ds) => {
  const o = ds.orders.find(x => x.ref === R1);
  if (!o || o.status !== 'canceled') fails.push(`sell-отмена: status=${o && o.status}`);
  else ok('sell-ордер canceled после cancel-tx');
  const bk = dxeBook(bc, ds, ITEM);
  if ((bk.asks || []).some(a => a.ref === R1)) fails.push('canceled sell всё ещё в asks');
  else ok('canceled sell исчез из стакана asks');
});

/* --- 2. BUY --- */
const R2 = ref();
submitTx(wMaker, `dxe|O|b|${ITEM}|5|1.5|${R2}`);
await mineAnd('buy-order', (ds) => {
  const o = ds.orders.find(x => x.ref === R2);
  if (!o || o.status !== 'open') fails.push(`buy-ордер после блока: status=${o && o.status}`);
  else ok('buy-ордер open в книге');
});
submitTx(wMaker, `dxe|C|${R2}`);
await mineAnd('buy-cancel', (ds) => {
  const o = ds.orders.find(x => x.ref === R2);
  if (!o || o.status !== 'canceled') fails.push(`buy-отмена: status=${o && o.status}`);
  else ok('buy-ордер canceled после cancel-tx');
  const bk = dxeBook(bc, ds, ITEM);
  if ((bk.bids || []).some(b => b.ref === R2)) fails.push('canceled buy всё ещё в bids');
  else ok('canceled buy исчез из стакана bids');
});

/* --- 3. негатив: чужая отмена НЕ убивает ордер --- */
const R3 = ref();
// чужой кошелёк с монетой (feememo и оплата — 0.001): иначе фильтр balances корректно отверг бы расход пустого адреса
for (let i = 0; i < 5; i++) bc.mineOnce(wOther.address);
if (!((bc.balances()[wOther.address] || 0) > 0)) fails.push('чужой кошалёк без coinbase (fee нет)');
else ok('чужой нащупал coinbase (fee 0.001 доступно)');
submitTx(wMaker, `dxe|O|s|${ITEM}|3|9.9|${R3}`);
await mineAnd('neg-order', (ds) => {
  if (!ds.orders.find(x => x.ref === R3 && x.status === 'open')) fails.push('негатив-sell не стал open');
  else ok('негатив-sell open');
});
submitTx(wOther, `dxe|C|${R3}`); // НЕ мейкер
await mineAnd('foreign-cancel', (ds) => {
  const o = ds.orders.find(x => x.ref === R3);
  if (!o || o.status !== 'open') fails.push(`чужая cancel УБИЛА ордер (status=${o && o.status}) — СЕРЬЁЗНАЯ ДЫРА`);
  else ok('чужая отмена игнорируется: ордер остался open (only maker правила)');
});

if (fails.length) {
  console.error('CABINET-CANCEL-UNIT: FAIL → ' + fails.join('; '));
  process.exit(1);
}
console.log('CABINET-CANCEL-UNIT: OK — sell/buy отменяются, чужая отмена игнорируется');
process.exitCode = 0;
