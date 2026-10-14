#!/usr/bin/env node
/* ============================================================
   ws.mjs — минимальный WebSocket-сервер (RFC 6455) без зависимостей.
   Нужно для P2P-полнасти (fullmesh, inv-рассылка) между нодами AGT.
   Поддерживается: рукопожатие (Sec-WebSocket-Accept), текстовые фреймы,
   ping/pong, close, маскированные клиентские фреймы (обязательны по RFC),
   126/127-bit длины. Фрагментация не поддерживается (не нужна для JSON).
   ============================================================ */
'use strict';
import crypto from 'node:crypto';
import http from 'node:http';

export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export function acceptKey(secWebSocketKey) {
  return crypto.createHash('sha1').update(secWebSocketKey + WS_GUID).digest('base64');
}

// --- кодирование исходящего фрейма (сервер не маскирует) ---
const OP_TEXT = 0x1, OP_PING = 0x9, OP_PONG = 0xA, OP_CLOSE = 0x8;
export function encodeFrame(opcode, payload) {
  const pl = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const len = pl.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, pl]);
}

// --- парсер входного потока: маскированные клиентские фреймы ---
export function decodeFrames(buf) {
  // возвращает { frames: [...], rest: Buffer } — незавершённый хвост остаётся
  const frames = [];
  let off = 0;
  while (off + 2 <= buf.length) {
    const b0 = buf[off], b1 = buf[off + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let pos = off + 2;
    if (len === 126) {
      if (buf.length < pos + 2) break;
      len = buf.readUInt16BE(pos); pos += 2;
    } else if (len === 127) {
      if (buf.length < pos + 8) break;
      len = Number(buf.readBigUInt64BE(pos)); pos += 8;
    }
    let mask = null;
    if (masked) {
      if (buf.length < pos + 4) break;
      mask = buf.subarray(pos, pos + 4); pos += 4;
    }
    if (buf.length < pos + len) break; // фрейм не пришёл целиком — ждать
    let payload = buf.subarray(pos, pos + len);
    if (masked) {
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    frames.push({ fin, opcode, payload });
    off = pos + len;
  }
  return { frames, rest: off > 0 ? buf.subarray(off) : buf };
}

// --- PeerSocket: обёртка net.Socket + handshake ---
// События: onMessage(str), onClose().
export class PeerSocket {
  constructor(socket, initialBuf, isClient = false) {
    this.socket = socket;
    this.isClient = Boolean(isClient);
    this.closed = false;
    this.onMessage = null;
    this.onClose = null;
    this._buf = initialBuf || Buffer.alloc(0);
    socket.on('data', (chunk) => this._feed(chunk));
    socket.on('close', () => this._close());
    socket.on('error', () => this._close());
    socket.on('end', () => this._close());
    this._pingTimer = setInterval(() => this.send('{"type":"ping"}'), 20_000);
  }
  // сервер — без маски; клиент — маскированные фреймы (RFC 6455 обязанность)
  _writeFrame(opcode, payload) {
    const pl = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
    const len = pl.length;
    let header;
    if (len < 126) header = Buffer.from([0x80 | opcode, len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
    if (this.isClient) {
      const mask = crypto.randomBytes(4);
      const masked = Buffer.from(pl);
      for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
      return Buffer.concat([header, mask, masked]);
    }
    return Buffer.concat([header, pl]);
  }
  _feed(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    const { frames, rest } = decodeFrames(this._buf);
    this._buf = rest;
    for (const f of frames) {
      if (process.env.AGT_WS_DEBUG) console.log(`[ws frame] op=${f.opcode} len=${f.payload.length}`);
      if (f.opcode === OP_PING) { try { this.socket.write(this._writeFrame(OP_PONG, f.payload)); } catch {} continue; }
      if (f.opcode === OP_PONG) continue;
      if (f.opcode === OP_CLOSE) { this.close(); return; }
      if (f.opcode === OP_TEXT) {
        const txt = f.payload.toString('utf8');
        if (this.onMessage) { try { this.onMessage(txt); } catch {} }
      }
    }
  }
  send(text) {
    if (this.closed) return;
    try { this.socket.write(this._writeFrame(OP_TEXT, text)); } catch {}
  }
  // приветствие сервера (после конструктора)
  welcome(selfUrl) { this.sendJson({ type: 'welcome', self: selfUrl, ts: Date.now() }); }
  sendJson(obj) { this.send(JSON.stringify(obj)); }
  close() {
    if (this.closed) return;
    this.closed = true;
    this._close();
  }
  _close() {
    this.closed = true;
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    try { this.socket.end(); } catch {}
    if (this.onClose) { const cb = this.onClose; this.onClose = null; cb(); }
  }
}

// --- Клиент: исходящее WS-подключение к пиру (полнасти BOTH стороны) ---
// url = http://host:port/ws?their=<selfUrl>. Возвращает Promise<PeerSocket>.
export function connectClient(urlStr, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: u.hostname, port: Number(u.port) || 80, path: u.pathname + u.search,
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
      },
    });
    const to = setTimeout(() => { req.destroy(new Error('ws connect timeout')); }, timeoutMs);
    req.on('upgrade', (res, socket, head) => {
      const expect = acceptKey(key);
      if (res.headers['sec-websocket-accept'] !== expect) { socket.destroy(); return reject(new Error('ws accept key mismatch')); }
      clearTimeout(to);
      const peer = new PeerSocket(socket, head, true);
      if (process.env.AGT_WS_DEBUG) socket.on('data', (c) => console.log(`[ws raw cli] ${c.length}B ${c.toString('hex').slice(0, 28)}...`));
      resolve(peer);
    });
    req.on('response', (res) => { req.destroy(); reject(new Error(`ws upgrade refused: HTTP ${res.statusCode}`)); });
    req.on('error', (e) => { clearTimeout(to); reject(e); });
    req.end();
  });
}

