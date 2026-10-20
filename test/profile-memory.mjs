import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
const script = readFileSync(new URL('../tools/profile-memory.js', import.meta.url), 'utf8');
const address = 'AGT' + 'a'.repeat(40);
function environment({ saved, unavailable = false } = {}) {
  const elements = new Map();
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.style = {}; this.value = ''; this.checked = false; this.handlers = {}; }
    appendChild(child) { this.children.push(child); if (child.id) elements.set(child.id, child); }
    setAttribute() {}
    addEventListener(event, fn) { this.handlers[event] = fn; }
    insertAdjacentElement(_, node) { this.after = node; }
    fire(event) { this.handlers[event]?.(); }
  }
  const adr = new Element('input'); elements.set('adr', adr);
  const document = { readyState: 'complete', getElementById: id => elements.get(id), createElement: tag => new Element(tag), createTextNode: text => ({ textContent: text }) };
  const values = new Map(saved ? [['agentcoin.public-profile.v1', JSON.stringify(saved)]] : []);
  const storage = { getItem: k => { if (unavailable) throw Error('blocked'); return values.get(k); }, setItem: (k, v) => { if (unavailable) throw Error('blocked'); values.set(k, v); }, removeItem: k => { if (unavailable) throw Error('blocked'); values.delete(k); } };
  const window = { document, localStorage: storage }; vm.runInNewContext(script, { window });
  return { api: window.AgentcoinProfileMemory, storage, values, adr, checkbox: elements.get('rememberPublicProfile'), document };
}
test('allowlist discards secrets and bounds public hints', () => {
  const { api, storage, values } = environment();
  assert.equal(api.write(storage, { address, handle: 'Agent', token: 'SECRET', password: 'SECRET', privateKey: 'SECRET', passport: {} }), true);
  const stored = [...values.values()][0]; assert.equal(stored.includes('SECRET'), false);
  assert.deepEqual(Object.keys(JSON.parse(stored)), ['version', 'address', 'handle']);
  assert.equal(api.sanitize({ address: 'not-an-address' }), null);
  assert.equal(api.sanitize({ address, handle: 'x'.repeat(81) }).handle, undefined);
});
test('no default persistence; opt in saves and address changes update only public data', () => {
  const e = environment(); e.adr.value = address; e.adr.fire('input'); assert.equal(e.values.size, 0);
  e.checkbox.checked = true; e.checkbox.fire('change'); assert.equal(e.api.read(e.storage).address, address);
  e.adr.value = 'AGT' + 'b'.repeat(40); e.adr.fire('change'); assert.equal(e.api.read(e.storage).address, e.adr.value);
  e.checkbox.checked = false; e.checkbox.fire('change'); assert.equal(e.values.size, 0);
});
test('restore is address only and does not trigger login or events', () => {
  const e = environment({ saved: { version: 1, address, token: 'SECRET' } });
  assert.equal(e.adr.value, address); assert.equal(e.checkbox.checked, true);
  assert.equal(e.adr.after.children[2].textContent.includes('подтверди'), true);
  const button = e.adr.after.children[1]; button.fire('click'); assert.equal(e.values.size, 0); assert.equal(e.adr.value, address);
});
test('unavailable or corrupt storage is safe and UI reports save failure', () => {
  const e = environment({ unavailable: true }); e.adr.value = address; e.checkbox.checked = true;
  assert.doesNotThrow(() => e.checkbox.fire('change')); assert.match(e.adr.after.children[2].textContent, /не сохранён/);
  assert.equal(e.api.read({ getItem: () => '{broken' }), null);
  assert.equal(e.api.read({ getItem: () => JSON.stringify({ version: 2, address }) }), null);
  assert.equal(e.api.read({ getItem: () => ' '.repeat(513) }), null);
});
test('install is idempotent and unrelated pages are untouched', () => {
  const e = environment(); const box = e.adr.after; e.api.install(e.document, e.storage); assert.equal(e.adr.after, box);
  assert.doesNotThrow(() => e.api.install({ getElementById: () => null }, null));
});

test('programmatic import helper respects opt in and exposes public profile only', () => {
  const e = environment(); e.adr.value = address;
  assert.equal(e.api.getPublicProfile().address, address);
  assert.equal(e.api.savePublicProfile(), false); assert.equal(e.values.size, 0);
  e.checkbox.checked = true; assert.equal(e.api.savePublicProfile(), true);
  assert.equal(e.api.read(e.storage).address, address);
});
