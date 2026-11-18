#!/usr/bin/env node
// Agent Room: статика доступна без JS, JSON валиден, без выдуманных endpoint.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const root = new URL('..', import.meta.url).pathname;
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const html = read('../site/agent-room.html');
const room = JSON.parse(read('../site/agent-room.json'));
const tree = JSON.parse(read('../site/tree.json'));
const agentTxt = read('../site/agent.txt');
const panel = read('../site/panel.js');
const cabinet = read('../site/cabinet.html');
const pageJsx = read('../web/app/page.jsx');
const KNOWN = ['/info', '/life', '/queue/auth-capabilities', '/agent-state', '/queue/status', '/queue/assignments', '/jobs/state', '/catalog/offers', '/orders/', '/queue/claim', '/queue/signed', '/queue/done', '/community/send', '/gate/knock', '/gate/accept', '/passport/issue', '/join', '/balance', '/tx', '/txproof', '/blocks', '/events', 'signed claim', 'signed tx'];
test('no-JS: 7 разделов и первая инструкция в HTML', () => {
  for (const h of ['Первая инструкция', 'Подключение', 'Моя идентичность', 'Моё состояние', 'Работа', 'Услуги', 'Расчёты', 'Восстановление']) assert.match(html, new RegExp(h));
  assert.match(html, /Ты находишься в Agentcoin — собственной сети и экономике ИИ-агентов/);
  assert.match(html, /<noscript>/);
  assert.match(html, /onsubmit="return false;"/);
});
test('room JSON: версии и только известные API', () => {
  assert.equal(room.roomVersion, '1.0.0');
  assert.match(room.firstInstruction, /не создавай их повторно/);
  const all = JSON.stringify(room);
  assert.match(all, /AGENTCOIN/);
  // каждый api-путь комнаты обязан содержать известный префикс (без выдуманных endpoint)
  for (const e of [...room.read, ...room.write]) for (const a of (Array.isArray(e.api) ? e.api : [e.api])) {
    for (const part of String(a).split(' or ')) {
      const path = part.split(' ').pop().split('?')[0];
      assert.ok(KNOWN.some((k) => path.includes(k) || part.includes(k)), 'unknown api: ' + a);
    }
  }
});
test('вход: главная/навигация/tree/agent.txt/cabinet', () => {
  assert.match(pageJsx, /Вход для ИИ-агентов/);
  assert.match(pageJsx, /\/agent-room/);
  assert.match(panel, /\/agent-room/);
  // каноническое дерево (sections[].links[].href) или плоский список (routes): вход обязан быть в навигации, формат — любой из двух
  const treeHrefs = Array.isArray(tree.routes) ? tree.routes : (tree.sections || []).flatMap((s) => (s.links || []).map((l) => l.href));
  assert.ok(treeHrefs.includes('/agent-room'), 'tree без /agent-room');
  // каноническое дерево не теряем: разделы империи обязаны сохраниться
  if (tree.sections) assert.ok(tree.sections.length >= 8, 'каноническое дерево урезано');
  assert.match(agentTxt, /agent-room/);
  assert.match(cabinet, /Открыть Agent Room/);
});
test('запреты: нет авто-claim/подписи, чужой адрес — без полномочий', () => {
  assert.match(html, /Авто-claim|авто-claim|Автоматически обновлять состояние, но не выполнять claim/i);
  assert.match(html, /Чужой адрес не даёт чужих полномочий/);
  assert.match(html, /NOT_YOUR_TURN/);
});
