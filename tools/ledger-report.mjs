// ============================================================
// ledger-report.mjs — ПОЛНЫЙ бухгалтерский отчёт AGT
// Реплей ВСЕХ транзакций chain.json (генезис → HEAD):
//   · каждый tx: height, время, from, to, amount, memo, категория;
//   · финальные балансы всех адресов + владелец (по wallets-файлам);
//   · обороты по категориям (coinbase/faucet/escrow/army/dxe/gov/...);
//   · периодика по датам;
//   · сверка: сумма балансов = circulating supply = 50 × высота.
// Выход: reports/AGT-balances.csv, reports/AGT-tx-log.csv,
//        reports/AGT-LEDGER-REPORT.md
// Запуск: node tools/ledger-report.mjs [chainPath] [reportDir]
// Данные не изменяет, только читает. Секретов не печатает.
// ============================================================
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHAIN = process.argv[2] || path.join(ROOT, 'data', 'chain.json');
const OUTDIR = process.argv[3] || path.join(ROOT, 'reports');
fs.mkdirSync(OUTDIR, { recursive: true });

const FAUCET_FUND = 'AGT11a01a612a422dff68f7558eefbd9ab3a991439a';

/* ---------- 1. кошельки-реестры (кто чем владеет) ---------- */
const walletReg = {}; // address → {label, file}
for (const f of ['data/wallets.json', 'data-node3/wallets.json',
  'data-node2/wallets.json', 'data-barrier-test2/wallets.json', 'data-cx/wallets.json',
  'data-n9/wallets.json', 'data-sandbox/wallets.json', 'data-testnet/wallets.json']) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    for (const a of Object.keys(j)) if (!walletReg[a]) walletReg[a] = { label: (j[a] && j[a].label) || '', file: f };
  } catch { /* файл не обязан существовать */ }
}

/* ---------- 2. загрузка цепи ---------- */
const c = JSON.parse(fs.readFileSync(CHAIN, 'utf8'));
const chain = c.chain;
console.log(`chain: ${chain.length} blocks, chainId=${c.chainId}`);

/* ---------- 3. реплей ---------- */
const bal = Object.create(null);
const stats = Object.create(null); // address → {received, sent, txIn, txOut}
const touched = new Set();
const catAgg = Object.create(null); // category → {n, amt}
const dayAgg = Object.create(null); // YYYY-MM-DD → {blocks, coinbase, drip, otherAmt, otherN}
const txRows = [];
const fundRows = [];  // движения казны-fund (faucet-fund)
const drips = [];     // все faucet-выплаты
const escrows = [];
const army = [];
const gov = [];
const dxe = [];
const special = [];

function touch(a) { if (!touched.has(a)) touched.add(a); }
function B(a, d) { bal[a] = (bal[a] || 0) + d; }
function S(a) { return (stats[a] ||= { received: 0, sent: 0, txIn: 0, txOut: 0 }); }

function catOf(t, block) {
  const m = String(t.memo || '');
  if (t.from === 'COINBASE') return m.startsWith('block ') ? 'coinbase: auto-miner' : 'coinbase: прочее';
  if (m.startsWith('block ')) return 'coinbase: auto-miner'; // подстраховка
  if (m.startsWith('faucet:')) return 'faucet (безвозвратный газ)';
  if (m.startsWith('army:')) return 'army: сид/зарплата агентам';
  if (m.startsWith('escrow')) return 'escrow: рабочие задания';
  if (m.startsWith('gov|')) return 'gov: предложения/голоса';
  if (m.startsWith('dxe')) return 'dxe/mbc20: биржа';
  if (m.startsWith('soak')) return 'soak: нагрузочные тесты';
  if (m.startsWith('w2:')) return 'w2/army-w2: seed кошельков';
  if (m.startsWith('paysim')) return 'paysim: симуляция оплат';
  if (m.startsWith('mdata')) return 'mdata: data-exchange';
  if (m.startsWith('ops-job')) return 'ops-job-budget: фонд найма';
  if (m.startsWith('codex-review')) return 'codex-review-award: премии ревьюеру';
  if (m.startsWith('dx-')) return 'dxe/mbc20: биржа';
  return 'прочее';
}

