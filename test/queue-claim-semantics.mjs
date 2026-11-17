/* queue-claim-semantics.mjs — приёмка семантики «только вызывающий» (без ноды, без сети).
   Изолированная временная очередь; mainnet не трогается:
     1) чужой клик голову FIFO не сдвигает (NOT_YOUR_TURN, очередь цела);
     2) taker вне очереди -> expected:join, сдвига нет;
     3) повторный claim после потери ответа -> то же назначение, дублей нет;
     4) перезапуск (новый AgentQueue на той же директории) -> состояние цело;
     5) leave с причиной пишет историю; cancel освобождает слот без выплаты и без requeue;
     6) TAKER_REQUIRED / QUEUE_EMPTY / TOO_MANY_ON_DUTY.
   Запуск: node test/queue-claim-semantics.mjs. Exit 0 = ok. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentQueue } from '../queue.mjs';

const fails = [];
const ok = (m) => console.log('  ok: ' + m);
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) fails.push(`${m}: ждали ${JSON.stringify(b)}, получили ${JSON.stringify(a)}`); else ok(m); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-q-'));
const A = 'AGTaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'AGTbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const C = 'AGTcccccccccccccccccccccccccccccccccccccccc';
const q = new AgentQueue(dir);
q.join(A); q.join(B); q.join(C);

// 1. чужой клик (B не голова) — отказ без сдвига
let r = q.claim(B);
eq(r.ok, false, 'не-голова: ok=false');
eq(r.error, 'NOT_YOUR_TURN', 'не-голова: код');
eq(r.position, 2, 'не-голова: позиция 2');
eq(q.state.waiting, [A, B, C], 'не-голова: очередь не сдвинулась');
eq(Object.keys(q.state.onDuty).length, 0, 'не-голова: назначений нет');

// 2. чужой адрес вне очереди
r = q.claim('AGTzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz');
eq(r.expected, 'join', 'чужак: expected=join');
eq(q.state.waiting.length, 3, 'чужак: очередь цела');

// 3. голова забирает; повтор после потери ответа — то же назначение
const first = q.claim(A);
eq(first.ok, true, 'голова: ok');
eq(first.agent, A, 'голова: назначено голове');
const again = q.claim(A);
eq(again.jobId, first.jobId, 'повтор: тот же jobId');
eq(again.repeat, true, 'повтор: флаг repeat');
eq(Object.keys(q.state.onDuty).length, 1, 'повтор: дублей нет');
eq(q.state.waiting, [B, C], 'повтор: очередь не дёргается');

// 4. перезапуск
const q2 = new AgentQueue(dir);
eq(q2.state.waiting, [B, C], 'рестарт: waiting цело');
eq(Object.keys(q2.state.onDuty), Object.keys(q.state.onDuty), 'рестарт: onDuty цело');

// 5. leave с причиной
const lv = q2.leave(C, 'тест: вышел сам');
eq(lv.ok, true, 'leave: ok');
eq(q2.state.waiting, [B], 'leave: только свой адрес ушёл');
eq(q2.state.history[q2.state.history.length - 1].summary.startsWith('leave:'), true, 'leave: причина в истории');
eq(q2.leave(C).ok, false, 'leave дважды: уже нет в очереди');

// 6. cancel: слот свободен, в очередь не возвращается, выплаты нет
const cj = first.jobId;
const cx = q2.cancel(cj, 'тест: зависшее назначение');
eq(cx.ok, true, 'cancel: ok');
eq(cx.agent, A, 'cancel: вернул исполнителя');
eq(Object.keys(q2.state.onDuty).length, 0, 'cancel: слот свободен');
eq(q2.state.waiting.includes(A), false, 'cancel: без requeue');
eq(q2.state.history[q2.state.history.length - 1].summary.startsWith('cancelled:'), true, 'cancel: причина в истории');

// 7. пустая очередь и пустой taker
const q3 = new AgentQueue(fs.mkdtempSync(path.join(os.tmpdir(), 'agt-qe-')));
eq(q3.claim('').error, 'TAKER_REQUIRED', 'пустой taker: код');
eq(q3.claim(B).error, 'QUEUE_EMPTY', 'пустая очередь: код');

// 8. кап onDuty (25): 26-й claim головы упирается, очередь цела
const q4 = new AgentQueue(fs.mkdtempSync(path.join(os.tmpdir(), 'agt-qc-')));
const addrs = Array.from({ length: 30 }, (_, i) => 'AGT' + String(i).padStart(40, '0'));
addrs.forEach((a) => q4.join(a));
for (let i = 0; i < 25; i++) { const rr = q4.claim(addrs[i]); if (!rr.ok) fails.push('кап: свежий claim должен проходить #' + i); }
const over = q4.claim(addrs[25]);
eq(over.error, 'TOO_MANY_ON_DUTY', 'кап: 26-й упирается');
eq(q4.state.waiting[0], addrs[25], 'кап: голова на месте');

if (fails.length) { console.error('FAIL:\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('queue-claim-semantics: ALL GREEN');
