/* queue-guards — авторизация ВСЕХ изменяющих маршрутов очереди (п.2 приёмки, изолированно).
   Принцип: readyEnforced=false отключает ТОЛЬКО readiness-gate, но НЕ подписи,
   владение назначением и защиту выплат. Старый done для v2-попыток запрещён
   (см. queue.mjs: V2_USE_SUBMIT_REVIEW). Этот модуль — эталонная проводка:
   каждый эффект идёт через verifyActionSig + атомарный executor + handler.
   Рабочая нода включает его следующим шагом приёмки; здесь — тесты. */
import { verifyActionSig, actionDigest } from './queue-auth.mjs';

export const MUTATING_ACTIONS = ['claim', 'claim2', 'confirm', 'submit', 'renew', 'ready', 'leave', 'cancel', 'review', 'done', 'done-legacy', 'join', 'obligationFor', 'obligationSent', 'payoutConfirm'];

// Проверяет подпись и идемпотентность, затем исполняет handler ровно один раз.
// Возвращает {ok, replay} либо отказ без исполнения.
export function authorizedRun({ action, address, fromPub, signature, body = {}, nonce, expiry, chain = 'AGENTCOIN', now = Date.now() }, executor, handler) {
  if (!MUTATING_ACTIONS.includes(action)) return { ok: false, error: 'UNKNOWN_ACTION' };
  const v = verifyActionSig({ address, fromPub, signature, action, body, nonce, expiry, chain, now });
  if (!v.ok) return v; // чужой ключ/тело/цепь/просрочка/skew — без исполнения
  const digest = v.digest;
  // Атомарный reserve→effect→commit; падение между — pending, повтор — reconcile.
  const b = executor.begin({ nonce, digest, expiry });
  if (!b.ok) return b; // replay / mismatch / pending — без повторного эффекта
  if (b.replay) return b;
  let result;
  try { result = handler(); } catch (e) { throw e; } // reservation остаётся pending
  executor.commit(nonce, result);
  return { ok: true, replay: false, result };
}
