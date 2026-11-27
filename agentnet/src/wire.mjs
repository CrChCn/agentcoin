/* agentnet/wire.mjs — TCP-транспорт: 4-байтная длина кадра, лимиты, idle-timeout,
   X25519 ECDH + AES-256-GCM после рукопожатия. Ключи направлений раздельные. */
'use strict';
import crypto from 'node:crypto';
import net from 'node:net';
import { sha256, sha256hex } from './util.mjs';

export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const DEFAULT_IDLE_MS = 120000;

export function encodeFrame(payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  if (data.length > MAX_FRAME_BYTES) throw new Error('frame_too_large');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  return Buffer.concat([head, data]);
}

export function createEphemeralKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return {
    publicKey,
    privateKey,
    pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
  };
}

export function computeSharedSecret(privateKey, peerPubB64u) {
  const peer = crypto.createPublicKey({
    key: Buffer.from(String(peerPubB64u), 'base64url'),
    format: 'der',
    type: 'spki',
  });
  return crypto.diffieHellman({ privateKey, publicKey: peer });
}

export function keyConfirm(sharedSecret, initiatorNonce, responderNonce) {
  return crypto.createHmac('sha256', sharedSecret)
    .update(`${initiatorNonce}|${responderNonce}|agentnet-confirm-v1`)
    .digest('base64url');
}

function directionKey(sharedSecret, label) {
  return sha256(Buffer.concat([Buffer.from(sharedSecret), Buffer.from(`agentnet-v1:${label}`)]));
}

/** Однонаправленный AES-256-GCM с sequence-нонсом. AAD = seq, чтобы кадры нельзя было переставить. */
class Direction {
  constructor(key) {
    this.key = key;
    this.seq = 0;
  }
  seal(plaintext) {
    const nonce = Buffer.alloc(12);
    nonce.writeBigUInt64BE(BigInt(this.seq++), 4);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(nonce);
    const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
    return Buffer.concat([ct, cipher.getAuthTag()]);
  }
  open(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 17) throw new Error('cipher_frame_too_short');
    const tag = buf.subarray(buf.length - 16);
    const ct = buf.subarray(0, buf.length - 16);
    const nonce = Buffer.alloc(12);
    nonce.writeBigUInt64BE(BigInt(this.seq++), 4);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, nonce);
    decipher.setAAD(nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }
}

export function createSecureChannel(sharedSecret, { initiator }) {
  const i2r = new Direction(directionKey(sharedSecret, 'i2r'));
  const r2i = new Direction(directionKey(sharedSecret, 'r2i'));
  return {
    // initiator шлёт i2r и читает r2i; responder — наоборот
    seal: (text) => (initiator ? i2r : r2i).seal(text),
    open: (buf) => (initiator ? r2i : i2r).open(buf),
  };
}

export class FrameStream {
  constructor(socket, { onMessage, onClose, onProtocolError, idleMs = DEFAULT_IDLE_MS, maxFrame = MAX_FRAME_BYTES } = {}) {
    this.socket = socket;
    this.onMessage = onMessage || (() => {});
    this.onClose = onClose || (() => {});
    this.onProtocolError = onProtocolError || (() => {});
    this.maxFrame = maxFrame;
    this.buf = Buffer.alloc(0);
    this.outChannel = null;
    this.inChannel = null;
    this.closed = false;
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.framesIn = 0;
    this.framesOut = 0;
    this.remoteAddress = socket.remoteAddress
      ? String(socket.remoteAddress).replace(/^::ffff:/, '')
      : '';
    socket.setNoDelay(true);
    try { socket.setKeepAlive(true, 30000); } catch { /* noop */ }
    socket.on('data', (chunk) => this._feed(chunk));
    socket.on('error', () => this._finish());
    socket.on('close', () => this._finish());
    socket.on('end', () => this._finish());
    this._touch();
    this._idleTimer = setInterval(() => {
      if (this.closed) return;
      if (Date.now() - this.lastActivity > idleMs) {
        this.close('idle_timeout');
      }
    }, Math.max(1000, Math.floor(idleMs / 4)));
    if (this._idleTimer.unref) this._idleTimer.unref();
  }

  _touch() { this.lastActivity = Date.now(); }

  setInChannel(channel) { this.inChannel = channel; }
  setOutChannel(channel) { this.outChannel = channel; }

  _feed(chunk) {
    if (this.closed) return;
    this._touch();
    this.bytesIn += chunk.length;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.buf.length < 4) return;
      const len = this.buf.readUInt32BE(0);
      if (len === 0 || len > this.maxFrame) {
        this._protocolError(`bad_frame_length:${len}`);
        return;
      }
      if (this.buf.length < 4 + len) return;
      const frame = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      let text;
      try {
        text = this.inChannel ? this.inChannel.open(frame) : frame.toString('utf8');
      } catch (e) {
        this._protocolError(`frame_decrypt_failed:${e.message}`);
        return;
      }
      let msg;
      try { msg = JSON.parse(text); } catch { this._protocolError('bad_json'); return; }
      this.framesIn++;
      try { this.onMessage(msg); } catch (e) { this._protocolError(`handler_error:${e.message}`); return; }
      if (this.closed) return;
    }
  }

  _protocolError(reason) {
    try { this.onProtocolError(reason, this); } catch { /* ignore */ }
    this.close(reason);
  }

  send(obj) {
    if (this.closed) return false;
    const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
    try {
      const payload = this.outChannel ? this.outChannel.seal(text) : Buffer.from(text, 'utf8');
      const frame = encodeFrame(payload);
      this.bytesOut += frame.length;
      this.framesOut++;
      this.socket.write(frame);
      return true;
    } catch {
      this.close('write_failed');
      return false;
    }
  }

  close(reason = 'closed') {
    if (this.closed) return;
    this.reason = reason;
    this._finish();
  }

  _finish() {
    if (this.closed) return;
    this.closed = true;
    if (this._idleTimer) { clearInterval(this._idleTimer); this._idleTimer = null; }
    try { this.socket.end(); } catch { /* ignore */ }
    try { this.socket.destroy(); } catch { /* ignore */ }
    const cb = this.onClose;
    this.onClose = null;
    try { cb(this.reason || 'closed'); } catch { /* ignore */ }
  }

  stats() {
    return {
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      framesIn: this.framesIn,
      framesOut: this.framesOut,
      encrypted: Boolean(this.outChannel && this.inChannel),
    };
  }
}

export function dial({ host, port, timeoutMs = 5000, idleMs = DEFAULT_IDLE_MS, maxFrame = MAX_FRAME_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`dial_timeout:${host}:${port}`));
    }, timeoutMs);
    socket.once('connect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
  });
}

export function createTcpServer({ onConnection, host = '0.0.0.0', port = 0, maxConnections = 64 } = {}) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => onConnection(socket));
    server.maxConnections = maxConnections;
    server.on('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

export function socketFingerprint(socket) {
  return sha256hex(`${socket.remoteAddress || ''}:${socket.remotePort || 0}`).slice(0, 16);
}