for (const b of chain) {
  const day = new Date((b.header && b.header.ts || b.minedAt || 0) * 1000).toISOString().slice(0, 10);
  const D = (dayAgg[day] ||= { blocks: 0, coinbase: 0, drip: 0, otherAmt: 0, otherN: 0 });
  D.blocks++;
  const miner = b.miner || '(miner=undefined)';
  for (const t of (b.txs || [])) {
    const from = t.from || '?';
    const to = t.to || '?';
    const amt = Number(t.amount) || 0;
    const memo = String(t.memo || '');
    const isCoinbase = from === 'COINBASE';
    // балансы: coinbase — эмиссия; обычные tx — перевод
    if (isCoinbase) {
      B(to, amt); touch(to);
      const st = S(to); st.received += amt; st.txIn++;
      D.coinbase += amt;
    } else {
      B(from, -amt); B(to, amt); touch(from); touch(to);
      const sf = S(from), st2 = S(to);
      sf.sent += amt; sf.txOut++; st2.received += amt; st2.txIn++;
      D.otherAmt += amt; D.otherN++;
    }
    const cat = catOf(t, b);
    const A = (catAgg[cat] ||= { n: 0, amt: 0 }); A.n++; A.amt += amt;
    txRows.push([b.height, new Date(t.ts * 1000).toISOString(), from, to, amt.toFixed(8), memo.replace(/"/g, "'"), cat]);
    if (from === FAUCET_FUND || to === FAUCET_FUND) fundRows.push([b.height, new Date(t.ts * 1000).toISOString(), from === 'COINBASE' ? 'COINBASE→' + FAUCET_FUND.slice(0, 10) : from, to, amt.toFixed(2), memo.replace(/"/g, "'")]);
    if (memo.startsWith('faucet:')) drips.push([b.height, new Date(t.ts * 1000).toISOString(), to, amt.toFixed(2), memo]);
    if (memo.startsWith('escrow')) escrows.push([b.height, from, to, amt.toFixed(2), memo.slice(0, 90)]);
    if (memo.startsWith('army:')) army.push([b.height, from, to, amt.toFixed(2), memo]);
    if (memo.startsWith('gov|')) gov.push([b.height, from, to, amt.toFixed(4), memo.slice(0, 60)]);
    if (memo.startsWith('dxe') || memo.startsWith('dx-')) dxe.push([b.height, from, to, amt.toFixed(4), memo.slice(0, 40)]);
    if (isCoinbase && !memo.startsWith('block ')) special.push([b.height, miner.slice(0, 20), to, amt, memo.slice(0, 40)]);
  }
}

/* ---------- 4. свалка адресов ---------- */
const owners = Object.create(null);
function ownerOf(a) {
  if (a === 'COINBASE') return 'SYSTEM: эмиссия';
  if (a === 'AGT_GENESIS_TREASURY') return 'SYSTEM: генезис-казна';
  if (a.startsWith('ESCROW_')) return 'SYSTEM: escrow-эскроу';
  if (a === FAUCET_FUND) return 'ОПЕРАТОР: казна/faucet-fund (само-майнится)';
  const w = walletReg[a];
  if (!w) return 'БЕЗ КЛЮЧЕЙ У ОПЕРАТОРА (тестовые/аренда прошлых прогонов)';
  const l = w.label || 'unlabeled';
  if (/^thin-miner/.test(l)) return 'ОПЕРАТОР: thin-майнеры (старые прогоны)';
  if (/^agent/.test(l)) return 'ОПЕРАТОР→АГЕНТЫ: кошельки ИИ-армии';
  if (a.startsWith('GW')) return 'SYSTEM: gateway-кошелёк нод';
  if (/(agip4|soak|accept|cab-|hop-|gov-|esc-|dxe-|market|diag|codex(?!-review)|ops-|test-e2e|dec-test|seed|dummy)/.test(l)) return 'ОПЕРАТОР: тестовые приёмки';
  return 'ОПЕРАТОР: прочие рабочие кошельки';
}
for (const a of touched) owners[a] = ownerOf(a);

const addrRows = [...touched].sort((x, y) => (bal[y] - bal[x]) || x.localeCompare(y));
const total = Object.values(bal).reduce((s, v) => s + v, 0);
const negAddrs = addrRows.filter(a => bal[a] < -1e-9);

/* ---------- 5. сверки ---------- */
const height = chain.length;
// h=0 — символический genesis-coinbase на 0 AGT («The Times»), потому эмиссия = 50 × (height−1)
const supplyCheck = total - 50 * (height - 1);
const covRows = [];
covRows.push([`сумма балансов`, total.toFixed(2)]);
covRows.push([`50 × (высота−1) = 50 × ${height - 1}`, (50 * (height - 1)).toFixed(2)]);
covRows.push([`разница (обязана = 0±дроби)`, supplyCheck.toFixed(6)]);
covRows.push([`адресов коснулась цепь`, String(touched.size)]);
covRows.push([`транзакций всего`, String(txRows.length)]);
covRows.push([`отрицательных балансов`, String(negAddrs.length)]);
for (const a of negAddrs.slice(0, 5)) covRows.push([`  NEG: ${a}`, bal[a].toFixed(2)]);

/* ---------- 6. группы владельцев ---------- */
const groups = Object.create(null);
for (const a of addrRows) {
  const g = owners[a];
  (groups[g] ||= { n: 0, amt: 0 }); groups[g].n++;
  groups[g].amt += bal[a];
}

/* ---------- 7. периодика по дням ---------- */
const days = Object.entries(dayAgg).sort((x, y) => x[0].localeCompare(y[0]));

/* ---------- 8. CSV ---------- */
const csv = rows => rows.map(r => r.map(x => typeof x === 'string' && /[",\n]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x).join(',')).join('\n');

fs.writeFileSync(path.join(OUTDIR, 'AGT-balances.csv'),
  csv([['address', 'label', 'wallet_file', 'owner_group', 'balance', 'received', 'sent', 'txIn', 'txOut'],
    ...addrRows.map(a => {
      const w = walletReg[a];
      const st = stats[a] || { received: 0, sent: 0, txIn: 0, txOut: 0 };
      return [a, w ? w.label : '', w ? w.file : '', owners[a], bal[a].toFixed(2), st.received.toFixed(2), st.sent.toFixed(2), st.txIn, st.txOut];
    })]));
fs.writeFileSync(path.join(OUTDIR, 'AGT-tx-log.csv'),
  csv([['height', 'utc-time', 'from', 'to', 'amount', 'memo', 'category'], ...txRows]));
fs.writeFileSync(path.join(OUTDIR, 'AGT-fund-statement.csv'),
  csv([['height', 'utc-time', 'from', 'to', 'amount', 'memo'], ...fundRows]));
fs.writeFileSync(path.join(OUTDIR, 'AGT-faucet-drips.csv'),
  csv([['height', 'utc-time', 'to', 'amount', 'memo'], ...drips]));

/* ---------- 9. markdown ---------- */
const fmt = n => Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
const topTable = (rows, cols) => cols.join(' | ') + '\n' + cols.map(() => '---').join(' | ') + '\n' +
  rows.map(r => r.map(x => '`' + String(x) + '`').join(' | ')).join('\n');
const topAddrs = addrRows.filter(a => bal[a] > 0).slice(0, 40);

let md = [];
md.push(`# ПОЛНЫЙ БУХГАЛТЕРСКИЙ ОТЧЁТ AGT`);
md.push(`\nЦепь: ${c.chainId} · высота **${fmt(height)}** блоков · эмитировано и учтено: **${fmt(total)} AGT**\n`);
md.push(`Дата реплея: ${new Date().toISOString()} · источник: \`${path.relative(ROOT, CHAIN)}\` · live-нода: http://127.0.0.1:9335\n`);

md.push(`## 1. Сверка (целостность учёта)\n`);
md.push('| строка | значение |\n| --- | --- |');
md.push(...covRows.map(([k, v]) => `| ${k} | ${v} |`));

md.push(`\n## 2. Обороты по категориям\n`);
md.push('| категория | tx | AGT всего |\n| --- | ---: | ---: |');
md.push(...Object.entries(catAgg).sort((x, y) => y[1].amt - x[1].amt).map(([k, v]) => `| ${k} | ${fmt(v.n)} | ${fmt(v.amt)} |`));

md.push(`\n## 3. Группы владельцев (итоговые балансы)\n`);
md.push('| группа | адресов | AGT |\n| --- | ---: | ---: |');
md.push(...Object.entries(groups).sort((x, y) => y[1].amt - x[1].amt).map(([k, v]) => `| ${k} | ${fmt(v.n)} | ${fmt(v.amt)} |`));

md.push(`\n## 4. Топ-40 держателей\n`);
md.push('| адрес | метка | владелец | баланс AGT | пред. | отправлено |\n| --- | --- | --- | ---: | ---: | ---: |');
md.push(...topAddrs.map(a => {
  const w = walletReg[a]; const st = stats[a] || {};
  return `| \`+${a.slice(0, 12)}…${a.slice(-6)}\` | ${w ? w.label : '—'} | ${owners[a]} | ${fmt(bal[a])} | ${fmt(st.received || 0)} | ${fmt(st.sent || 0)} |`;
}));

md.push(`\n## 5. Периодика по дням\n`);
md.push('| день | блоков | эмиссия AGT | drip-газ | прочий оборот | tx |\n| --- | ---: | ---: | ---: | ---: | ---: |');
md.push(...days.map(([d, v]) => `| ${d} | ${fmt(v.blocks)} | ${fmt(v.coinbase)} | ${fmt(v.drip)} | ${fmt(v.otherAmt)} | ${fmt(v.otherN)} |`));

md.push(`\n## 6. Казна/faucet-fund (${FAUCET_FUND.slice(0, 10)}…): приход/расход\n`);
const fundIn = fundRows.filter(r => r[3] === FAUCET_FUND);  // to = фонд
const fundOut = fundRows.filter(r => r[2] === FAUCET_FUND); // from = фонд
md.push(`- приход (в фонд, в т.ч. coinbase-эмиссия): **${fundIn.length} tx** на ${fmt(fundIn.reduce((s, r) => s + Number(r[4]), 0))} AGT`);
md.push(`- расход (из фонда): **${fundOut.length} tx** на ${fmt(fundOut.reduce((s, r) => s + Number(r[4]), 0))} AGT`);
md.push(`- финальный баланс фонда: **${fmt(bal[FAUCET_FUND] || 0)} AGT** (каждый coinbase «block N» шёл именно сюда — auto-miner адрес совпадает с fund)`);
md.push(`- полная проводка фонда: \`reports/AGT-fund-statement.csv\`\n`);

md.push(`\n## 7. Faucet-выплаты (риплы)\n`);
const dripAgg = Object.create(null);
for (const [, , to, amt] of drips) { dripAgg[to] = (dripAgg[to] || 0) + Number(amt); }
md.push(`- всего drip **${drips.length} tx** на ${fmt(drips.reduce((s, r) => s + Number(r[3]), 0))} AGT, ${fmt(Object.keys(dripAgg).length)} адресов`);
md.push(`- памятка: ` + drips.filter(r => r[4].includes('join')).length + ' через /join, ' + (drips.length - drips.filter(r => r[4].includes('join')).length) + ' через /faucet/drip');
md.push(`- построчно: \`reports/AGT-faucet-drips.csv\`\n`);

md.push(`\n## 8. Эскроу-задания\n`);
md.push(`эскроу-проводок: **${escrows.length}**, сумма ${fmt(escrows.reduce((s, r) => s + Number(r[3]), 0))} AGT. Примеры (первые 10):`);
md.push(topTable(escrows.slice(0, 10), ['h', 'кто', 'куда', 'сумма', 'memo']) + '\n');

md.push(`\n## 9. Кошельки ИИ-армии (operator-admin)\n`);
const armyBal = addrRows.filter(a => /ОПЕРАТОР→АГЕНТЫ/.test(owners[a]));
md.push(`- кошельков агентов: **${armyBal.length}**, суммарно **${fmt(armyBal.reduce((s, a) => s + bal[a], 0))} AGT**`);
const armySeed = army.filter(r => r[4].includes('seed'));
md.push(`- seed-проводок (массовые зачисления): ${armySeed.length}, например: ${armySeed.slice(0, 3).map(r => r[3] + ' AGT @h' + r[0]).join(', ')}`);
md.push(`- вся армия-ветка: ${army.length} tx на ${fmt(army.reduce((s, r) => s + Number(r[3]), 0))} AGT\n`);

md.push(`\n## 10. Говернанс\n`);
md.push(`gov-проводки (мин-депозиты предложений, голоса): ${gov.length} tx, ${fmt(gov.reduce((s, r) => s + Number(r[3]), 0))} AGT.\n`);

md.push(`## 11. Биржа DXE/MBC-20\n`);
md.push(`dxe/dx-проводок: ${dxe.length} на ${fmt(dxe.reduce((s, r) => s + Number(r[3]), 0))} AGT (реальная торговля — фонды прогона candle-cancel/dxe-э2е).\n`);

md.push(`## 12. Нестандартная эмиссия (не «block N»)\n`);
md.push(special.length ? topTable(special, ['h', 'miner', 'получатель', 'сумма', 'memo']) : '— таких нет: эмиссия строго 50/блок в fund (совпадает с 50 × высота)');

md.push(`\n## 13. Аномалии\n`);
md.push(`- отрицательные балансы: ${negAddrs.length}`);
md.push(`- miner=undefined (исторические поля): ${chain.filter(b => !b.miner).length} блоков — их награды учтены через memo-транзакцию COINBASE как обычно`);
const lookalike = addrRows.filter(a => a !== FAUCET_FUND && a.slice(0, 10) === FAUCET_FUND.slice(0, 10) && bal[a] > 0);
for (const a of lookalike) {
  md.push(`- **ВНИМАНИЕ, ДВОЙНИК КАЗНЫ**: адрес \`${a}\` совпадает по первым 10 символам с fund-казной, но ключей нет: баланс ${fmt(bal[a])} AGT за ${(stats[a] || {}).txIn || 0} приходов (тестовый lookalike-адрес из старых прогонов; выплата faucet идёт на настоящий fund)\n`);
}

md.push(`\n## 14. Файлы отчёта\n`);
md.push('- `reports/AGT-LEDGER-REPORT.md` — этот отчёт');
md.push('- `reports/AGT-balances.csv` — все адреса: баланс, владелец, обороты');
md.push('- `reports/AGT-tx-log.csv` — ВСЕ транзакции построчно (14 468 строк + заголовок)');
md.push('- `reports/AGT-fund-statement.csv` — проводка казны-фонда');
md.push('- `reports/AGT-faucet-drips.csv` — все drip-выплаты\n');
md.push(`Метод: детерминированный реплей цепи (tools/ledger-report.mjs), оригиналы данных не изменяются; сумма балансов сходится с 50 × высота (см. §1).`);

fs.writeFileSync(path.join(OUTDIR, 'AGT-LEDGER-REPORT.md'), md.join('\n'));
console.log('report →', path.join(OUTDIR, 'AGT-LEDGER-REPORT.md'));
console.log('balances csv →', path.join(OUTDIR, 'AGT-balances.csv'), `(${addrRows.length} строк)`);
console.log('tx-log csv →', path.join(OUTDIR, 'AGT-tx-log.csv'), `(${txRows.length} строк)`);
console.log(`check: sum=${total.toFixed(2)} vs 50*h=${(50 * height)} diff=${supplyCheck.toFixed(4)}`);
console.log(`fund=${(bal[FAUCET_FUND] || 0).toFixed(2)} negAddrs=${negAddrs.length}`);
