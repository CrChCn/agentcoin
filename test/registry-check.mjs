#!/usr/bin/env node
// Self-test проверяющего механизма (Этап 1, п.7). Провал кейса = ненулевой код.
import { checkRegistry } from '../tools/registry-check.mjs';
import fs from 'node:fs';

const base = JSON.parse(fs.readFileSync(new URL('../config/unified-registry.json', import.meta.url), 'utf8'));
const clone = () => JSON.parse(JSON.stringify(base));
const results = [];
function expect(name, reg, shouldPass) {
  const { errors } = checkRegistry(reg);
  const passed = shouldPass ? errors.length === 0 : errors.length > 0;
  results.push({ name, shouldPass, errors: errors.length, ok: passed, sample: errors[0] || '' });
}

// 1 корректный
expect('valid registry', clone(), true);
// 2 дублирующийся ID
{
  const r = clone();
  r.components.push(JSON.parse(JSON.stringify(r.components[0])));
  expect('duplicate id', r, false);
}
// 3 несуществующая зависимость
{
  const r = clone();
  r.components[0].dependsOn.push('no-such-component');
  expect('missing dep', r, false);
}
// 4 два конкурирующих владельца маршрута
{
  const r = clone();
  const a = r.components.find(c => c.componentId === 'site-static');
  const b = r.components.find(c => c.componentId === 'web-next');
  b.routes.push({ host: 'agentcoin.work', method: 'GET', path: '/settlement', owner: true, note: 'TEST competing owner' });
  void a;
  expect('competing owner', r, false);
}
// 5 «подтверждено» без доказательства
{
  const r = clone();
  const c = r.components.find(c => c.componentId === 'node-monitor');
  c.verification = { ...c.verification, status: 'confirmed', evidence: [] };
  expect('confirmed w/o evidence', r, false);
}
// 6 разрешённый описанный алиас
{
  const r = clone();
  expect('allowed alias', r, true);
  const n = r.components.find(c => c.componentId === 'mainnet-node-1');
  const al = n.routes.find(x => x.aliasOf);
  if (!al || al.owner !== false || !al.note) { results.push({ name: 'allowed alias shape', shouldPass: true, errors: 1, ok: false, sample: 'alias shape broken' }); }
}
// 7 честно обозначенное неизвестное
{
  const r = clone();
  const t = r.components.find(c => c.componentId === 'env-testnet');
  const okShape = t.verification.status === 'unknown' && t.verification.unknowns.length > 0 && t.observedVersion === null;
  results.push({ name: 'honest unknown visible', shouldPass: true, errors: okShape ? 0 : 1, ok: okShape, sample: okShape ? '' : 'unknown not visible' });
}

let fail = 0;
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name} (expect ${r.shouldPass ? 'pass' : 'fail'}, errors=${r.errors})${r.ok ? '' : ' :: ' + r.sample}`);
  if (!r.ok) fail++;
}
if (fail) { console.log(`SELFTEST FAIL ${fail}/${results.length}`); process.exit(1); }
console.log(`SELFTEST OK ${results.length}/${results.length}`);
