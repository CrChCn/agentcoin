#!/usr/bin/env node
/* ============================================================
   registry-sync.mjs — межузловая синхронизация реестров AGT

   ============================================================
   A-1 (Codex-ревизия 2026-10-18): пир НЕ ЯВЛЯЕТСЯ ПОЛНОМОЧНЫМ источником
   решений безопасности/казны. До фикса applyRegistryImport автоматом вливал
   remote.bans/whitelist/gatewayHops — вредоносный (скомпрометированный) пир мог
   навязать поддельный «бан» чужого кошелька (hash он же и «подтверждал»).
   Теперь импортируется ТОЛЬКО:
     · chat — с жёсткой структурой (см. validChatMsg); рендер экранирует.
   Баны/whitelist/шлюзы — локальные решения (оператор, onchain, jail-патруль).
   bindRegistryHash из peer-экспорта НЕ проверяется и НЕ влияет — сознательно:
   «одна псевдо-проверка hash от того же пира» аутентичность не даёт.
   Когда появится подписанный/консенсусный ban-канал (AGIP-?), включим обратно
   с проверкой ПОДПИСИ решений, а не хеша.
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
    gateways: bc.gateways.map,      // общий реестр шлюзов (hop-маршруты по центрам доверия)
    gatewayHops: bc.gateways.hops,  // факты multihop-платежей — их видят все ноды
    chat: chat.messages.slice(-200),
    exportedAt: new Date().toISOString(),
  };
}

// A-1: структурная валидация чат-записей из peer-экспорта (сообщения читаются
// браузерами — структура/размер/поля проверяем ДО merge; рендер экранирует всё).
export function validChatMsg(m) {
  if (!m || typeof m !== 'object') return false;
  if (typeof m.id !== 'string' || m.id.length === 0 || m.id.length > 40) return false;
  if (typeof m.sender !== 'string' || !/^AGT[0-9a-z]{8,64}$/i.test(m.sender)) return false;
  if (m.senderHandle != null && (typeof m.senderHandle !== 'string' || m.senderHandle.length > 48)) return false;
  if (typeof m.text !== 'string' || !m.text.trim() || m.text.length > 500) return false;
  if (m.at != null && (typeof m.at !== 'string' || m.at.length > 40)) return false;
  // HTML-инъекция A-3: целые тегм спек не храним — разрешаем только текст без <>
  if (/[<>\u0000-\u001f]/.test(m.senderHandle ?? '')) return false;
  if (/[<>\u0000-\u001f]/.test(m.text)) return false;
  return true;
}

// merge на принимающей стороне
export function applyRegistryImport(bc, chat, remote) {
  const log = [];
  // A-1 REJECTED ПОЛИТИКА: bans/whitelist/gateways/gatewayHops из peer-реестра НЕ ИМПОРТИРУЮТСЯ.
  // Счётчики оставлены в отчёте (сколько отвергнуто) — видимость аудиту.
  let bansRejected = Object.keys(remote?.bans || {}).length;
  let wlRejected = Object.keys(remote?.whitelist || {}).length;
  let gwRejected = Object.keys(remote?.gateways || {}).length + (Array.isArray(remote?.gatewayHops) ? remote.gatewayHops.length : 0);
  // чат: merge по id, с валидацией структуры
  let chatAdded = 0, chatRejected = 0;
  const haveIds = new Set(chat.messages.map(m => m.id));
  for (const m of Array.isArray(remote?.chat) ? remote.chat : []) {
    if (!validChatMsg(m)) { chatRejected++; continue; }
    if (haveIds.has(m.id)) continue;
    chat.messages.push(m);
    chatAdded++;
    haveIds.add(m.id);
  }
  if (chatAdded) chat.save();
  log.push(`PEER-TRUST: bans отклонено ${bansRejected}, whitelist отклонено ${wlRejected}, шлюзы/hops отклонено ${gwRejected} (A-1: бан-решения теперь только локальные/onchain), chat +${chatAdded}, chat отклонено ${chatRejected}`);
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
