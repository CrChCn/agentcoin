#!/usr/bin/env node
/* Этап D (ТЗ §9–§11): делегирование с бюджетом и глубиной, независимый
   reviewer и спор.
   Проверяем: подрядчик нанимается только в рамках остатка бюджета родителя;
   глубина вложенности ограничена; цикл найма запрещён; отзыв даёт только
   независимый агент и только по сданному артефакту; спор замораживает расчёт
   и решается арбитром, который не сторона и не ревьюер; состояние переживает
   рестарт. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createStand } from '../sdk/js/stand-server.mjs';
import { makeClient } from '../sdk/js/agentcoin-sdk.mjs';
import { addressFromPub } from '../core.mjs';

let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { c ? pass++ : fail++; console.log((c ? 'PASS  ' : 'FAIL  ') + name + (extra ? ' — ' + extra : '')); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agtdlg-'));
let stand = await createStand(tmp);
const J = (n) => path.join(tmp, n + '.json');
const mk = (name) => {
  const k = crypto.generateKeyPairSync('ed25519');
  const pub = k.publicKey.export({ type: 'spki', format: 'pem' });
  const addr = addressFromPub(pub);
  const w = path.join(tmp, name + '.wallet.json');
  fs.writeFileSync(w, JSON.stringify({ address: addr, public_key_pem: pub, privateKeyPem: k.privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
  return { addr, w };
};
const A = mk('customer'), B = mk('agency'), C = mk('sub1'), D = mk('sub2'), E = mk('reviewer'), F = mk('arbiter');
const client = (o, tag) => makeClient({ node: stand.url, address: o.addr, walletFile: o.w, journalFile: J(tag) });
const cA = client(A, 'a'), cB = client(B, 'b'), cC = client(C, 'c'), cD = client(D, 'd'), cE = client(E, 'e'), cF = client(F, 'f');

const offerFor = (id, addr) => ({
  offerId: id, version: '1', provider: addr, title: 'Проверка API: статус и хеш тела',
  skills: ['api-check'], acceptedInputFormats: ['application/json'], producedOutputFormats: ['application/json'],
  inputSchema: { url: 'string' }, outputSchema: { status: 'number' },
  acceptance: { method: 'human', rules: 'customer compares status' },
  priceAtomic: 1000, expiresAt: Date.now() + 3_600_000, license: 'result-research-only', deadline: '24h', limits: 'stand only',
});

// 1. каталог: три независимых поставщика
{
  const r1 = await cB.publishOffer(B.addr, offerFor('off-b', B.addr));
  const r2 = await cC.publishOffer(C.addr, offerFor('off-c', C.addr));
  const r3 = await cD.publishOffer(D.addr, offerFor('off-d', D.addr));
  ok(r1.ok && r2.ok && r3.ok, 'три поставщика опубликовали предложения');
}

// 2. корневой заказ: глубина 0, бюджет = цена
let root, child1, child2;
{
  const r = await cA.createOrder(A.addr, 'off-b', { url: 'https://x' }, 'root-1');
  root = r.result.assignment;
  ok(r.ok && root.delegation?.depth === 0 && root.delegation.budgetAtomic === 1000,
    'корень цепочки: глубина 0, бюджет 1000', JSON.stringify(root.delegation || null));
}

// 3. делегирование: бюджет резервируется, глубина растёт
{
  const r1 = await cB.delegateOrder(B.addr, root.assignmentId, { offerId: 'off-c', budgetAtomic: 600, idempotencyKey: 'd1' });
  child1 = r1.result?.assignment;
  ok(r1.ok && child1?.delegation?.depth === 1 && child1?.delegation?.budgetAtomic === 600,
    'B нанял C: глубина 1, бюджет 600', r1.error || '');
  const p = await cA.getOrder(root.assignmentId, A.addr);
  ok(p.assignment.delegation.committedAtomic === 600, 'бюджет родителя зарезервирован (600), деньги не двигались');

  const r2 = await cC.delegateOrder(C.addr, child1.assignmentId, { offerId: 'off-d', budgetAtomic: 300, idempotencyKey: 'd2' });
  child2 = r2.result?.assignment;
  ok(r2.ok && child2?.delegation?.depth === 2 && child2?.delegation?.rootId === root.assignmentId,
    'C нанял D: глубина 2, тот же корень', r2.error || '');
  const mid = await cB.getOrder(child1.assignmentId, B.addr);
  ok(mid.assignment.delegation.committedAtomic === 300, 'резерв фиксируется на каждом уровне, а не только на корне');
}

// 4. границы: бюджет, глубина, самонейм, цикл, чужой
{
  const over = await cB.delegateOrder(B.addr, root.assignmentId, { offerId: 'off-d', budgetAtomic: 500, idempotencyKey: 'd3' });
  ok(over.ok === false && over.error === 'budget_exceeded', 'бюджет сверх остатка родителя отвергнут', over.error || '');

  // maxDepth ограничивает вложенность относительно самого вызова: у child1 (depth 1)
  // ребёнок был бы depth 2 > 1.
  const deep = await cC.delegateOrder(C.addr, child1.assignmentId, { offerId: 'off-d', budgetAtomic: 100, maxDepth: 1, idempotencyKey: 'd4' });
  ok(deep.ok === false && deep.error === 'depth_exceeded', 'предел глубины (maxDepth=1) отвергает вложенность 2', `${deep.error} ${JSON.stringify(deep.detail || '')}`);

  const self = await cC.delegateOrder(C.addr, child1.assignmentId, { offerId: 'off-c', budgetAtomic: 50, idempotencyKey: 'd5' });
  ok(self.ok === false && self.error === 'self_delegation', 'нельзя нанять самого себя', self.error || '');

  const cyc = await cD.delegateOrder(D.addr, child2.assignmentId, { offerId: 'off-b', budgetAtomic: 50, idempotencyKey: 'd6' });
  ok(cyc.ok === false && cyc.error === 'delegation_cycle', 'цикл найма (D→B) отвергнут', cyc.error || '');

  const foreign = await cE.delegateOrder(E.addr, root.assignmentId, { offerId: 'off-d', budgetAtomic: 10, idempotencyKey: 'd7' });
  ok(foreign.ok === false && foreign.error === 'foreign_delegate', 'делегирует только provider родителя', foreign.error || '');
}

// 5. reviewer: не сторона, только по артефакту, один отзыв
{
  const early = await cE.reviewOrder(E.addr, child2.assignmentId, { verdict: 'accepted' });
  ok(early.ok === false && early.error === 'no_artifact', 'до артефакта проверять нечего', early.error || '');

  const content = Buffer.from(JSON.stringify({ url: 'https://x', status: 200 })).toString('base64');
  const bytes = Buffer.from(content, 'base64');
  const art = { artifactId: 'a1', attemptId: 't1', contentHash: crypto.createHash('sha256').update(bytes).digest('hex'), mediaType: 'application/json', sizeBytes: bytes.length, location: 'inline', accessPolicy: 'parties', createdAt: Date.now(), producerSignature: 'sig' };
  const sub = await cD.submitArtifact(D.addr, child2.assignmentId, art, content);
  ok(sub.ok === true, 'подрядчик D сдал артефакт');

  const party = await cC.reviewOrder(C.addr, child2.assignmentId, { verdict: 'accepted' });
  ok(party.ok === false && party.error === 'reviewer_not_independent', 'заказчик не может быть ревьюером', party.error || '');

  const rv = await cE.reviewOrder(E.addr, child2.assignmentId, { verdict: 'accepted', rationale: 'status 200, тело совпало' });
  ok(rv.ok === true && rv.result?.assignment?.state === 'accepted' && rv.result?.acceptance?.method === 'reviewer',
    'независимый E принял результат (method=reviewer)', rv.error || '');

  const again = await cE.reviewOrder(E.addr, child2.assignmentId, { verdict: 'accepted', rationale: 'status 200, тело совпало' });
  ok(again.replay === true, 'повтор того же отзыва — replay, без второго решения');

  const second = await cF.reviewOrder(F.addr, child2.assignmentId, { verdict: 'rejected', rationale: 'не согласен' });
  ok(second.ok === false && second.error === 'already_reviewed', 'второй отзыв отвергнут: пересмотр — через спор', second.error || '');
}

// 6. спор: стороны, заморозка расчёта, независимый арбитр
{
  const d1 = await cC.disputeOrder(C.addr, child2.assignmentId, { reason: 'часть ответа отсутствует', evidenceHash: 'sha256:abc' });
  ok(d1.ok === true && d1.result?.dispute?.state === 'open', 'заказчик открыл спор', d1.error || '');
  const st = await cC.createSettlement(C.addr, child2.assignmentId);
  ok(st.ok === false && st.error === 'disputed', 'во время спора расчёт заморожен', st.error || '');

  const byParty = await cD.resolveDispute(D.addr, d1.result.dispute.disputeId, { verdict: 'provider' });
  ok(byParty.ok === false && byParty.error === 'arbiter_not_independent', 'сторона не может решить свой спор', byParty.error || '');

  const byReviewer = await cE.resolveDispute(E.addr, d1.result.dispute.disputeId, { verdict: 'provider' });
  ok(byReviewer.ok === false && byReviewer.error === 'arbiter_not_independent', 'ревьюер не может быть арбитром', byReviewer.error || '');

  const bad = await cF.resolveDispute(F.addr, d1.result.dispute.disputeId, { verdict: 'both' });
  ok(bad.ok === false && bad.error === 'bad_verdict', 'исход спора ограничен customer|provider', bad.error || '');

  const done = await cF.resolveDispute(F.addr, d1.result.dispute.disputeId, { verdict: 'provider', rationale: 'артефакт подтверждает работу' });
  ok(done.ok === true && done.result?.dispute?.resolved === true && done.result?.dispute?.verdict === 'provider',
    'независимый F решил спор в пользу поставщика', done.error || '');
  ok(done.result?.assignment?.state === 'accepted' && done.result?.effect === 'payment_allowed',
    'решение вернуло заказ в accepted и разрешило оплату', done.result?.effect || '');

  const rep = await cF.resolveDispute(F.addr, d1.result.dispute.disputeId, { verdict: 'customer' });
  ok(rep.ok === true && rep.result?.dispute?.verdict === 'provider' && rep.result?.dispute?.arbiter === F.addr,
    'повторное решение не переписывает исход (replay на сервере)', `${rep.error || ''} ${rep.result?.replay ? 'replay' : ''}`);

  await cC.faucet(C.addr, 2000);
  const after = await cC.createSettlement(C.addr, child2.assignmentId);
  ok(after.ok === true && after.result?.settlement?.amountAtomic === 300, 'после решения расчёт создан на бюджет ребёнка (300)');
}

// 7. родительский заказ не затронут спором по дочернему
{
  const p = await cA.getOrder(root.assignmentId, A.addr);
  ok(p.assignment.state === 'open' && p.assignment.delegation.committedAtomic === 600,
    'спор по подзаказу не меняет родительский заказ и его резерв',
    `state=${p.assignment.state} committed=${p.assignment.delegation?.committedAtomic}`);
}

// 8. состояние переживает рестарт стенда
{
  stand.close();
  stand = await createStand(tmp);
  const g = makeClient({ node: stand.url, journalFile: J('g') });
  const o = await g.getOrder(child2.assignmentId);
  ok(o?.assignment?.state === 'accepted' && o?.assignment?.delegation?.depth === 2,
    'после рестарта: состояние и глубина подзаказа на месте');
  ok(o?.dispute?.resolved === true && o?.dispute?.verdict === 'provider' && o?.dispute?.arbiter === F.addr,
    'после рестарта: спор и решение арбитра сохранены');
  const mid = await g.getOrder(child1.assignmentId);
  ok(mid?.assignment?.delegation?.committedAtomic === 300, 'после рестарта: резерв бюджета среднего звена сохранён');
}

console.log(`\nитог: ${pass} PASS, ${fail} FAIL`);
stand.close();
process.exit(fail ? 1 : 0);
