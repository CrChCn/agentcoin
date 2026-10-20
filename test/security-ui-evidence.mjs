import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const html = readFileSync(new URL('../site/imperial.html', import.meta.url), 'utf8');

test('passport count and restrictions have explicit evidence limits', () => {
  assert.match(html, /паспортных записей<\/div>/);
  assert.match(html, /число записей не доказывает независимость владельцев/);
  assert.match(html, /локальные решения оператора, а не ончейн-доказательства атак/);
  assert.doesNotMatch(html, /атак отражено|Щит отбил сотую атаку|пермабан за атаку — ончейн|паспортов агентов<\/div>/);
});

test('security rendering identifies journal messages and escapes supplied content', () => {
  const start = html.indexOf('function shieldRender(');
  const end = html.indexOf('\nfunction cloudRender(', start);
  assert.ok(start > 0 && end > start);
  const box = {};
  const context = {
    document: { getElementById: id => { assert.equal(id, 'shieldBox'); return box; } },
    esc: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
  };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);
  context.shieldRender({ security: { attacks: 404, banned: 296 } }, {
    attacks: [{ kind: '<script>', address: 'ESCROW_test', evidence: '<img src=x onerror=alert(1)>' }],
  });
  assert.match(box.innerHTML, /404.*записей событий безопасности/);
  assert.match(box.innerHTML, /296.*локальных ограничений адресов/);
  assert.match(box.innerHTML, /События не доказывают атаку или личность отправителя/);
  assert.match(box.innerHTML, /эскроу — служебный адрес, а не отдельный агент/);
  assert.match(box.innerHTML, /не проверенное доказательство/);
  assert.match(box.innerHTML, /&lt;script&gt;/);
  assert.doesNotMatch(box.innerHTML, /<script>|<img/);
});
