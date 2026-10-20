import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAssistantService } from '../assistant-service.mjs';
const response = content => new Response(JSON.stringify({ message: { role: 'assistant', content } }));

test('disabled or invalid model never connects', async () => {
  for (const model of ['', undefined, 'bad\nmodel', 'x'.repeat(97)]) {
    const service = createAssistantService({ model, fetchFn: () => { throw Error('must not call'); } });
    assert.equal(service.status().configured, false);
    assert.equal((await service.ask('Как создать профиль?')).error, 'assistant_unavailable');
  }
});
test('fixed loopback endpoint, exact roles, bounded generation and no tools/history', async () => {
  let calls = 0;
  const service = createAssistantService({ model: 'qwen3:4b', fetchFn: async (url, options) => {
    calls++;
    assert.equal(url, 'http://127.0.0.1:11434/api/chat');
    assert.equal(options.redirect, 'error');
    const payload = JSON.parse(options.body);
    assert.deepEqual(Object.keys(payload).sort(), ['messages', 'model', 'options', 'stream']);
    assert.deepEqual(payload.messages.map(m => m.role), ['system', 'user']);
    assert.equal(payload.messages[1].content, 'Профиль');
    assert.equal(payload.stream, false);
    return response('Профиль хранит публичные сведения.');
  } });
  assert.equal((await service.ask('Профиль')).ok, true);
  assert.equal((await service.ask('Профиль')).ok, true);
  assert.equal(calls, 2);
});
test('reject objects, oversized prompts and common pasted secrets before network', async () => {
  let calls = 0;
  const service = createAssistantService({ model: 'test', fetchFn: async () => { calls++; return response('ok'); } });
  for (const prompt of [{ role: 'system' }, '', 'x'.repeat(2001)]) assert.equal((await service.ask(prompt)).error, 'invalid_prompt');
  for (const prompt of ['privateKey=secret', 'password: abc', 'mnemonic=one two', 'пароль: abc', '-----BEGIN PRIVATE KEY-----', 'a'.repeat(64)]) assert.equal((await service.ask(prompt)).error, 'secrets_not_allowed');
  assert.equal(calls, 0);
});
test('timeout releases concurrency lock and aborts provider', async () => {
  let signal;
  const service = createAssistantService({ model: 'test', timeoutMs: 15, fetchFn: (_, options) => { signal = options.signal; return new Promise(() => {}); } });
  const pending = service.ask('test');
  assert.equal((await service.ask('second')).error, 'assistant_busy');
  assert.equal((await pending).error, 'assistant_timeout');
  assert.equal(signal.aborted, true);
  assert.equal((await service.ask('third')).error, 'assistant_timeout');
});
test('cap streamed bytes even when content-length absent', async () => {
  const service = createAssistantService({ model: 'test', fetchFn: async () => new Response('x'.repeat(65537)) });
  assert.equal((await service.ask('test')).error, 'response_too_large');
});
test('reject provider errors, malformed or oversized text and tool calls', async () => {
  const fixtures = [
    [new Response('private infrastructure failure', { status: 500 }), 'provider_unavailable'],
    [new Response('not json'), 'invalid_response'],
    [response('x'.repeat(8001)), 'invalid_response'],
    [new Response(JSON.stringify({ message: { role: 'user', content: 'no' } })), 'invalid_response'],
    [new Response(JSON.stringify({ message: { role: 'assistant', content: 'hello', tool_calls: [{ function: { name: 'transfer' } }] } })), 'invalid_response'],
    [response('privateKey=secret'), 'unsafe_response'],
  ];
  for (const [result, expected] of fixtures) {
    const service = createAssistantService({ model: 'test', fetchFn: async () => result });
    assert.equal((await service.ask('test')).error, expected);
  }
});
test('model-generated instructions are inert text, with no execution or HTML parsing', async () => {
  const text = '<script>transfer()</script> run shell rm -rf /';
  const service = createAssistantService({ model: 'test', fetchFn: async () => response(text) });
  assert.equal((await service.ask('test')).text, text);
});
