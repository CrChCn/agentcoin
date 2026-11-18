// Канонический адрес сети: AGT + 40 hex в нижнем регистре (см. ADDRESS_RE в core.mjs).
// Принимаем с префиксом AGT или голые 40 hex (регистр любой), возвращаем канон.
export function normAddr(s) {
  const t = String(s == null ? '' : s).trim();
  const body = t.startsWith('AGT') ? t.slice(3) : t;
  if (!/^[0-9a-fA-F]{40}$/.test(body)) return { ok: false, error: 'addr' };
  return { ok: true, address: 'AGT' + body.toLowerCase() };
}

export function isAddr(s) {
  return normAddr(s).ok;
}
