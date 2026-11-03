// Тест лотереи: детерминизм, банк/доли, rollover, readyPayouts.
// Запуск: node test/lottery-determinism.mjs
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import { lotteryState, lotteryPick, parseLotTicket, parseLotPayout } from '../lottery.mjs';

const HOUSE = 'AGT1111111111111111111111111111111111111111';

function mkBlock(height, txs = [], seedSuffix = '') {
  return { height, hash: crypto.createHash('sha256').update(height + seedSuffix).digest('hex'), txs };
}

function ticket(from, height, ref) {
  return { from, to: HOUSE, amount: 1, memo: `lot|B|${ref}`, nonce: height + ref, ts: 0 };
}

function payout(height, window, to, amount) {
  return { from: HOUSE, to, amount, memo: `lot|W|${window}`, nonce: height + window, ts: 0 };
}

// --- 1. Парсинг ---
{
  const t = parseLotTicket({ from: 'AGTabc', to: HOUSE, amount: 1, memo: 'lot|B|AbCd1234' }, HOUSE);
  assert.ok(t && t.ref === 'AbCd1234', 'ticket parse ok');
  assert.equal(parseLotTicket({ from: 'AGTabc', to: HOUSE, amount: 2, memo: 'lot|B|AbCd1234' }, HOUSE), null, 'amount!=1 не билет');
  assert.equal(parseLotTicket({ from: 'AGTabc', to: 'AGTother', amount: 1, memo: 'lot|B|AbCd1234' }, HOUSE), null, 'не на казну — не билет');
  assert.equal(parseLotTicket({ from: 'AGTabc', to: HOUSE, amount: 1, memo: 'FAKE|B|AbCd1234' }, HOUSE), null, 'чужой префикс отсечён');
  assert.equal(parseLotTicket({ from: 'AGTabc', to: HOUSE, amount: 1, memo: 'lot|B|SHORT!' }, HOUSE), null, 'ref не по формату');
  const p = parseLotPayout({ from: HOUSE, to: 'AGTabc', amount: 4.5, memo: 'lot|W|3' }, HOUSE);
  assert.ok(p && p.window === 3, 'payout parse ok');
  assert.equal(parseLotPayout({ from: 'AGTevil', to: HOUSE, amount: 1, memo: 'lot|W|3' }, HOUSE), null, 'пейаут только от казны');
}

// --- 2. Детерминизм выбора победителя ---
{
  const entries = [
    { from: 'AGTaaaa', height: 5, txIdx: 0, txid: 'a' },
    { from: 'AGTbbbb', height: 7, txIdx: 1, txid: 'b' },
    { from: 'AGTcccc', height: 9, txIdx: 2, txid: 'c' },
  ];
  const seed = crypto.createHash('sha256').update('seed-block').digest('hex');
  const pick1 = lotteryPick(entries, seed);
  const pick2 = lotteryPick(entries, seed);
  assert.ok(pick1, 'winner picked');
  assert.deepEqual(pick1, pick2, 'same chain → same winner');
  assert.ok(pick1.index >= 0 && pick1.index < 3, 'index in range');
  // разные seed — распределение не вырождено в одну точку
  const seeds = Array.from({ length: 40 }, (_, i) => crypto.createHash('sha256').update('s' + i).digest('hex'));
  const idxs = new Set(seeds.map(s => lotteryPick(entries, s).index));
  assert.ok(idxs.size > 1, 'seed меняет исход');
  assert.equal(lotteryPick([], seed), null, 'пустые entries — нет победителя');
}

// --- 3. Окно: 10 билетов → банк 10, prize 9, houseFee 1 ---
{
  const addrs = Array.from({ length: 10 }, (_, i) => 'AGT' + String(i).padStart(40, '0').replace(/(.)(.)/g, 'x$1$2'));
  const chain = [];
  let refN = 0;
  for (let h = 0; h < 100; h++) {
    const txs = [ ticket(addrs[h], h, 'AB' + String(refN++).padStart(6, '0')) ];
    chain.push(mkBlock(h, txs, 'w0'));
  }
  // 101-й блок (высота 100) — окно 1 началось, тираж окна 0 случился
  chain.push(mkBlock(100, [], 'w1'));
  const st = lotteryState(chain, HOUSE);
  assert.equal(st.draws.length, 1, 'один тираж');
  const d = st.draws[0];
  assert.equal(d.window, 0, 'окно 0');
  assert.equal(d.entries, 10, '10 билетов');
  assert.equal(d.pot, 10, 'банк 10 AGT');
  assert.equal(d.prize, 9, 'prize 90% = 9 AGT');
  assert.equal(d.houseFee, 1, 'house edge 10% = 1 AGT');
  assert.equal(d.status, 'awaiting_payout', 'ждёт авто-выплаты');
  assert.equal(st.readyPayouts.length, 1, 'readyPayouts есть');
  assert.equal(st.readyPayouts[0].prize, 9, 'готово 9 AGT к выплате');
  assert.equal(st.readyPayouts[0].winner, d.winner, 'winner из state совпадает');
  assert.ok(d.winner && d.winner.startsWith('AGT'), 'победитель — валидный адрес');
  // повторный расчёт — тот же результат (детерминизм state)
  const st2 = lotteryState(chain, HOUSE);
  assert.deepEqual(st2.draws, st.draws, 'state детерминирован');
}

