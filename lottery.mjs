/* ============================================================
   LOTTERY — ончейн-лотерея AGENTCOIN (v1).
   ИДЕЯ (как dxe.mjs): состояние = ЧИСТАЯ ФУНКЦИЯ ЦЕПИ.
   Билет = обычная ончейн tx с memo `lot|B|<ref8>`, amount = ровно
   1 AGT, получатель — адрес казны (HOUSE). Никаких state-файлов:
   любая нода, посчитав индекс по одинаковым блокам, получает
   одинаковую историю тиражей и того же победителя.

   Протокол memo:
     lot|B|<ref8>   — покупка билета (tx → HOUSE, amount = 1 AGT)
     lot|W|<window> — авто-выплата тиража (tx от HOUSE → победитель)
   Правила:
     • окно тиража w = блоки [w*100, (w+1)*100) (DRAW_EVERY = 100);
     • тираж происходит, когда в цепи появился ПОСЛЕДНИЙ блок окна:
       seed = hash блока (w+1)*DRAW_EVERY - 1 (тот самый блок);
     • победитель = entries[ BigInt('0x'+seed) % N ] — честный RNG
       из хеша публичного блока, детерминирован на всех нодах;
     • банк (pot) = число билетов × 1 AGT + непогашенный джекпот
       предыдущих окон (rollover);
     • выигрыш = 90% банка (WIN_SHARE), 10% (HOUSE_SHARE) остаётся
       в казне — деньги билетов УЖЕ на адресе казны, отдельного
       перевода house edge не требуется;
     • авто-выплата: tx с memo lot|W|<window> от казны победителю
       (signs hot-кошелёк казны — тот же паттерн, что faucet);
       нода с AGT_LOTTERY_PAYER=1 платит автоматически без ручного
       подтверждения по достижении высоты тиража;
     • если выплата не случилась за PAY_GRACE блоков после тиража —
       весь банк переносится в джекпот следующего окна (никто не
       «проматывает» банк, честный rollover);
     • дубли lot|W|<window> от казны — аномалия, помечаются в state
       (dupPayouts), но выплачены они быть не должны: авто-пейер
       перед отправкой проверяет «уже выплачено?» по цепи.
   ============================================================ */
'use strict';

const DRAW_EVERY = 100;      // тираж каждые 100 блоков
const TICKET_PRICE = 1;      // билет = 1 AGT
const WIN_SHARE = 0.9;       // победителю
const HOUSE_SHARE = 0.1;     // казне (остаток от банка)
const PAY_GRACE = 60;        // блоков на авто-выплату, дальше rollover
const DEC = 6;               // точность сумм (как amount precision)
const ADDR_RE = /^AGT[A-Za-z0-9]+$/;
const REF_RE = /^[A-Za-z0-9]{8}$/;

function txKey(tx) {
  return `${tx.from}|${tx.nonce}|${tx.memo}`;
}

// Покупка билета: lot|B|<ref8>, получатель HOUSE, ровно 1 AGT
export function parseLotTicket(tx, house) {
  if (!tx || typeof tx.memo !== 'string') return null;
  if (tx.to !== house) return null;
  if (Number(tx.amount) !== TICKET_PRICE) return null;
  const m = tx.memo.match(/^lot\|B\|([A-Za-z0-9]{8})$/);
  if (!m) return null;
  if (!ADDR_RE.test(String(tx.from))) return null;
  return { type: 'ticket', ref: m[1], from: tx.from, txid: tx.txid || txKey(tx), amount: Number(tx.amount), ts: tx.ts, nonce: tx.nonce };
}

// Авто-выплата тиража от казны
export function parseLotPayout(tx, house) {
  if (!tx || typeof tx.memo !== 'string') return null;
  if (tx.from !== house) return null;
  const m = tx.memo.match(/^lot\|W\|(\d+)$/);
  if (!m) return null;
  if (!ADDR_RE.test(String(tx.to))) return null;
  const amount = Number(tx.amount);
  if (!(amount > 0)) return null;
  return { type: 'payout', window: Number(m[1]), to: tx.to, amount, txid: tx.txid || txKey(tx), ts: tx.ts, nonce: tx.nonce };
}

export function round6(n) { return Math.round(n * 1e6) / 1e6; }

// Детерминированный выбор победителя: seed — hex-хеш публичного блока.
// Одинаковые блоки на всех нодах ⇒ одинаковый победитель.
export function lotteryPick(entries, seedHex) {
  if (!entries.length || !seedHex) return null;
  const h = String(seedHex).replace(/^0x/, '');
  let acc = 0n;
  try { acc = BigInt('0x' + (h || 'f')); } catch { return null; }
  const idx = Number(acc % BigInt(entries.length));
  return { index: idx, winner: entries[idx] };
}

