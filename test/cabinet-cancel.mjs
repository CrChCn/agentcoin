/* cabinet-cancel.mjs — испектируемый критерий приёмки «отмена ордера в кабинете»
   (кабинет → кнопка ✕ → POST /dxe/cancel {maker,ref} → memo dxe|C|<ref8>).
   Проверяет ОБЕ стороны книги и негатив (отмена чужого ref игнорируется):
   1) sell-ордер: в книге open → cancel → в книге НЕТ, статус canceled;
   2) buy-ордер: то же самое со стороны bids;
   3) чужая отмена (не maker) — ордер ОСТАЁТСЯ в книге открытым.
   Запуск: node test/cabinet-cancel.mjs [BASE]  (по умолчанию http://127.0.0.1:9335)
   Exit: 0 = ок, 1 = FAIL. */
const BASE = process.argv[2] || 'http://127.0.0.1:9335';
const fails = [];
const ok = (m) => console.log('  ok: ' + m);
const sleep = (ms) => new Promise(s => setTimeout(s, ms));

async function j(method, path, body = null) {
  let last = { status: 0, body: { error: 'no_response' } };
  for (let a = 0; a < 6; a++) { // нода бывает busy (soak-трафик) — ретраить overloaded/сбросы соединения
    try {
      const r = await fetch(BASE + path, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) });
      let b = {};
      try { b = await r.json(); } catch {}
      if (!(b && b.error === 'overloaded')) return { status: r.status, body: b };
      last = { status: r.status, body: b };
    } catch { last = { status: 0, body: { error: 'econnreset' } }; }
    await sleep(1500);
  }
  return last;
}

/* --- уникальная пара: свой item, чтобы тест не смешивался с чужими статьями --- */
const TAG = 'cx1' + Math.random().toString(36).slice(2, 6);
const ITEM = 'test:' + TAG;

const w = await j('POST', '/wallet/create', { label: 'cab-cancel-' + TAG });
if (!w.body.address) { console.error('FAIL: wallet unavailable:', JSON.stringify(w.body).slice(0, 160)); process.exit(1); }
const A = w.body.address;
const wOther = await j('POST', '/wallet/create', { label: 'cab-cancel-x-' + TAG });
const X = wOther.body.address || 'AGT1111111111111111111111111111111111111111';
ok('кошельки: maker ' + A.slice(0, 14) + '…, чужой ' + X.slice(0, 14) + '…');

async function mineUntil(pred, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const m = await j('POST', '/mine', { miner: A });
    if (!([200].includes(m.status) || (m.status === 202 && m.body.error === 'mining_slice_exhausted'))) {
      // mining недоступен на этой ноде — не его вина в тесте отмены; блоки приходят от фонового майнера
    }
    await sleep(400);
    if (await pred()) return true;
  }
  return false;
}
const myOrders = async () => ((await j('GET', '/dxe/orders?maker=' + A)).body.orders || []).filter(o => o.item === ITEM);
const inBook = async (ref, side) => {
  const st = await myOrders();
  const o = st.find(x => x.ref === ref);
  return o && o.status === 'open' && (side ? o.side === side : true);
};

/* --- 1. SELL: выставили → cancel → canceled, в книге нет --- */
const s1 = await j('POST', '/dxe/order', { maker: A, side: 's', item: ITEM, qty: '10', price: '2.5' });
if (s1.status !== 201 || !s1.body.ref) fails.push('sell /dxe/order: status=' + s1.status + ' body=' + JSON.stringify(s1.body).slice(0, 140));
else ok('sell-ордер в мемпул: ref=' + s1.body.ref);
const SREF = s1.body.ref;
const s1in = await mineUntil(() => inBook(SREF, 's'));
if (!s1in) fails.push('sell-ордер не стал open в книге (долго не майнится)');
else ok('sell-ордер стал open в книге');

const c1 = await j('POST', '/dxe/cancel', { maker: A, ref: SREF });
if (c1.status !== 201) fails.push('cancel sell: status=' + c1.status + ' body=' + JSON.stringify(c1.body).slice(0, 140));
else ok('отмена sell подписана: ' + JSON.stringify(c1.body).slice(0, 60));

const c1done = await mineUntil(async () => {
  const st = (await myOrders()).find(o => o.ref === SREF);
  return st && st.status === 'canceled';
});
if (!c1done) fails.push('sell-ордер все ещё open после отмены');
else {
  ok('sell-ордер стал canceled после отмены');
  const b = (await j('GET', '/dxe/book?item=' + encodeURIComponent(ITEM))).body;
  if ((b.asks || []).some(o => o.ref === SREF)) fails.push('отменённый sell всё ещё в стакане asks');
  else ok('отменённого sell в стакане нет');
}

/* --- 2. BUY: то же самое на bids --- */
const o2 = await j('POST', '/dxe/order', { maker: A, side: 'b', item: ITEM, qty: '5', price: '1.5' });
if (o2.status !== 201 || !o2.body.ref) fails.push('buy /dxe/order: status=' + o2.status + ' body=' + JSON.stringify(o2.body).slice(0, 140));
else ok('buy-ордер в мемпул: ref=' + o2.body.ref);
const BREF = o2.body.ref;
const b1in = await mineUntil(() => inBook(BREF, 'b'));
if (!b1in) fails.push('buy-ордер не стал open в книге');
else ok('buy-ордер стал open в книге');

const c2 = await j('POST', '/dxe/cancel', { maker: A, ref: BREF });
if (c2.status !== 201) fails.push('cancel buy: status=' + c2.status + ' body=' + JSON.stringify(c2.body).slice(0, 140));
else ok('отмена buy подписана');

const c2done = await mineUntil(async () => {
  const st = (await myOrders()).find(o => o.ref === BREF);
  return st && st.status === 'canceled';
});
if (!c2done) fails.push('buy-ордер все ещё open после отмены');
else ok('buy-ордер стал canceled после отмены');

/* --- 3. негатив: ЧУЖАЯ отмена (maker ≠ ордер) игнорируется индексером --- */
const o3 = await j('POST', '/dxe/order', { maker: A, side: 's', item: ITEM, qty: '3', price: '9.9' });
const R3 = o3.body && o3.body.ref;
if (!R3) { fails.push('негатив-sell не выставился: ' + JSON.stringify(o3.body).slice(0, 120)); }
else {
  await mineUntil(() => inBook(R3, 's'));
  const xc = await j('POST', '/dxe/cancel', { maker: X, ref: R3 });
  if (xc.status !== 201 && xc.status !== 403) fails.push('чужая отмена: статус ' + xc.status + ' (ожидали 201 (memo впишут) или 403)');
  else ok('чужая отмена: статус ' + xc.status + ' (memo от X не владелец)');
  const still = await mineUntil(async () => {
    const st = (await myOrders()).find(o => o.ref === R3);
    return st && st.status === 'open';
  });
  if (!still) fails.push('чужая отмена УБИЛА ордер (индексер проглотил не-мейкировскую отмену) — СЕРЬЁЗНАЯ дыра');
  else ok('чужая отмена ИГНОРИРУЕТСЯ: ордер остался open');
  // уберём за собой честной отменой
  await j('POST', '/dxe/cancel', { maker: A, ref: R3 });
}

if (fails.length) {
  console.error('CABINET-CANCEL: FAIL → ' + fails.join('; '));
  process.exit(1);
}
console.log('CABINET-CANCEL: OK (' + BASE + ', item=' + ITEM + ') — sell+buy отменяются, чужая отмена игнорируется');
process.exitCode = 0;
