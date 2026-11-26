// AGIP-23.IP: реальный адрес WS-пира за обратным прокси.
// Нода слушает 127.0.0.1, Caddy проксирует входящий /ws — без этой функции у всех
// пиров socket.remoteAddress = 127.0.0.1, и анти-eclipse по /24 + IP-баны не работают.
// Правило: X-Forwarded-For принимается ТОЛЬКО от loopback-соединения (свой Caddy)
// и берётся последний hop — тот, что дописал прокси, поэтому внешняя подделка не проходит.
import test from 'node:test';
import assert from 'node:assert/strict';
import { effectivePeerIp } from '../ws.mjs';

const req = (remoteAddress, xff) => ({
  socket: { remoteAddress },
  headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
});

test('loopback + X-Forwarded-For: берётся адрес клиента', () => {
  assert.equal(effectivePeerIp(req('127.0.0.1', '203.0.113.7')), '203.0.113.7');
});

test('IPv4-mapped loopback распознаётся как петля', () => {
  assert.equal(effectivePeerIp(req('::ffff:127.0.0.1', '203.0.113.7')), '203.0.113.7');
});

test('из цепочки берётся последний hop (его дописал прокси)', () => {
  assert.equal(effectivePeerIp(req('127.0.0.1', '198.51.100.9, 203.0.113.7')), '203.0.113.7');
});

test('IPv6-адрес клиента тоже принимается', () => {
  assert.equal(effectivePeerIp(req('::1', '2001:db8::1')), '2001:db8::1');
});

test('без заголовка остаётся прямой адрес', () => {
  assert.equal(effectivePeerIp(req('127.0.0.1')), '127.0.0.1');
});

test('мусор в заголовке игнорируется — остаётся прямой адрес', () => {
  assert.equal(effectivePeerIp(req('127.0.0.1', 'not-an-ip')), '127.0.0.1');
  assert.equal(effectivePeerIp(req('127.0.0.1', '')), '127.0.0.1');
});

test('подделка с внешнего адреса не проходит: заголовок не читается', () => {
  assert.equal(effectivePeerIp(req('203.0.113.50', '198.51.100.9')), '203.0.113.50');
  assert.equal(effectivePeerIp(req('91.99.191.236', '127.0.0.1')), '91.99.191.236');
});

test('отсутствие сокета не роняет обработчик', () => {
  assert.equal(effectivePeerIp({}), '');
  assert.equal(effectivePeerIp(undefined), '');
});