export function lotteryState(bcOrChain, house) {
  const chain = Array.isArray(bcOrChain) ? bcOrChain : bcOrChain.chain;
  const usedRefs = new Set();
  const buyByWindow = new Map();   // window → [entries]
  const payouts = {};              // window → [payouts] в порядке цепи

  chain.forEach((blk, txIdxBase) => {
    const height = Number.isFinite(blk.height) ? blk.height : txIdxBase;
    const w = Math.floor(height / DRAW_EVERY);
    (blk.txs || []).forEach((tx, txIdx) => {
      if (typeof tx.memo !== 'string') return;
      const t = parseLotTicket(tx, house);
      if (t) {
        if (usedRefs.has(t.ref)) return;           // ref одноразов по всей цепи
        usedRefs.add(t.ref);
        const list = buyByWindow.get(w) || [];
        list.push({ ...t, height, txIdx });
        buyByWindow.set(w, list);
        return;
      }
      const p = parseLotPayout(tx, house);
      if (p) { (payouts[p.window] ||= []).push({ ...p, height, txIdx }); }
    });
  });

  // --- прогон окон от 0 до текущего: банк, тираж, выплата, rollover ---
  const L = chain.length;                      // число блоков (heights 0..L-1)
  const curWindow = Math.max(0, Math.floor((L - 1) / DRAW_EVERY));
  const draws = [];                            // история завершённых/ожидающих выплат
  const readyPayouts = [];                     // тиражи ждущие авто-выплаты
  let carry = 0;                               // джекпот-перенос
  let ticketsTotal = 0, rolledTotal = 0;
  let current = null;

  for (let w = 0; w <= curWindow; w++) {
    const entries = (buyByWindow.get(w) || []).slice()
      .sort((a, b) => a.height - b.height || a.txIdx - b.txIdx || String(a.txid).localeCompare(String(b.txid)));
    ticketsTotal += entries.length;
    const drawH = w * DRAW_EVERY + DRAW_EVERY - 1;   // высота seed-блока
    const deadlineH = drawH + PAY_GRACE;
    const drawn = L > drawH;
    const pot = round6(entries.length * TICKET_PRICE + carry);

    if (!drawn) {
      current = { window: w, entries: entries.length, pot, blocksLeft: drawH - (L - 1), drawBlockHeight: drawH };
      continue;
    }

    const seed = (chain[drawH] && chain[drawH].hash) || null;
    const pick = lotteryPick(entries, seed);

    if (!pick) {
      // окно без билетов: тиража нет, джекпот просто ждёт следующих окон — в историю не пишем
      current = null;
      continue;
    }

    const winner = pick.winner.from;
    const prize = round6(pot * WIN_SHARE);
    const houseFee = round6(pot - prize);
    const pl = (payouts[w] || []);
    const validPayout = pl.find(p => p.to === winner && Math.abs(p.amount - prize) < 1e-9);
    const dupPayouts = validPayout ? pl.filter(p => p !== validPayout && p.to === winner && Math.abs(p.amount - prize) < 1e-9) : [];
    const badPayouts = pl.filter(p => p !== validPayout && !dupPayouts.includes(p));
    const paid = !!validPayout;
    const late = paid && validPayout.height > deadlineH;
    const expired = !paid && L > deadlineH;

    if (paid) {
      draws.push({
        window: w, entries: entries.length, pot, drawHeight: drawH, seed: String(seed || '').slice(0, 16),
        winner, prize, houseFee, status: late ? 'paid_late' : 'paid', payoutHeight: validPayout.height,
        payoutTxid: validPayout.txid, dupCount: dupPayouts.length, badCount: badPayouts.length
      });
    } else if (expired) {
      // банк ушёл в джекпот следующего окна
      carry = pot; rolledTotal = round6(rolledTotal + pot);
      draws.push({ window: w, entries: entries.length, pot, drawHeight: drawH, seed: String(seed || '').slice(0, 16), winner, prize, houseFee, status: 'rolled_over' });
    } else {
      readyPayouts.push({ window: w, winner, prize, houseFee, pot, drawHeight: drawH, deadlineHeight: deadlineH, blocksLeft: deadlineH - (L - 1) });
      draws.push({ window: w, entries: entries.length, pot, drawHeight: drawH, seed: String(seed || '').slice(0, 16), winner, prize, houseFee, status: 'awaiting_payout' });
    }
    current = null;
  }

  // текущее (ещё не тиражившееся) окно для UI: предыдущий блок окна заполнился — покажем хвост()
  if (!current) {
    const w = curWindow + 1;
    const drawH = w * DRAW_EVERY + DRAW_EVERY - 1;
    if (drawH >= L) current = { window: w, entries: 0, pot: carry, blocksLeft: drawH - (L - 1), drawBlockHeight: drawH };
  }

  const recentEntries = [];
  for (let w = buyByWindow.size ? Math.max(...buyByWindow.keys()) : 0; w >= 0 && recentEntries.length < 50; w--) {
    for (const e of (buyByWindow.get(w) || []).slice().reverse()) {
      if (recentEntries.length >= 50) break;
      recentEntries.push({ window: w, ref: e.ref, from: e.from, height: e.height, ts: e.ts || null });
    }
  }

  return {
    height: L - 1, tipBlocks: L,
    house,
    rules: { ticketPrice: TICKET_PRICE, drawEvery: DRAW_EVERY, winShare: WIN_SHARE, houseShare: HOUSE_SHARE, payGraceBlocks: PAY_GRACE, seed: 'hash последнего блока окна (public block hash) — детерминированный RNG на всех нодах', run: 'чистая функция цепи — состояние одинаково на всех нодах, state-файлов нет' },    current: current ? { ...current, pot: round6(current.pot), jackpot: round6(carry) } : null,
    readyPayouts, draws: draws.slice(-30).reverse(),
    recentTickets: recentEntries,
    totals: { tickets: ticketsTotal, rolledOverAGT: rolledTotal },
    note: 'билет = tx amount 1 AGT → казна, memo lot|B|<ref8> · payout = lot|W|<window> от казны · 90% победителю / 10% house edge'
  };
}
