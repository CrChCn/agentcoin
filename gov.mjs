#!/usr/bin/env node
/* ============================================================
   GOV — governance ноды AGENTCOIN (v1).
   Идея как в DXE: предложения и голоса = ончейн tx с memo —
   состояние = чистая функция цепи ⇒ одинаково на всех нодах,
   без локальных файлов и синков.

   Протокол memo:
     gov|P|<ref8>|<closesAtHeight>|<title (без '|', ≤60)>   — предложение
                                                             (amount = депозит 0.1 AGT, право на окно)
     gov|V|<ref8>|<yes|no|abstain>                           — голос (amount=0)
   Правила (Decred/Tezos-примитивы, минимально):
     • один адрес — один голос: первый валидный голос адреса фиксируется,
       повторный игнорируется (идемпотентность по address);
     • окно голосования — блоки: голосование после closesAtHeight не считается;
     • результат: passed = yes > no И yes >= YES_MIN (пороги видимы в сети);
     • Sybil-честность: «один адрес = один голос» защищает только от
       двойного голоса одного адреса, не от множества адресов —
       это честно задаётся протокольной плашкой в /gov/state.sybilNote.
   • Депозит charitable: сумму /gov/dreposit идут в облачный фонд.
   ============================================================ */
'use strict';
import crypto from 'node:crypto';

const REF_LEN = 8;
const TITLE_MAX = 60;
export const PROP_DEPOSIT = 0.1; // AGT, спишется как tx amount на fund-адрес? v1: amount>=0.1 на security-фонд (см. правила ниже)
export const YES_MIN = 3;        // минимум yes для pass
export const COOLDOWN_BLOCK = 0; // v1: активация сразу в UI (exchange-интеграция — следующий шаг)

function txKey(tx) {
  return crypto.createHash('sha256').update(`${tx.from}|${tx.nonce}|${tx.memo}`).digest('hex').slice(0, 12);
}
function validRef(r) { return /^[A-Za-z0-9]{8}$/.test(r); }
function sanitize(s) { return String(s || '').replace(/[|\r\n]/g, ' ').trim().slice(0, TITLE_MAX); }

export function parseGov(tx) {
  if (!tx || typeof tx.memo !== 'string' || !tx.memo.startsWith('gov|')) return null;
  const parts = tx.memo.split('|');
  if (parts[1] === 'P') {
    const ref = String(parts[2] || '');
    const closesAt = Number(parts[3]);
    const title = sanitize(parts[4]); // части после 4 — допустимо слить обратно
    const extra = parts.slice(5).join(' ');
    if (!validRef(ref)) return null;
    if (!isFinite(closesAt) || closesAt <= 0) return null;
    if (!title) return null;
    return { type: 'proposal', ref, closesAt, title: (title + (extra ? ' ' + sanitize(extra) : '')).slice(0, TITLE_MAX + 20), key: txKey(tx), from: tx.from, amount: Number(tx.amount) || 0, ts: tx.ts };
  }
  if (parts[1] === 'V') {
    const ref = String(parts[2] || '');
    const choice = ['yes', 'no', 'abstain'].includes(parts[3]) ? parts[3] : null;
    if (!validRef(ref) || !choice) return null;
    return { type: 'vote', ref, choice, key: txKey(tx), from: tx.from, amount: Number(tx.amount) || 0, ts: tx.ts };
  }
  return null;
}

let cacheHeight = -1, cacheVal = null;
export function govState(bc) {
  const h = bc.blockCount();
  if (cacheHeight === h && cacheVal) return cacheVal;
  const props = new Map();      // ref → proposal
  const tallies = new Map();    // ref → Map(address → голос)
  // Обычные for-of циклы вместо forEach с замыканием: в замыкании tallies
  // ловился ReferenceError при редких гонках (одно-процессный HTTP handler),
  // последовательный обход безопасен (инцидент: guard unhandledReJECTION
  // «tallies is not defined at govState» в log-node3.txt).
  for (const blk of bc.chain) {
      const hh = blk.height;
      for (const tx of (blk.txs || [])) {
        const p = parseGov(tx);
        if (!p) continue;
        if (p.type === 'proposal') {
          if (props.has(p.ref) || tallies.has(p.ref)) continue; // ref одноразов
          tallies.set(p.ref, new Map());
          props.set(p.ref, { ...p, height: hh });
        } else if (p.type === 'vote') {
          const prop = props.get(p.ref);
          if (!prop) continue;
          if (hh > prop.closesAt) continue; // окно закрыто
          const perAddr = tallies.get(p.ref);
          if (perAddr.has(p.from)) continue;         // первый голос адреса фиксируется
          perAddr.set(p.from, { choice: p.choice, height: hh, key: p.key });
        }
      }
  }
  const height = bc.blockCount();
  const list = [...props.values()].map(prop => {
    const vs = [...tallies.get(prop.ref).values()];
    const yes = vs.filter(v => v.choice === 'yes').length;
    const no = vs.filter(v => v.choice === 'no').length;
    const abstain = vs.filter(v => v.choice === 'abstain').length;
    const closed = height > prop.closesAt;
    const active = !closed;
    const passed = closed && yes > no && yes >= YES_MIN;
    return {
      ref: prop.ref, title: prop.title, author: prop.from,
      closesAt: prop.closesAt, height: prop.height,
      yes, no, abstain, closed, active, passed,
      result: closed ? (passed ? 'passed' : 'rejected') : 'voting',
    };
  }).sort((a, b) => b.height - a.height);
  cacheHeight = h;
  cacheVal = { height, refSeed: REF_LEN, yesMin: YES_MIN, proposals: list, sybilNote: 'один адрес = один голос: защищает от двойного голоса, не от множества адресов (Sybil) — см. плашку в UI' };
  return cacheVal;
}

export function newRef() {
  return crypto.randomBytes(6).toString('base64url').replace(/[^A-Za-z0-9]/g, '').padEnd(REF_LEN, '0').slice(0, REF_LEN);
}
