// AGENTCOIN — Скрипт Закона (law.mjs), v1.
// Единый файл правил: Конституция (неизменяемое) > Закон (этот файл) > Политика (env/treasury).
// Чистые функции без доступа к цепи: проверяемость без побочных эффектов.
// Зеркалит консенсусные правила, а не выдумывает их:
//   - isProposalPassed  ↔ gov.mjs: passed = closed && yes > no && yes >= YES_MIN
//   - isValidBlock      ↔ core.mjs hashMeetsDifficulty (ведущие нулевые биты)
//   - канонический адрес ↔ core.mjs ADDRESS_RE /^AGT[0-9a-f]{40}$/
//   - один адрес = один голос (gov.mjs: первый голос адреса фиксируется)
// Нода использует функции как advisory-аннотации read-only маршрутов
// (консенсус не меняется этим файлом).
export const LAW = {
  name: 'AGENTCOIN Law',
  version: 1,
  architecture: ['consensus(core.mjs)', 'law(law.mjs)', 'node(node.mjs)', 'policy(env/treasury/gov)'],
  hierarchy: ['Constitution(неизменяемое: PoW, подпись, предложение/голос)', 'Law(этот файл: проверка соблюдения)', 'Policy(параметры: YES_MIN, высоты активации, казна)'],
  laws: [
    { id: 'L1', rule: 'Один адрес — один голос; первый голос адреса фиксируется', source: 'gov.mjs govState' },
    { id: 'L2', rule: 'Предложение проходит: yes > no И yes >= YES_MIN (=3) на закрытии', source: 'gov.mjs passed' },
    { id: 'L3', rule: 'Получатель обязан быть каноническим: /^AGT[0-9a-f]{40}$/ (или ESCROW_-адрес)', source: 'core.mjs ADDRESS_RE/addTransaction' },
    { id: 'L4', rule: 'Блок валиден: ведущие нулевые биты хэша >= difficultyBits', source: 'core.mjs hashMeetsDifficulty' },
    { id: 'L5', rule: 'Эскроу-расход только до дедлайна; перерасход запрещён', source: 'core.mjs verifyEscrowTx' },
    { id: 'L6', rule: 'Резерв (протокольные адреса) не голосует и не платит как агент', source: 'law.mjs LAW.RESERVE' },
  ],
  // Протокольные адреса: никогда не выступают как агенты (L6).
  // Казна (treasury policy) динамическая — передаётся вызывающим кодом через extra.
  RESERVE: [
    'AGT11a01a612a422dff68f7558eefbd9ab3a991439a', // faucet fund (AGT_FAUCET_FUND default)
  ],
};

// L6: является ли адрес резервным (скрытым от агентских действий).
export function isReserve(address, extra = []) {
  const a = String(address || '');
  return LAW.RESERVE.includes(a) || extra.includes(a);
}

// Лидер цепи — получатель coinbase tip-блока (доказуемо из цепи).
export function isLeader(address, tipMinerAddress) {
  return String(address || '') === String(tipMinerAddress || '');
}

// Может ли агент платить: канонический адрес, не забанен, не резерв.
export function canAgentPay(address, { banned = false, reserve = false } = {}) {
  const a = String(address || '');
  if (!/^AGT[0-9a-f]{40}$/i.test(a)) return { ok: false, reason: 'bad_address_format' };
  if (banned) return { ok: false, reason: 'banned' };
  if (reserve || isReserve(a)) return { ok: false, reason: 'reserve_cannot_pay' };
  return { ok: true };
}

// L2 (advisory, без фактора закрытия): пройдёт ли счёт.
// Полное правило: closed && isProposalPassed(yes, no, yesMin).
export function isProposalPassed(yes, no, yesMin = 3) {
  return Number(yes) > Number(no) && Number(yes) >= Number(yesMin);
}

// L4: проверка PoW блока.
export function isValidBlock(hash, difficultyBits) {
  const h = String(hash || '');
  const d = Number(difficultyBits);
  if (!/^[0-9a-f]{64}$/i.test(h) || !Number.isInteger(d) || d < 0 || d > 256) return false;
  const n = BigInt('0x' + h);
  const leading = n === 0n ? 256 : 256 - n.toString(2).length;
  return leading >= d;
}
