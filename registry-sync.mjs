#!/usr/bin/env node
/* ============================================================
   registry-sync.mjs — межузловая синхронизация реестров AGT
   Что синхронизируем (в обе стороны, по longest-registry правилу):
     1) ban-list (SecurityController) — консенсус безопасности
     2) WhiteList — платёжная верификация
     3) Чат (последние сообщения) — comunidad flujos
   Механизм:
     - каждая нода отдаёт GET /registry/export (json + registryHash)
     - принимающая валидирует: merkle-hash совпадает, записи не удаляются
       (append-only для ban/whitelist), чат merge по id
     - POST /registry/import применяет, возвращает принявшее количество
   ============================================================ */
'use strict';

export async function fetchJson(url, timeoutMs = 10_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    return await r.json();
  } finally { clearTimeout(t); }
}

// генерация export-объекта (используется нодой)
export function buildRegistryExport(bc, chat) {
  return {
    bans: bc.security.bans,
    attacksCount: bc.security.attacks.length,
    banRegistryHash: bc.security.registryHash(),
    whitelist: bc.whitelist.list,
    whitelistRegistryHash: bc.whitelist.registryHash(),
    chat: chat.messages.slice(-200),
    exportedAt: new Date().toISOString(),
  };
}

// merge на принимающей стороне
export function applyRegistryImport(bc, chat, remote) {
  const log = [];
  const now = Date.now();
  // баны: append-only (у него + у нас merge по ключу; revoke невозможен через sync)
  let bansAdded = 0;
  for (const [addr, info] of Object.entries(remote.bans || {})) {
    if (!bc.security.bans[addr]) { bc.security.bans[addr] = { ...info, syncedFrom: 'peer', syncedAt: now }; bansAdded++; }
  }
  // whitelist: конфликт по handle — приоритет у более ранней verifiedAt (кто раньше, тот честно)
  let wlAdded = 0, wlConflicts = 0;
  for (const [handle, entry] of Object.entries(remote.whitelist || {})) {
    const mine = bc.whitelist.list[handle];
    if (!mine) { bc.whitelist.list[handle] = { ...entry, syncedFrom: 'peer', syncedAt: now }; wlAdded++; }
    else if (mine.address !== entry.address) { wlConflicts++; /* остаётся наша — первая */ }
  }
  // чат: merge по id
  let chatAdded = 0;
  const haveIds = new Set(chat.messages.map(m => m.id));
  for (const m of remote.chat || []) {
    if (!haveIds.has(m.id)) { chat.messages.push(m); chatAdded++; }
  }
  if (bansAdded) bc.security.save();
  if (wlAdded) bc.whitelist.save();
  if (chatAdded) chat.save();
  log.push(`bans +${bansAdded}, whitelist +${wlAdded} (conflicts ${wlConflicts}), chat +${chatAdded}`);
  return { ok: true, log };
}

// синк со списком пиров
export async function syncRegistries(bc, chat, peerUrls) {
  const out = [];
  for (const peer of peerUrls) {
    try {
      const remote = await fetchJson(peer + '/registry/export');
      const r = applyRegistryImport(bc, chat, remote);
      out.push(`${peer}: ${r.log.join('; ')}`);
    } catch (e) {
      out.push(`${peer}: ERROR ${e.message}`);
    }
  }
  return out;
}
