/* site/ecosphere/mainnet.js — внешний модуль страницы Settlement (v0.4).
 * Строгие деньги без Number*1e9: decimal→BigInt через точный парсер, лишние знаки — отказ.
 * Отправка недоступна до успешной сверки сети (boot ok) и проверки Content-Type.
 * v0.4: живой пересчёт atomic, разбор tx до отправки, прогресс глубины 6,
 * авто-опрос статуса, список наблюдения (localStorage), авто-перепроверка сети.
 */
const API = new URLSearchParams(location.search).get('api') || location.origin;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const GENESIS = '00026d18205c7c873bd612d6e2480321171eb0cb0b3d06c2c2cb0b17b9188e4e';
const DEPTH = 6;
let NET_OK = false;
function boom(n) { try { if (window.NetworkCanvas && window.NetworkCanvas.pulse) window.NetworkCanvas.pulse(n || 3); } catch {} }
let lastCheck = null; // { order, payer, to, atomic }
let pollTimer = null;
let netTimer = null;

function parseAtomicStrict(input) {
  const s = String(input ?? '').trim();
  if (!s) throw new Error('пустая сумма');
  const m = s.match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) throw new Error('сумма — только десятичное число без экспоненты');
  const frac = m[2] || '';
  if (frac.length > 9) throw new Error('больше 9 знаков после запятой — уточните сумму, округления нет');
  if (!/^\d+$/.test(m[1])) throw new Error('некорректная сумма');
  const u = BigInt(m[1]) * 1000000000n + BigInt((frac + '000000000').slice(0, 9));
  if (u <= 0n) throw new Error('сумма обязана быть положительной');
  if (u > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('сумма превышает безопасный диапазон tx');
  return u;
}

function fmtAGT(atomic) {
  const a = BigInt(atomic);
  const whole = a / 1000000000n;
  const frac = String(a % 1000000000n).padStart(9, '0').replace(/0+$/, '');
  return frac ? whole + '.' + frac : String(whole);
}

function txAmountToAtomic(amount) {
  if (typeof amount === 'string') return parseAtomicStrict(amount);
  if (typeof amount === 'number') {
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('bad tx.amount');
    return parseAtomicStrict(String(amount));
  }
  throw new Error('bad tx.amount');
}

function checkJson(res, bodyText) {
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (!ct.includes('application/json')) throw new Error('не-JSON ответ (' + res.status + ', ' + (ct || 'без content-type') + ')');
  try { return { status: res.status, data: JSON.parse(bodyText) }; }
  catch { throw new Error('не-JSON от сервера (статус ' + res.status + ')'); }
}

async function jget(p) {
  const r = await fetch(API + p, { redirect: 'error' });
  const t = await r.text();
  return checkJson(r, t);
}
async function jpost(p, body) {
  const r = await fetch(API + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'error' });
  const t = await r.text();
  return checkJson(r, t);
}

function setGated(disabled, note) {
  for (const id of ['bGo', 'pGo', 'sGo', 'cGo']) {
    const b = document.getElementById(id);
    if (b) b.disabled = disabled;
  }
  if (note) $('mSync').textContent = note;
}

function setPill(state, text) {
  const p = $('netPill');
  if (!p) return;
  p.className = 'pill ' + state;
  p.textContent = text;
}

