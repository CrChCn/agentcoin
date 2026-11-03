#!/usr/bin/env node
// TZ-1.1-FINAL / AC-6.2 — стресс FR-P2P-06 (rate limit):
//   node tools/rate-test.mjs http://127.0.0.1:9461
// Скрипт открывает WS к ноде и шлёт >100 msg/s (по умолчанию AGT_WS_MSG_RATE=100).
// Ожидаемо: сервер шлёт "[ws] rate-limit <peer>: N msg/s > cap → disconnect" и рвёт соединение.
import { connectClient } from '../ws.mjs';

const target = process.argv[2] || 'http://127.0.0.1:9461';
const flood = Number(process.argv[3] || 400); // сообщений суммарно
const selfUrl = 'http://127.0.0.1:99999-ratetest';

const timeout = setTimeout(() => { console.log('RESULT: no close in 5 s (rate-limit НЕ сработал?)'); process.exit(2); }, 5000);

try {
  const peer = await connectClient(`${target}/ws?their=${encodeURIComponent(selfUrl)}`, { timeoutMs: 4000 });
  console.log('connected → flooding', flood, 'msgs rapid-fire');
  for (let i = 0; i < flood; i++) peer.send('{"type":"ping","i":' + i + '}');
  peer.onClose = () => {
    clearTimeout(timeout);
    console.log('RESULT: DISCONNECTED by server after flood', flood, 'msgs (rate-limit сработал)');
    process.exit(0);
  };
} catch (e) {
  clearTimeout(timeout);
  console.log('RESULT: connect failed:', e.message);
  process.exit(1);
}