// --- Hub: реестр подключённых пиров одной ноды + inv-рассылка ---
// Типы сообщений (JSON over WS):
//   {type:'ping'} / {type:'pong'}
//   {type:'inv-block', block: {...}} — анонс нового блока (payload полный)
//   {type:'inv-tx', tx: {...}}       — анонс новой транзакции
// Приёмник решает, имеет ли эту же info: дубликат игнорируется
// (inv = inventory style: сначала короткий анонс, забор полный через HTTP при развилке).
export class WsHub {
  constructor() {
    this.peers = new Set(); // PeerSocket
  }
  attachServer(server, selfUrl, { onBlock, onTx, onPeer } = {}) {
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/ws') { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
      const key = req.headers['sec-websocket-key'];
      if (!key) { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); return; }
      const accept = acceptKey(key);
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        '\r\n'
      );
      const peer = new PeerSocket(socket, head);
      peer.self = selfUrl;
      peer.theirUrl = `${url.searchParams.get('their') || 'ws-peer'}`;
      if (process.env.AGT_WS_DEBUG) {
        socket.on('data', (c) => console.log(`[ws raw srv] ${c.length}B ${c.toString('hex').slice(0, 28)}...`));
      }
      this.peers.add(peer);
      peer.onClose = () => this.peers.delete(peer);
      peer.onMessage = (txt) => this._onIncoming(peer, txt, { onBlock, onTx });
      if (onPeer) onPeer(peer);
    });
  }
  broadcast(obj, exclude) {
    const txt = JSON.stringify(obj);
    for (const p of this.peers) {
      if (p === exclude) continue;
      p.send(txt);
    }
    return this.peers.size;
  }
  count() { return this.peers.size; }
  roster() { return [...this.peers].map(p => ({ theirUrl: p.theirUrl, self: p.self })); }

  // приём upstream: дубликаты отсекаются на уровне наших данных
  _onIncoming(peer, txt, handlers) {
    let msg = null;
    try { msg = JSON.parse(txt); } catch { return; }
    if (process.env.AGT_WS_DEBUG) console.log(`[wsHub] in: ${String(txt).slice(0, 80)}`);
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ping') { peer.sendJson({ type: 'pong', ts: Date.now() }); return; }
    if (msg.type === 'pong') return;
    if (msg.type === 'inv-block' && handlers.onBlock) { handlers.onBlock(msg, peer); return; }
    if (msg.type === 'inv-tx' && handlers.onTx) { handlers.onTx(msg, peer); return; }
  }
}