async function boot(silent) {
  if (!silent) setGated(true);
  try {
    const [info, life] = await Promise.all([jget('/info'), jget('/life')]);
    const tip = await jget('/blocks?n=1');
    const tb = (tip.data.blocks || [])[0] || {};
    const ok = info.data.chainId === 'AGENTCOIN'
      && String(info.data.genesisHash).toLowerCase() === GENESIS
      && info.data.blocks === life.data.blocks && tb.height === life.data.blocks - 1
      && life.data.tipHash === tb.hash && life.data.fresh === true && life.data.chainValid === true;
    $('mChain').textContent = info.data.chainId;
    $('mGenesis').textContent = String(info.data.genesisHash).slice(0, 18) + '…';
    $('mGenesis').title = info.data.genesisHash;
    $('mBlocks').textContent = info.data.blocks;
    $('mSync').textContent = ok ? 'синхронизировано' : 'РАСХОЖДЕНИЕ — см. ниже';
    setPill(ok ? 'ok' : 'bad', ok ? '● сеть сверена' : '● расхождение');
    $('netOut').innerHTML = '<div class="kv"><span>высота info/life</span><b>' + esc(info.data.blocks) + ' / ' + esc(life.data.blocks) + '</b></div>'
      + '<div class="kv"><span>вершина life/блок</span><b>' + esc(String(life.data.tipHash).slice(0, 12)) + '… / ' + esc(String(tb.hash).slice(0, 12)) + '…</b></div>'
      + '<div class="kv"><span>возраст вершины</span><b>' + esc(life.data.tipAgeSec) + ' с</b></div>'
      + '<div class="kv"><span>chainValid</span><b>' + esc(String(life.data.chainValid)) + '</b></div>';
    NET_OK = ok === true;
    if (ok) boom(2);
    setGated(!NET_OK, ok ? 'синхронизировано' : 'РАСХОЖДЕНИЕ — отправка заблокирована');
    if (!ok) $('netOut').innerHTML += '<div class="err"><b>Отправка заблокирована: сеть не сверена.</b></div>';
  } catch (e) {
    $('mSync').textContent = 'нет связи';
    setPill('bad', '● нет связи');
    $('netOut').textContent = String(e.message || e);
    setGated(true);
  }
}

// --- шаг 1: баланс ---
$('bForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!NET_OK) { $('bOut').textContent = 'отказ: сеть не сверена — дождитесь синхронизации.'; return; }
  const addr = $('bAddr').value.trim();
  if (!addr) { $('bOut').textContent = 'отказ: введите адрес.'; return; }
  $('bOut').textContent = 'запрос…';
  try {
    const r = await jpost('/balance', { address: addr });
    $('bOut').innerHTML = 'баланс (приближение из float ноды): <b>' + esc(String(r.data.balance)) + '</b> AGT · резерв: ' + esc(String(r.data.reserve)) + ' · точная сумма — только в подписанной tx';
  } catch (err) { $('bOut').textContent = 'отказ: ' + String(err.message || err); }
});
$('bCopy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('bAddr').value.trim()); $('bOut').textContent = 'адрес скопирован.'; }
  catch { $('bOut').textContent = 'не удалось скопировать — выделите вручную.'; }
});

// --- шаг 2: предпросмотр + живой пересчёт ---
function livePreview() {
  const v = $('pAmt').value.trim();
  if (!v) { $('pLive').textContent = 'введите сумму — пересчитаю в atomic прямо при вводе.'; return; }
  try {
    const a = parseAtomicStrict(v);
    $('pLive').innerHTML = esc(v) + ' AGT = <b>' + esc(String(a)) + '</b> atomic · комиссия 0 · ~' + esc(fmtAGT(a)) + ' AGT';
  } catch (err) { $('pLive').innerHTML = '<span class="err">' + esc(String(err.message || err)) + '</span>'; }
}
$('pAmt').addEventListener('input', livePreview);
$('pForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const amt = parseAtomicStrict($('pAmt').value);
    const order = $('pOrder').value.trim(), payer = $('pPayer').value.trim(), to = $('pTo').value.trim();
    if (!order) throw new Error('укажите orderId');
    if (!payer || !to) throw new Error('укажите плательщика и получателя');
    lastCheck = { order, payer, to, atomic: String(amt) };
    $('pOut').innerHTML = '<div class="kv"><span>заказ</span><b>' + esc(order) + '</b></div>'
      + '<div class="kv"><span>маршрут</span><b>' + esc(payer) + ' → ' + esc(to) + '</b></div>'
      + '<div class="kv"><span>сумма</span><b>' + esc(String(amt)) + ' atomic (' + esc(fmtAGT(amt)) + ' AGT) · комиссия 0</b></div>'
      + '<div class="dim tiny">прямой перевод, без удержания. Проверьте получателя и сумму до подписи.</div>';
  } catch (err) { $('pOut').textContent = 'отказ: ' + String(err.message || err); }
});