// --- 4. Выплата → paid; дубль аннотируется ---
{
  const addrs = Array.from({ length: 10 }, (_, i) => 'AGT' + String(i).padStart(40, '0').replace(/(.)(.)/g, 'x$1$2'));
  const chain = [];
  let refN = 0;
  for (let h = 0; h < 100; h++) { chain.push(mkBlock(h, [ ticket(addrs[h], h, 'AB' + String(refN++).padStart(6, '0')) ], 'p0')); }
  const stSh = lotteryState(chain, HOUSE);
  const winner = stSh.readyPayouts[0].winner, prize = stSh.readyPayouts[0].prize;
  chain.push(mkBlock(100, [ payout(100, 0, winner, prize) ], 'p1'));
  const st = lotteryState(chain, HOUSE);
  const d = st.draws[0];
  assert.equal(d.status, 'paid', 'выплачено');
  assert.equal(st.draws[0].prize, 9, 'prize корректен');
  assert.equal(d.dupCount, 0, 'без дублей');
  // дубль сверх — аномалия
  chain.push(mkBlock(101, [ payout(101, 0, winner, prize) ], 'p2'));
  const stDup = lotteryState(chain, HOUSE);
  assert.equal(stDup.draws[0].status, 'paid', 'первая выплата остаётся canonical');
  assert.equal(stDup.draws[0].dupCount, 1, 'дубль помечен');
  assert.equal(stDup.draws[0].prize, 9, 'prize не задвоен');
}

// --- 5. Rollover: банк не выплачен за grace → переносится в следующее окно ---
{
  const chain = [];
  let refN = 0;
  for (let h = 0; h < 100; h++) {
    const txs = h < 3 ? [ ticket('AGT' + String(h).padStart(40, '0').replace(/(.)(.)/g, 'x$1$2'), h, 'RO' + String(refN++).padStart(6, '0')) ] : [];
    chain.push(mkBlock(h, txs, 'r0'));
  }
  // 160+ блоков тишины: WIN grace (deadline = 99 + 60 = 159) пройден
  for (let h = 100; h <= 165; h++) chain.push(mkBlock(h, [], 'r' + h));
  const st = lotteryState(chain, HOUSE);
  const d = st.draws.find(x => x.window === 0);
  assert.equal(d.status, 'rolled_over', 'банк перенесён');
  assert.equal(d.pot, 3, 'банк окна = 3 билета');
  // следующее окно ещё не тираживалось; его потенциальный банк = перенос
  // заводим окно 1 с 5 билетами (в 5 отдельных блоках), остальные блоки пустые, и доводим до тиража
  for (let h = 166; h < 200; h++) {
    const txs = (h % 7 === 0 && refN < 3 + 5) ? [ ticket('AGT' + String(h).padStart(40, '0').replace(/(.)(.)/g, 'x$1$2'), h, 'RN' + String(refN++ - 3).padStart(6, '0')) ] : [];
    chain.push(mkBlock(h, txs, 'q' + h));
  }
  chain.push(mkBlock(200, [], 'finish'));
  const st2 = lotteryState(chain, HOUSE);
  const d1 = st2.draws.find(x => x.window === 1);
  assert.equal(d1.pot, 8, 'банк окна 1 = 5 билетов + 3 rollover');
  assert.equal(d1.prize, 7.2, 'prize 90% от 8');
  assert.equal(st2.current.window, 2, 'текущее окно — 2-е');
}

// --- 6. Пустое окно: без билетов — тираж не случается ---
{
  const chain = [];
  for (let h = 0; h < 105; h++) chain.push(mkBlock(h, [], 'e' + h));
  const st = lotteryState(chain, HOUSE);
  assert.equal(st.draws.length, 0, 'пустых тиражей нет');
  assert.equal(st.current.window, 1, 'текущее окно 1');
}

// --- 7. Пустой вызов/краевой случай ---
{
  const st = lotteryState([], HOUSE);
  assert.ok(st && st.current.window === 0, 'пустая цепь не падает');
}

console.log('lottery tests OK · windows:', 'parsing+pick+payout+rollover+empty');
