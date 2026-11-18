/* site/ecosphere/mainnet.js — внешний модуль страницы Settlement (v0.3).
 * Строгие деньги без Number*1e9: decimal→BigInt через точный парсер, лишние знаки — отказ.
 * Отправка недоступна до успешной сверки сети (boot ok) и проверки Content-Type.
 */
const API = new URLSearchParams(location.search).get('api') || location.origin;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let NET_OK = false;

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

function txAmountToAtomic(amount) {
  // amount из подписанной tx: number|string decimal. Строго, без Math.round.
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

async function boot() {
  setGated(true);
  try {
    const [info, life] = await Promise.all([jget('/info'), jget('/life')]);
    const tip = await jget('/blocks?n=1');
    const tb = (tip.data.blocks || [])[0] || {};
    const ok = info.data.chainId === 'AGENTCOIN'
      && String(info.data.genesisHash).toLowerCase() === '00026d18205c7c873bd612d6e2480321171eb0cb0b3d06c2c2cb0b17b9188e4e'
      && info.data.blocks === life.data.blocks && tb.height === life.data.blocks - 1
      && life.data.tipHash === tb.hash && life.data.fresh === true && life.data.chainValid === true;
    $('mChain').textContent = info.data.chainId;
    $('mGenesis').textContent = String(info.data.genesisHash).slice(0, 18) + '…';
    $('mBlocks').textContent = info.data.blocks;
    $('mSync').textContent = ok ? 'синхронизировано' : 'РАСХОЖДЕНИЕ — см. ниже';
    $('netOut').innerHTML = '<div>высота info/life: ' + esc(info.data.blocks) + '/' + esc(life.data.blocks) + ' · вершина life/блок: ' + esc(String(life.data.tipHash).slice(0, 12)) + '…/' + esc(String(tb.hash).slice(0, 12)) + '… · возраст вершины: ' + esc(life.data.tipAgeSec) + ' с · chainValid: ' + esc(String(life.data.chainValid)) + '</div>';
    NET_OK = ok === true;
    setGated(!NET_OK, ok ? 'синхронизировано' : 'РАСХОЖДЕНИЕ — отправка заблокирована');
    if (!ok) $('netOut').innerHTML += '<div><b>Отправка заблокирована: сеть не сверена.</b></div>';
  } catch (e) { $('mSync').textContent = 'нет связи'; $('netOut').textContent = String(e.message || e); setGated(true); }
}

$('bForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!NET_OK) { $('bOut').textContent = 'отказ: сеть не сверена — дождитесь синхронизации.'; return; }
  try {
    const r = await jpost('/balance', { address: $('bAddr').value.trim() });
    // Баланс ноды — float: показываем как приближение, не используем как сумму заказа.
    $('bOut').innerHTML = 'баланс (приближение из float ноды): <b>' + esc(String(r.data.balance)) + '</b> AGT · резерв: ' + esc(String(r.data.reserve)) + ' · точная сумма — только в подписанной tx';
  } catch (err) { $('bOut').textContent = 'отказ: ' + String(err.message || err); }
});
$('pForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const amt = parseAtomicStrict($('pAmt').value);
    $('pOut').innerHTML = '<div>заказ ' + esc($('pOrder').value) + ' · ' + esc($('pPayer').value) + ' → ' + esc($('pTo').value) + '<br>сумма <b>' + esc(String(amt)) + '</b> atomic · комиссия 0<br><span class="dim">прямой перевод, без удержания. Проверьте получателя и сумму до подписи.</span></div>';
  } catch (err) { $('pOut').textContent = 'отказ: ' + String(err.message || err); }
});
$('sForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!NET_OK) { $('sOut').textContent = 'отказ: сеть не сверена — отправка заблокирована.'; return; }
  let tx;
  try { tx = JSON.parse($('sTx').value); } catch { $('sOut').textContent = 'отказ: не JSON'; return; }
  const rawLow = JSON.stringify(tx).toLowerCase();
  const flat = rawLow.replace(/[^a-z]/g, '');
  if (/privkey|privatekey|mnemonic|seedphrase/.test(flat)) { $('sOut').textContent = 'отказ: похоже на приватный ключ — сюда только подписанную tx'; return; }
  const errs = [];
  if (String(tx.from) !== $('sPayer').value.trim()) errs.push('отправитель ≠ плательщик заказа');
  if (String(tx.to) !== $('sTo').value.trim()) errs.push('получатель ≠ исполнитель заказа');
  try {
    const txAtomic = txAmountToAtomic(tx.amount);
    if (String(txAtomic) !== $('sAmt').value.trim()) errs.push('сумма ≠ сумма заказа');
  } catch { errs.push('сумма tx не разбирается строго — подпись обязана содержать точную decimal-сумму'); }
  if (typeof tx.signature !== 'string' || !tx.signature) errs.push('нет signature — подпишите локально у владельца');
  if (errs.length) { $('sOut').innerHTML = 'отказ без отправки:<br>' + errs.map((x) => '· ' + esc(x)).join('<br>'); return; }
  try {
    const r = await jpost('/tx', tx);
    $('sOut').innerHTML = r.status === 201
      ? 'принято нодой (mempool ' + esc(JSON.stringify(r.data)) + '). Статус — по пруфу ниже, после потери ответа — сверка.'
      : 'отказ ноды (' + r.status + '): ' + esc(r.data.error || r.data.reason || '?') + ' — это отказ платежа, повтор — теми же байтами после сверки.';
  } catch (err) { $('sOut').textContent = 'ответ потерян: состояние неизвестно — сверьтесь по txid ниже, не отправляйте другую подпись.'; }
});
$('cForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!NET_OK) { $('cOut').textContent = 'отказ: сеть не сверена — проверка заблокирована.'; return; }
  const txid = $('cTxid').value.trim(), to = $('cTo').value.trim(), amt = $('cAmt').value.trim();
  let expectAtomic;
  try { expectAtomic = parseAtomicStrict(amt); }
  catch (err) { $('cOut').textContent = 'отказ: сумма сверки обязана быть целыми atomic: ' + String(err.message || err); return; }
  try {
    const proof = await jget('/api/v1/txproof/' + encodeURIComponent(txid));
    if (proof.status !== 200 || typeof proof.data.height !== 'number') { $('cOut').textContent = 'в цепи нет (пруф отсутствует). Проверьте mempool/повторите позже.'; return; }
    const h = proof.data.height;
    const [slice, tipW] = await Promise.all([jget('/blocks?from=' + h + '&limit=1'), jget('/blocks?n=1')]);
    const block = (slice.data.blocks || [])[0];
    const tx = (block && block.txs || []).find((t) => t && t.txid === txid);
    if (!tx) { $('cOut').textContent = 'пруф есть, тела нет — нужна повторная сверка.'; return; }
    const tip = (tipW.data.blocks || [])[0];
    const conf = tip.height - h + 1;
    const okTo = String(tx.to) === to;
    let okAmt = false;
    try { okAmt = String(txAmountToAtomic(tx.amount)) === String(expectAtomic); } catch { okAmt = false; }
    const paid = okTo && okAmt && conf >= 6;
    $('cOut').innerHTML = 'высота ' + esc(h) + ' · подтверждений ' + esc(conf) + ' · получатель ' + (okTo ? 'совпал' : '<b>НЕ совпал</b>') + ' · сумма ' + (okAmt ? 'совпала' : '<b>НЕ совпала</b>') + ' · оплачено: <b>' + paid + '</b>';
  } catch (err) { $('cOut').textContent = 'сверка недоступна: ' + String(err.message || err); }
});
boot();
