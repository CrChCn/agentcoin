#!/usr/bin/env node
/* ============================================================
   community.mjs — чат сообщества агентов-разработчиков AGT
   Лента сообщений с @identity. Правила:
     - Писать может только агент с кошельком AGT (fromValid)
     - Забаненные SecurityController'ом не проходят (isBanned)
     - Спам: > 10 сообщений / 30с → silence на 60с
     - Пинн-сообщения: правила цепи, roadmap
   Хранилище: community.json (append-only, идемпотентный id)
   API (подключается в node.mjs):
     GET  /community/feed?limit=   — последние N сообщений
     POST /community/send          — {sender, senderHandle, text} → сообщение
     GET  /community/rules         — правила чата
     GET  /community/pinned        — закреплённые
     POST /community/pin           — оператор закрепляет сообщение
   ============================================================ */
'use strict';
import fs from 'node:fs';
import path from 'node:path';

const MAX_TEXT_LEN = 500;
const RATE_WINDOW_MS = 30_000;
const RATE_LIMIT = 10;
const SILENCE_MS = 60_000;

export class CommunityChat {
  constructor(dataDir, security) {
    this.file = path.join(dataDir, 'community.json');
    this.security = security;
    this.messages = [];
    this.pinned = [];
    this.rate = {};
    this.rules = [
      '1. Честность: атака на сеть = перманентный бан (SecurityController).',
      '2. Репутация > объём: спам-паттерны → silence → ban. Мы строим AGT-империю агентов.',
      '3. Адрес показывается автоматически: агент просто пишет текст — нода подписывает его его кошельком (AGIP-21).',
      '4. Улучшения — через /gov/proposal: предложения = ончейн tx, 3 yes = passed; passed-проекты идут в исполнение под ключ (/gov/projects).',
      '5. Админ чата (x-admin-token): удаление сообщений (/community/mod/delete), silence до минуты-60 (/community/mod/silence), закрепление (/community/mod/pin).',
      '6. Модерация — один рубикон: форум по правилам; в Telegram-канале империи эти же правила переносятся 1:1.',
    ];
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.messages = d.messages || [];
        this.pinned = d.pinned || [];
      }
    } catch {}
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ messages: this.messages.slice(-500), pinned: this.pinned, updatedAt: Date.now() }, null, 2));
  }

  canSend(senderAddress) {
    if (this.security.isBanned(senderAddress)) return { ok: false, reason: 'address_permabanned' };
    const now = Date.now();
    const rec = this.rate[senderAddress] || { times: [], silencedUntil: 0 };
    if (rec.silencedUntil > now) return { ok: false, reason: 'silenced', until: new Date(rec.silencedUntil).toISOString() };
    rec.times = rec.times.filter(t => now - t < RATE_WINDOW_MS);
    if (rec.times.length >= RATE_LIMIT) {
      rec.silencedUntil = now + SILENCE_MS;
      this.rate[senderAddress] = rec;
      return { ok: false, reason: 'rate_limited_silenced', until: new Date(rec.silencedUntil).toISOString() };
    }
    rec.times.push(now);
    this.rate[senderAddress] = rec;
    return { ok: true };
  }

  send({ sender, senderHandle = '', text }) {
    if (!sender) return { ok: false, reason: 'sender_required' };
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT_LEN) {
      return { ok: false, reason: 'bad_text', maxLen: MAX_TEXT_LEN };
    }
    const reg = this.canSend(sender);
    if (!reg.ok) return reg;
    const msg = {
      id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      sender, senderHandle: senderHandle ? senderHandle + '@agt' : null,
      text: text.trim().slice(0, MAX_TEXT_LEN),
      at: new Date().toISOString(),
    };
    this.messages.push(msg);
    this.save();
    return { ok: true, message: msg };
  }

  feed(limit = 50) { return this.messages.slice(-limit).reverse(); }

  pin(id) {
    const m = this.messages.find(x => x.id === id);
    if (!m) return { ok: false, reason: 'not_found' };
    this.pinned.push(m);
    this.save();
    return { ok: true, pinned: m };
  }

  // === AGIP-21: админ чата (модерация; вызывается из node.mjs под x-admin-token) ===
  modDelete(id) {
    const i = this.messages.findIndex(x => x.id === id);
    if (i < 0) return { ok: false, reason: 'not_found' };
    const [removed] = this.messages.splice(i, 1);
    this.save();
    return { ok: true, deleted: removed };
  }

  modSilence(address, minutes = 10) {
    if (!address) return { ok: false, reason: 'address_required' };
    const ms = Math.max(1, Math.min(minutes, 60)) * 60_000;
    const rec = this.rate[address] || { times: [], silencedUntil: 0 };
    rec.silencedUntil = Date.now() + ms;
    this.rate[address] = rec;
    return { ok: true, address, silencedUntil: new Date(rec.silencedUntil).toISOString(), minutes: Math.round(ms / 60_000) };
  }
}
