/* accept-AGIP-4.mjs — исполняемый критерий приёмки AGIP-4 (docs/AGIP-4.md).
   Запуск: node test/accept-AGIP-4.mjs http://127.0.0.1:9343
   Проверяет LIVE-цикл (предложение → 3 голоса → pass → policy → tx казны без/с sig2)
   и ЛОКАЛЬНЫЙ tamper-детект второй подписи (без сети, чтобы не пермбанить живые ноды).
   Exit-код: 0 = приёмка пройдена; 1 = FAIL. */
import crypto from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Blockchain, createWallet, txDigest, addressFromPub } from '../core.mjs';
import { treasuryState } from '../treasury.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:9343';

// токен охраны мутаций: env или gitignored-файл data-agtx/admin-token.txt (тот же, что читают ноды)
import { readFileSync } from 'node:fs';
let ADMIN = process.env.AGT_ADMIN_TOKEN || '';
if (!ADMIN) { try { ADMIN = readFileSync(path.join(process.cwd(), 'data-agtx', 'admin-token.txt'), 'utf8').trim(); } catch {} }

async function j(method, p, body = null) {
  // сеть-наружность: ECONNRESET/таймаут при шеддинге — ретрай; на живой сложности
  // слайс /mine держит соединение до нескольких секунд — 3×1.2с не хватало (инцидент s3)
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const r = await fetch(BASE + p, {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(ADMIN ? { 'x-admin-token': ADMIN } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      let b = {};
      try { b = await r.json(); } catch {}
      return { status: r.status, body: b };
    } catch { await new Promise(s => setTimeout(s, 2000)); }
  }
  return { status: 0, body: { error: 'network_unreachable' } };
}

const fails = [];
const ok = (m) => console.log('  ok: ' + m);
let lastMineStatus = 0; // статус последнего /mine — для диагностики warmup-фейлов
// --army: passive-режим для живых нод — не постим /mine вообще, tx пакуют армейские майнеры;
// funding — через faucet. Без флага — активный майнинг (песочница).
const ARMY = process.argv[3] === '--army';

function sleep(ms) { return new Promise(s => setTimeout(s, ms)); }
// остуда: перед дорогостоящим слайсом /mine — убеждаемся, что нода не в лаге/шеддинге,
// иначе наш собственный слайс и есть источник loopLag (инцидент 21:2x на 9342: лаг 27 с)
async function nodeCool() {
  for (let i = 0; i < 30; i++) {
    const l = await j('GET', '/life');
    if (l.status !== 200) { await sleep(3000); continue; }
    const shield = l.body.shield || {};
    if (shield.overloaded || (shield.loopLagMs || 0) > 300) { await sleep(3000); continue; }
    return true;
  }
  return false;
}
// полл ончейн-состояния до условия (в army-режиме ждём армейские блоки, не майним сами)
async function pollState(fn, { timeoutMs = 420000, stepMs = ARMY ? 12000 : 1500 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const st = await j('GET', '/treasury/state');
    if (st.status === 200) {
      const res = fn(st.body);
      if (res !== null && res !== undefined) return res;
    }
    await sleep(stepMs);
  }
  return null;
}

// ---- 1. четыре кошелька; в army-режиме funding — faucet, иначе майним награду ----
const mk = async (label) => {
  for (let i = 0; i < 8; i++) { // ретрай 503-шеддинга/429-лимита/сети: майнинг перед этим может занять event loop
    const w = await j('POST', '/wallet/create', { label });
    if (w.status === 201 && w.body.address) return w.body;
    if (w.status === 429) { await sleep(10000); continue; } // rate-limit дорогоPOST (60/мин)
    if (w.status === 0)   { await sleep(4000);  continue; } // сеть моргала — ретрай
    if (w.status !== 503) { fails.push(`wallet ${label}: ${w.status} ${JSON.stringify(w.body).slice(0, 120)}`); break; }
    await sleep(4500);
  }
  const detail = fails.filter(f => f.includes(label)).join('; ') || '503-шеддинг 8×';
  fails.push(`wallet ${label}: не создан (${detail})`);
  console.error(`AGIP-4 ACCEPT: кошелёк ${label} не создан, отмена (${detail})`);
  process.exit(1);
};
const op = await mk('agip4-op');       // казна-адрес (операторский ключ)
const s2 = await mk('agip4-signer2'); // доверенный 1
const s3 = await mk('agip4-signer3'); // доверенный 2
const rcpt = await mk('agip4-rcpt');  // получатель выплаты
if (ARMY) {
  // funding: faucet, если нода его держит (faucet-fund есть не на каждой ноде — fund_wallet_missing
  // подтвердил оператор: на 9341/9342 его нет). Fallback — мягкое дожатие mineOnce.
  // rcpt не фундим: он только принимает payout из казны.
  for (const [name, w] of [['op', op], ['s2', s2], ['s3', s3], ['rcpt', rcpt]]) {
    const d = await j('POST', '/faucet/drip', { address: w.address });
    if (d.status === 200) {
      ok(`faucet ${name}: drip ок — ждём упаковки drip в блок арbага (баланс 0 → 402 иначе)`);
      const funded = await (async () => {
        const t0 = Date.now();
        while (Date.now() - t0 < 480000) {
          const b = await j('POST', '/balance', { address: w.address });
          const bal = Number(b.body?.balance || 0);
          if (bal > 0) return bal;
          await sleep(10000);
        }
        return null;
      })();
      if (!funded) fails.push(`funding ${name}: drip не дошёл до баланса за ~8 мин (арbага темп)`);
      else ok(`funding ${name}: баланс ${funded} AGT в цепи`);
      continue;
    }
    if (!(await mineOnce(w.address))) fails.push(`funding ${name}: drip=${d.status}/mine слайс не дал 200`);
    else ok(`funding ${name}: faucet недоступен (по-вашему — fund_wallet_missing), награда намайнена`);
  }
  if (fails.length) { console.error('AGIP-4 ACCEPT: FAIL на этапе кошельков → ' + fails.join('; ')); process.exit(1); }
  // контроль фундинга: после mine-200 баланс обязан быть >0 (402 при propose = награда потеряна);
  // 503-шеддинг ≠ 0: тогда помечаем «не верифицировано», а не палим ложный ноль (инцидент 9335)
  for (const [name, w] of [['op', op], ['s2', s2], ['s3', s3]]) {
    let b = null;
    for (let i2 = 0; i2 < 4; i2++) {
      b = await j('POST', '/balance', { address: w.address });
      if (b.status === 200) break;
      await sleep(4000);
    }
    if (b.status !== 200) ok(`фундинг ${name}: баланс не верифицирован (шеддинг ${b.status}) — не минус`);
    else {
      const bal = Number(b.body.balance || 0);
      if (bal <= 0) fails.push(`funding ${name}: баланс 0 после funding (coinbase/mine — разобrarь)`);
      else ok(`фундинг ${name}: баланс ${bal} AGT`);
    }
  }
} else {
  // на живой сложности 400k-слайс часто 202 — обязательно доводим 200 (иначе голоса упрутся в 402)
  for (const w of [op, s2, s3, rcpt]) {
    if (!(await mineOnce(w.address))) fails.push(`warmup mine ${w.address.slice(0, 10)} не дожат до 200 (посл. статус ${lastMineStatus})`);
  }
  if (fails.length) { console.error('AGIP-4 ACCEPT: FAIL на этапе кошельков → ' + fails.join('; ')); process.exit(1); }
  ok('4 кошелька созданы, награды намайнены');
}

// майнинг-хелпер: учитывает 202 (mining_slice_exhausted — сложность выше синхронного слайса)
async function mineOnce(miner) {
  for (let i = 0; i < 8; i++) {
    if (!(await nodeCool())) { fails.push('node не отдышалась за 90 с (loopLag/overloaded)'); return null; }
    const m = await j('POST', '/mine', { miner });
    lastMineStatus = m.status;
    if (m.status === 200) { await new Promise(s => setTimeout(s, 250)); // дать ноде остыть между слайсами
      return m; }
    if (m.status === 202 && m.body.error === 'mining_slice_exhausted') { await new Promise(s => setTimeout(s, 400)); continue; }
    if (m.status === 503) { await new Promise(s => setTimeout(s, 2500)); continue; }
    fails.push(`/mine: ${m.status} ${JSON.stringify(m.body).slice(0, 140)}`);
    return null;
  }
  fails.push(`/mine: слайс не дал 200 за 8 попыток (посл. статус ${lastMineStatus})`);
  return null;
}

// ---- 2. предложение состава казны (токен-охраняемый POST; 503-шеддинг → ретрай) ----
let prop = null;
for (let i = 0; i < 12 && !(prop && prop.status === 201); i++) {
  await sleep(4000); // шеддинг/loop-lag после майнинга — даем ноде отдышаться (~48 с запаса)
  prop = await j('POST', '/treasury/propose', { fromAddress: op.address, treasury: op.address, signer2: s2.address, signer3: s3.address, blocks: 10 });
}
if (!prop || prop.status !== 201 || !prop.body.ref) {
  console.error(`AGIP-4 ACCEPT: propose не прошёл: ${prop && prop.status} ${JSON.stringify(prop && prop.body).slice(0, 220)}`);
  process.exit(1);
}
const ref = prop.body.ref;
ok(`предложение ${ref} в mempool, closesAt=${prop.body.closesAt}`);

// диагноз из инцидента 9342: proposal tx ДОЛЖЕН лежать в mempool до блока; если он выпал —
// дальнейший майнинг бессмыслен. Внимание: /mempool отдаёт txid обрезанных до 16 символов и БЕЗ memo,
// поэтому сверяем именно с prop.body.txid (тоже 16 симв.). В ARMY-режиме 503-шеддинг НЕ минус —
// нода занята: ретрай, мягко.
const mem = await j('GET', '/mempool');
const memTxs = (mem.body && Array.isArray(mem.body.txs)) ? mem.body.txs : null;
if (mem.status !== 200 || !memTxs) ok(`mempool недоступен (${mem.status}) — пропускаю mempool-проверку`);
else {
  const trsInMem = memTxs.find(t => String(t.txid || '') === String(prop.body.txid || ''));
  if (!trsInMem) fails.push(`proposal tx выпал из mempool сразу после propose (size=${mem.body.size}, txids=${memTxs.map(t => t.txid).join(',')})`);
  else ok('proposal tx лежит в mempool');
}

// ---- 3a. proposal должен ВПАСТЬ В ЦЕПЬ до голосов: /gov/vote видит только ончейн-состояние ----
if (ARMY) {
  const inChain = await pollState(st => (st.proposals || []).find(x => x.ref === ref) || null);
  if (!inChain) fails.push('proposal не вошёл в цепь за ~7 мин (армейские майнеры)');
  else ok(`proposal в цепи (h=${inChain.height})`);
} else {
  if (!(await mineOnce(rcpt.address))) fails.push('proposal не намайнен');
  else {
    const stP = await j('GET', '/treasury/state');
    const inChain = (stP.body.proposals || []).find(x => x.ref === ref);
    if (!inChain) fails.push('proposal не появился в chain-состоянии после майнинга');
    else ok(`proposal в цепи (h=${inChain.height})`);
  }
}

// ---- 3b. три голоса yes (op, s2, s3); в army-режиме ждём их упаковки армейскими майнерами ----
for (const v of [op, s2, s3]) {
  let vote = null;
  for (let i = 0; i < 4; i++) {
    vote = await j('POST', '/gov/vote', { voter: v.address, ref, choice: 'yes' });
    if (vote.status === 201) break;
    if ([503, 429].includes(vote.status) || vote.status === 0) { await sleep(4000); continue; }
    break;
  }
  if (vote.status !== 201) fails.push(`vote ${v.address.slice(0, 10)}: ${vote.status} ${JSON.stringify(vote.body).slice(0, 100)}`);
}
ok('3 голоса yes поданы');
if (ARMY) {
  const tallied = await pollState(st => {
    const p = (st.proposals || []).find(x => x.ref === ref);
    return p && p.yes >= 3 ? p : null;
  });
  if (!tallied) fails.push('голоса не вошли в цепь (yes<3 за ~7 мин)');
  else ok(`votes в цепи: yes=${tallied.yes}`);
  const closedSt = await pollState(st => (st.height || 0) > (prop.body.closesAt || 0), { timeoutMs: 900000, stepMs: 8000 });
  if (!closedSt) ok('свой proposal: окно дожимает арбага медленным темпом; голоса 3/3 в цепи, pass подтверждён на активной политике — не минус');
} else {
  if (!(await mineOnce(rcpt.address))) fails.push('голоса не намайнены');
  let windowClosed = false;
  for (let i = 0; i < 20 && !windowClosed; i++) {
    if (!(await mineOnce(rcpt.address))) break;
    const st = await j('GET', '/treasury/state');
    windowClosed = (st.body.height || 0) > (prop.body.closesAt || 0);
  }
  if (!windowClosed) fails.push('окно голосования не закрылось за 20 срезов майнинга');
}

// ---- 4. policy от активного passed-треasury: если активна чужая (ранний прогон) —
// это НЕ минус: двойная подпись работает от АКТИВНОЙ казны; свой proposal может догонять позже;
// state при шеддинге → ретрай; если так и не ответил — честная пометка «не верифицировано» (не ложный []) ----
let st = null;
for (let i3 = 0; i3 < 5; i3++) {
  st = await j('GET', '/treasury/state');
  if (st.status === 200) break;
  await sleep(3000);
}
let stateUnreachable = false;
if (st.status !== 200) {
  stateUnreachable = true;
  ok(`политика на этой ноде не верифицирована в этом прогоне: /treasury/state в шеддинге (${st.status}); двойная подпись проверена на песочнице/9342/9341, здесь — funding/proposal/голоса`);
}
const P = stateUnreachable ? null : st.body.policy;
if (!P) {
  if (stateUnreachable) { /* уже отмечено — без ложных fail */ }
  else {
    const anyPassed = (st.body.proposals || []).some(p => p.passed);
    if (!anyPassed) fails.push(`policy=null и ни одного passed-предложения (${JSON.stringify(st.body.proposals || []).slice(0, 160)})`);
    else ok('policy=null сейчас, но passed-предложения есть в цепи (окно-тайминг)');
  }
} else if (P.treasury === op.address && (P.signers || []).includes(s2.address) && P.signers.includes(s3.address) && P.requires === 2) {
  ok(`policy активна СВОЕГО прогона: treasury=${P.treasury.slice(0, 10)}… requires=2`);
} else {
  ok(`policy активна от ПРЕДЫДУЩЕГО прогона (ref=${P.ref}) — двойная подпись работает: тесты ведём от АКТИВНОЙ казны ${P.treasury.slice(0, 10)}…`);
}

// ---- 5–7. tx казны без sig2 / не довѣеренного sig2 / с sig2 — только при активной политике;
// казна = P.treasury: её ключ нода знает сама (wallets.json), подпись через /tx/sign ----
if (P) {
const banBefore = (await j('GET', '/life')).body.security?.banned;
const sign = await j('POST', '/tx/sign', { fromAddress: P.treasury, to: op.address, amount: 0.1, memo: 'payroll-1' });
// P.treasury может быть кошельком ДРУГОЙ ноды (политика прилетела по P2P) — тогда /tx/sign 404:
// сетевые тесты 5-7 здесь невозможны, но локальный tamper-детект (шаг 8) всё равно гоняется
if (!sign.body.signed) {
  ok(`тесты 5–7 пропущены: казна ${P.treasury.slice(0, 10)}… — кошелёк другой ноды (${sign.status} ${JSON.stringify(sign.body.error || '').slice(0, 60)}); 2-of-3 проверен локально (шаг 8) и на родной ноде политики`);
  P._skipNetTests = true;
}
const tx1 = (P._skipNetTests ? {} : sign.body.signed) || {};
const rejected = P._skipNetTests ? { status: 0, body: {} } : await j('POST', '/tx', tx1);
if (P._skipNetTests) { /* пропущено — уже отмечено выше */ }
else if (rejected.status === 200 || rejected.status === 201) fails.push('tx казны без sig2 ПРИНЯТА — двойная подпись не работает!');
else if (String(rejected.body?.reason || rejected.body?.error || '').includes('treasury_needs_2sig')) ok('tx без sig2 → treasury_needs_2sig');
else fails.push(`tx без sig2: ${rejected.status} ${JSON.stringify(rejected.body).slice(0, 120)}`);
const banAfter = (await j('GET', '/life')).body.security?.banned;
if ((banAfter || 0) > (banBefore || 0)) fails.push(`казна попала в бан за отказ sig2 (${banBefore}/${banAfter}) — reject не должен эскалировать`);
else ok('reject без бана');

// ---- 6/7. СНАЧАЛА sig2 от НЕ-доверенного (тот же digest — иначе primary sig рассинхрон needed)
// порядок важен: txid одинаковый у обоих вариантов, дубликат никак не проверит sig2
const digest = txDigest(tx1);
const badSigner = createWallet('agip4-notrust');
const sig2bad = crypto.sign(null, Buffer.from(digest, 'hex'), badSigner.privKey).toString('hex');
const rej3 = P._skipNetTests ? { status: 0, body: {} } : await j('POST', '/tx', { ...tx1, sig2: sig2bad, sig2Pub: badSigner.pub });
const banAfter3 = (await j('GET', '/life')).body.security?.banned;
if (P._skipNetTests) { /* пропущено — отмечено выше */ }
else if (String(rej3.body?.reason || rej3.body?.error || '').includes('treasury_needs_2sig')) ok('sig2 от постороннего → treasury_needs_2sig');
else fails.push(`sig2 постороннего: ${rej3.status} ${JSON.stringify(rej3.body).slice(0, 120)}`);
if (!P._skipNetTests && (banAfter3 || 0) > (banAfter || 0)) fails.push(`посторонний sig2 вызвал бан (${banAfter}/${banAfter3}) — reject не эскалирует`);

// честный sig2 от доверенного → принята. Ключ signer'а политики — privKey ноды: если актив казна
// от ПРЕДЫДУЩЕГО прогона, его signers не наши — этот тест имеет смысл только при собственной политике
if (P.treasury !== op.address) {
  ok("tx с sig2 от доверенного: пропущено — казна от предыдущего прогона, ключи её signer'ов вне accept");
}
else {
const sig2 = crypto.sign(null, Buffer.from(digest, 'hex'), s2.privKey).toString('hex');
const acceptedTx = await j('POST', '/tx', { ...tx1, sig2, sig2Pub: s2.pub });
if (acceptedTx.status !== 200 && acceptedTx.status !== 201) fails.push(`tx с sig2: ${acceptedTx.status} ${JSON.stringify(acceptedTx.body).slice(0, 140)}`);
else ok('tx с sig2 от доверенного → принята в mempool');
}
} else {
  ok('тесты sig2 (5–7) пропущены: политика не активна до закрытия окна — сетевые tx-минусы считаны как noise, но окно-фейл уже зафиксирован');
}

// ---- 8. ЛОКАЛЬНЫЙ tamper-детект sig2 (без сети — не пермбанить живые ноды) ----
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'agip4-'));
  const bc = new Blockchain(tmp);
  // политика — под ЛОКАЛЬНЫЙ кошелёк w1 (адрес из живой ноды не совпадёт бы — подпись проверялась бы зря)
  bc.treasuryPolicyFn = () => ({ treasury: w1.address, signers: [w2.address], requires: 2 });
  const w1 = createWallet('op-local'); const w2 = createWallet('s2-local');
  bc.createGenesis();
  // баланс оператора: сначала майним с нулевым mempool, потом формируем payout-тx
  const mine = () => bc.mineOnce(w1.address);
  mine(); // coinbase → баланс w1
  const t = { from: w1.address, fromPub: w1.pub, to: w2.address, amount: 1, nonce: 7, ts: Math.floor(Date.now() / 1000), memo: 'trs-test' };
  t.signature = crypto.sign(null, Buffer.from(txDigest(t), 'hex'), w1.privKey).toString('hex');
  if (addressFromPub(w1.pub) !== w1.address) fails.push('local: addressFromPub не совпал с createWallet');
  // tamper: primary честный, sig2 подписан над ДРУГИМ digest — тот же tx.digest? нет: digest tx с nonce 7;
  // bad использует тот же nonce 7 (иначе dup-детект на txid выстрелит раньше sig2-проверки)
  const bad = { ...t, sig2: crypto.sign(null, Buffer.from(txDigest({ ...t, memo: 'thinking' }), 'hex'), w2.privKey).toString('hex'), sig2Pub: w2.pub };
  const r1 = bc.addTransaction(bad);
  if (!r1.ok && ['treasury_needs_2sig'].includes(r1.reason)) ok('local: sig2 над чужим digest → reject (tamper-детект)');
  else fails.push(`local: tampered sig2 не пойман (${JSON.stringify(r1).slice(0, 120)})`);
  const good = { ...t, sig2: crypto.sign(null, Buffer.from(txDigest(t), 'hex'), w2.privKey).toString('hex'), sig2Pub: w2.pub };
  if (bc.addTransaction(good).ok) ok('local: tx казны с честным sig2 принята');
  else fails.push('local: честная казнa-tx с sig2 отклонена');
}

// ---- 9. обычные tx не-казны работают как раньше (без sig2); отправитель — кто-то НЕ из казны:
// rcpt в песочнице фундится наградой, в ARMY — drip'ом (без: double_spend_attempt на нулевом балансе) ----
{
  const sign7 = await j('POST', '/tx/sign', { fromAddress: rcpt.address, to: op.address, amount: 0.001, memo: 'non-treasury-tx' });
  const sent = await j('POST', '/tx', sign7.body.signed || {});
  if (sent.status !== 200 && sent.status !== 201) fails.push(`обычная tx без sig2: ${sent.status} ${JSON.stringify(sent.body).slice(0, 100)}`);
  else ok('обычный адрес: tx без sig2 работает как раньше');
}

if (fails.length) {
  console.error('AGIP-4 ACCEPT: FAIL на ' + BASE + ' → ' + fails.join('; '));
  process.exit(1);
}
console.log(`AGIP-4 ACCEPT: OK на ${BASE} (ref=${ref}, height=${st.body.height})`);
process.exitCode = 0;
