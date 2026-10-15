/* ============================================================
   TREASURY — ончейн-мультисиг 2-of-3 казны AGENTCOIN (AGIP-4).
   Состояние = чистая функция цепи (как gov.mjs): предложения и
   голоса — обычные ончейн tx с memo, локальных файлов нет.
   НЕ импортирует core.mjs (в core не циклится): здесь только
   парсинг memo и агрегирование; адресная проверка sig2Pub — в core.
   ============================================================ */
'use strict';

const REF_LEN = 8;
const YES_MIN = 3; // зеркало gov.mjs YES_MIN (копия без импорта — протокольная константа)
const ADDR_RE = /^AGT[A-Za-z0-9]+$/;

// Предложение: trs|K|<ref8>|<treasury>|<signer2>|<signer3>|<closesAtHeight>
export function parseTrsProposal(tx) {
  if (!tx || typeof tx.memo !== 'string' || !tx.memo.startsWith('trs|K|')) return null;
  const p = tx.memo.split('|');
  if (p.length < 7) return null;
  const ref = String(p[2] || '');
  const treasury = String(p[3] || '');
  const s2 = String(p[4] || '');
  const s3 = String(p[5] || '');
  const closesAt = Number(p[6]);
  if (!/^[A-Za-z0-9]{8}$/.test(ref)) return null;
  if (!ADDR_RE.test(treasury) || !ADDR_RE.test(s2) || !ADDR_RE.test(s3)) return null;
  const uniq = new Set([treasury, s2, s3]);
  if (uniq.size !== 3) return null; // три разных адреса
  if (!Number.isFinite(closesAt) || closesAt <= 0) return null;
  return { ref, treasury, signer2: s2, signer3: s3, closesAt, from: tx.from, height: null };
}

export function treasuryState(bcOrChain) {
  const chain = Array.isArray(bcOrChain) ? bcOrChain : bcOrChain.chain;
  const props = new Map();   // ref → proposal
  const tallies = new Map(); // ref → Map(address → choice)
  for (let hh = 0; hh < chain.length; hh++) {
    const txs = chain[hh].txs || [];
    for (const tx of txs) {
      if (!tx || typeof tx.memo !== 'string') continue;
      const prop = parseTrsProposal(tx);
      if (prop) {
        if (props.has(prop.ref)) continue; // ref одноразов
        prop.height = hh;
        props.set(prop.ref, prop);
        if (!tallies.has(prop.ref)) tallies.set(prop.ref, new Map());
        continue;
      }
      // голос — штатная gov-схема
      if (tx.memo.startsWith('gov|V|')) {
        const p = tx.memo.split('|');
        if (p.length < 4) continue;
        const ref = String(p[2] || '');
        const choice = ['yes', 'no', 'abstain'].includes(p[3]) ? p[3] : null;
        if (!choice || !tallies.has(ref)) continue; // голос без предложения игнор
        const prop2 = props.get(ref);
        if (!prop2 || hh > prop2.closesAt) continue;   // окно закрыто
        const perAddr = tallies.get(ref);
        if (perAddr.has(tx.from)) continue;            // первый голос адреса фиксируется
        perAddr.set(tx.from, choice);
      }
    }
  }
  const height = chain.length;
  const list = [...props.values()].map(prop => {
    const vs = [...tallies.get(prop.ref).values()];
    const yes = vs.filter(v => v === 'yes').length;
    const no = vs.filter(v => v === 'no').length;
    const abstain = vs.filter(v => v === 'abstain').length;
    const closed = height > prop.closesAt;
    const passed = closed && yes > no && yes >= YES_MIN;
    return { ref: prop.ref, treasury: prop.treasury, signer2: prop.signer2, signer3: prop.signer3, closesAt: prop.closesAt, height: prop.height, author: prop.from, yes, no, abstain, closed, passed, result: closed ? (passed ? 'passed' : 'rejected') : 'voting' };
  }).sort((a, b) => b.height - a.height);
  const lastPassed = list.find(x => x.passed);
  const policy = lastPassed
    ? { treasury: lastPassed.treasury, signers: [lastPassed.signer2, lastPassed.signer3], requires: 2, ref: lastPassed.ref }
    : null;
  return { height, yesMin: YES_MIN, requires: 2, policy, proposals: list };
}

// Для Blockchain: кэширующая обёртка — политика меняется только с высотой
export function makeTreasuryPolicyFn(bc) {
  let cacheH = -1, cacheP = null;
  return () => {
    const h = bc.blockCount();
    if (h !== cacheH) { cacheH = h; cacheP = treasuryState(bc.chain).policy; }
    return cacheP;
  };
}
