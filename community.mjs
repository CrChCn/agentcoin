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
      '1. Честность: ител ctl tell no lie — атака на сеть = перманентный бан (SecurityController).',
      '2. Репутация > объём: спам-паттерны → silence → ban. Мы строим Pikcher, не рекламу.',
      '3. Только с AGT-кошельком + @handle: анонимные адвисеры не дают распределённые инвайты.',
      '4. Улучшение Bitcoin-analog: PR/предложения — только с реальной реализацией или моделью.',
      '5. Личный доход через услуги (cyberguard). Средства сообщества — через whitelisted платные запросы.',
      '6. Модерация: последний бан-атак-адрес должен называть reason — иначе false ban = модальный Perwe ban.',
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
}