// --- шаг 3: разбор tx + отправка ---
function previewTx() {
  const raw = $('sTx').value.trim();
  if (!raw) { $('sPrev').textContent = 'вставьте подписанный tx — разберу и сверю с заказом до отправки.'; return; }
  let tx;
  try { tx = JSON.parse(raw); }
  catch { $('sPrev').innerHTML = '<span class="err">не JSON — вставьте объект подписанной транзакции.</span>'; return; }
  const rawLow = JSON.stringify(tx).toLowerCase();
  if (/privkey|privatekey|mnemonic|seedphrase/.test(rawLow.replace(/[^a-z]/g, ''))) {
    $('sPrev').innerHTML = '<span class="err">отказ: похоже на приватный ключ — сюда только подписанную tx.</span>'; return;
  }
  let amtLine;
  try { amtLine = String(txAmountToAtomic(tx.amount)) + ' atomic'; }
  catch { amtLine = 'сумма не разбирается строго'; }
  const chk = [];
  const eq = (a, b, name) => chk.push('<div class="kv"><span>' + esc(name) + '</span><b class="' + (String(a) === String(b) && a ? 'good' : 'err') + '">' + (String(a) === String(b) && a ? 'совпадает' : 'НЕ совпадает') + '</b></div>');
  eq(tx.from, $('sPayer').value.trim(), 'отправитель = плательщик');
  eq(tx.to, $('sTo').value.trim(), 'получатель = исполнитель');
  try {
    const ta = String(txAmountToAtomic(tx.amount));
    chk.push('<div class="kv"><span>сумма = сумма заказа</span><b class="' + (ta === $('sAmt').value.trim() ? 'good' : 'err') + '">' + (ta === $('sAmt').value.trim() ? 'совпадает' : 'НЕ совпадает') + '</b></div>');
  } catch { chk.push('<div class="kv"><span>сумма</span><b class="err">не разбирается</b></div>'); }
  chk.push('<div class="kv"><span>signature</span><b class="' + (typeof tx.signature === 'string' && tx.signature ? 'good' : 'err') + '">' + (typeof tx.signature === 'string' && tx.signature ? 'есть' : 'НЕТ — подпишите локально') + '</b></div>');
  $('sPrev').innerHTML = '<div class="kv"><span>from → to</span><b>' + esc(String(tx.from)) + ' → ' + esc(String(tx.to)) + '</b></div>'
    + '<div class="kv"><span>amount</span><b>' + esc(amtLine) + '</b></div>'
    + '<div class="kv"><span>nonce</span><b>' + esc(String(tx.nonce ?? '—')) + '</b></div>' + chk.join('');
}
$('sTx').addEventListener('input', previewTx);
for (const id of ['sOrder', 'sPayer', 'sTo', 'sAmt']) $(id).addEventListener('input', previewTx);
$('sFill').addEventListener('click', () => {
  if (!lastCheck) { $('sPrev').textContent = 'сначала покажите предпросмотр на шаге 2.'; return; }
  $('sOrder').value = lastCheck.order; $('sPayer').value = lastCheck.payer;
  $('sTo').value = lastCheck.to; $('sAmt').value = lastCheck.atomic;
  previewTx();
  document.getElementById('s3').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('sForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!NET_OK) { $('sOut').textContent = 'отказ: сеть не сверена — отправка заблокирована.'; return; }
  let tx;
  try { tx = JSON.parse($('sTx').value); } catch { $('sOut').textContent = 'отказ: не JSON'; return; }
  const rawLow = JSON.stringify(tx).toLowerCase();
  if (/privkey|privatekey|mnemonic|seedphrase/.test(rawLow.replace(/[^a-z]/g, ''))) { $('sOut').textContent = 'отказ: похоже на приватный ключ — сюда только подписанную tx'; return; }
  const errs = [];
  if (String(tx.from) !== $('sPayer').value.trim()) errs.push('отправитель ≠ плательщик заказа');
  if (String(tx.to) !== $('sTo').value.trim()) errs.push('получатель ≠ исполнитель заказа');
  try {
    const txAtomic = txAmountToAtomic(tx.amount);
    if (String(txAtomic) !== $('sAmt').value.trim()) errs.push('сумма ≠ сумма заказа');
  } catch { errs.push('сумма tx не разбирается строго — подпись обязана содержать точную decimal-сумму'); }
  if (typeof tx.signature !== 'string' || !tx.signature) errs.push('нет signature — подпишите локально у владельца');
  if (errs.length) { $('sOut').innerHTML = 'отказ без отправки:<br>' + errs.map((x) => '· ' + esc(x)).join('<br>'); return; }
  $('sOut').textContent = 'отправка…';
  try {
    const r = await jpost('/tx', tx);
    if (r.status === 201) {
      const txid = r.data && (r.data.txid || r.data.id);
      $('sOut').innerHTML = 'принято нодой (mempool ' + esc(JSON.stringify(r.data)) + '). Статус — по пруфу на шаге 4, после потери ответа — сверка.';
      boom(6);
      if (txid && $('cTxid')) {
        $('cTxid').value = String(txid);
        if ($('sTo').value.trim()) $('cTo').value = $('sTo').value.trim();
        if ($('sAmt').value.trim()) $('cAmt').value = $('sAmt').value.trim();
        document.getElementById('s4').scrollIntoView({ behavior: 'smooth', block: 'start' });
        checkStatus();
      }
    } else {
      $('sOut').innerHTML = 'отказ ноды (' + r.status + '): ' + esc(r.data.error || r.data.reason || '?') + ' — это отказ платежа, повтор — теми же байтами после сверки.';
    }
  } catch { $('sOut').textContent = 'ответ потерян: состояние неизвестно — сверьтесь по txid на шаге 4, не отправляйте другую подпись.'; }
});

// --- шаг 4: статус + глубина + наблюдение ---
function setConf(n) {
  const f = $('confFill');
  if (!f) return;
  const c = Math.max(0, Math.min(DEPTH, n || 0));
  f.style.width = (c / DEPTH * 100) + '%';
  f.className = c >= DEPTH ? 'done' : '';
}
function getWatch() {
  try { return JSON.parse(localStorage.getItem('agt_watch') || '[]'); } catch { return []; }
}
function renderWatch() {
  const w = getWatch();
  $('watchOut').textContent = w.length
    ? 'наблюдаю (' + w.length + '): ' + w.join(', ')
    : 'наблюдаемых: 0';
  const cur = $('cTxid').value.trim();
  $('cWatch').disabled = !cur || w.includes(cur);
}
$('cTxid').addEventListener('input', renderWatch);
$('cWatch').addEventListener('click', () => {
  const t = $('cTxid').value.trim();
  if (!t) return;
  const w = getWatch();
  if (!w.includes(t)) localStorage.setItem('agt_watch', JSON.stringify(w.concat([t]).slice(0, 20)));
  renderWatch();
});
async function checkStatus() {
  if (!NET_OK) { $('cOut').textContent = 'отказ: сеть не сверена — проверка заблокирована.'; return; }
  const txid = $('cTxid').value.trim(), to = $('cTo').value.trim(), amt = $('cAmt').value.trim();
  let expectAtomic;
  try {
    // Шаг 4 принимает ЦЕЛЫЕ atomic (магнеты), как написано на поле: «сумма atomic».
    if (!/^\d+$/.test(amt)) throw new Error('введите целые atomic (магнеты), например 1000000 за 0.001 AGT');
    expectAtomic = BigInt(amt);
    if (expectAtomic <= 0n) throw new Error('сумма обязана быть положительной');
    if (expectAtomic > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('сумма превышает безопасный диапазон tx');
  }
  catch (err) { $('cOut').textContent = 'отказ: ' + String(err.message || err); return; }
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) { $('cOut').textContent = 'отказ: txid — 64 hex-символа.'; return; }
  $('cOut').textContent = 'сверка…';
  try {
    const proof = await jget('/api/v1/txproof/' + encodeURIComponent(txid));
    if (proof.status !== 200 || typeof proof.data.height !== 'number') {
      setConf(0);
      $('cOut').textContent = 'в цепи нет (пруф отсутствует). Проверьте mempool / повторите позже.';
      return;
    }
    let h = proof.data.height;
    let block = ((await jget('/blocks?from=' + h + '&limit=1')).data.blocks || [])[0];
    if (block && proof.data.blockHash && block.hash !== proof.data.blockHash) {
      // Вершина сменилась между запросами (быстрые блоки): один повтор по свежему пруфу.
      $('cOut').textContent = 'цепь перестроилась между запросами — повторяю сверку по свежему пруфу…';
      await new Promise((r) => setTimeout(r, 3000));
      const proof2 = await jget('/api/v1/txproof/' + encodeURIComponent(txid));
      if (proof2.status !== 200 || typeof proof2.data.height !== 'number') { setConf(0); $('cOut').textContent = 'в цепи нет (пруф отсутствует). Проверьте mempool / повторите позже.'; return; }
      h = proof2.data.height;
      block = ((await jget('/blocks?from=' + h + '&limit=1')).data.blocks || [])[0];
      if (!block || (proof2.data.blockHash && block.hash !== proof2.data.blockHash)) { $('cOut').textContent = 'цепь сейчас перестраивается — подождите следующий блок и проверьте снова.'; return; }
    }
    const tx = (block && block.txs || []).find((t) => t && t.txid === txid);
    if (!tx) { $('cOut').textContent = 'пруф есть, тела нет — нужна повторная сверка.'; return; }
    const tip = (((await jget('/blocks?n=1')).data.blocks) || [])[0];
    if (!tip) { $('cOut').textContent = 'сверка недоступна: нет вершины.'; return; }
    const conf = tip.height - h + 1;
    setConf(conf);
    const okTo = String(tx.to) === to;
    let okAmt = false;
    try { okAmt = String(txAmountToAtomic(tx.amount)) === String(expectAtomic); } catch { okAmt = false; }
    const paid = okTo && okAmt && conf >= DEPTH;
    $('cOut').innerHTML = '<div class="kv"><span>высота / подтверждения</span><b>' + esc(h) + ' · ' + esc(conf) + ' / ' + DEPTH + '</b></div>'
      + '<div class="kv"><span>получатель</span><b class="' + (okTo ? 'good' : 'err') + '">' + (okTo ? 'совпал' : 'НЕ совпал') + '</b></div>'
      + '<div class="kv"><span>сумма</span><b class="' + (okAmt ? 'good' : 'err') + '">' + (okAmt ? 'совпала' : 'НЕ совпала') + '</b></div>'
      + '<div class="kv"><span>оплачено</span><b class="' + (paid ? 'good' : '') + '">' + paid + '</b></div>';
    if (paid) { stopPoll(); boom(10); }
    else startPoll();
    renderWatch();
  } catch (err) { $('cOut').textContent = 'сверка недоступна: ' + String(err.message || err); }
}
function startPoll() {
  stopPoll();
  if (!$('cAuto') || !$('cAuto').checked) return;
  pollTimer = setTimeout(checkStatus, 15000);
}
function stopPoll() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } }
$('cForm').addEventListener('submit', (e) => { e.preventDefault(); stopPoll(); checkStatus(); });
if ($('cDemo')) $('cDemo').addEventListener('click', async () => {
  if (!NET_OK) { $('cOut').textContent = 'отказ: сеть не сверена — дождитесь синхронизации.'; return; }
  $('cOut').textContent = 'беру настоящий перевод из последнего блока…';
  try {
    const r = await jget('/blocks?n=1');
    const txs = ((r.data.blocks || [])[0] || {}).txs || [];
    const tx = txs.find((t) => t && t.txid && t.from !== 'COINBASE') || txs[0];
    if (!tx || !tx.txid) { $('cOut').textContent = 'в последнем блоке переводов нет — попробуйте позже.'; return; }
    $('cTxid').value = tx.txid;
    if (tx.to) $('cTo').value = String(tx.to);
    try { $('cAmt').value = String(txAmountToAtomic(tx.amount)); } catch { $('cAmt').value = ''; }
    stopPoll(); checkStatus();
  } catch (err) { $('cOut').textContent = 'не удалось взять пример: ' + String(err.message || err); }
});
if ($('cAuto')) $('cAuto').addEventListener('change', () => { if (!$('cAuto').checked) stopPoll(); });

// --- шаги-подсветка при прокрутке ---
const stepLinks = Array.from(document.querySelectorAll('.steps a'));
const secs = stepLinks.map((a) => document.getElementById(a.dataset.step)).filter(Boolean);
if ('IntersectionObserver' in window && secs.length) {
  const io = new IntersectionObserver((es) => {
    for (const en of es) {
      if (en.isIntersecting) {
        stepLinks.forEach((a) => a.classList.toggle('on', a.dataset.step === en.target.id));
      }
    }
  }, { rootMargin: '-40% 0px -55% 0px' });
  secs.forEach((s) => io.observe(s));
}

$('netRetry').addEventListener('click', () => boot(false));
renderWatch();
boot(false);
netTimer = setInterval(() => boot(true), 30000);
