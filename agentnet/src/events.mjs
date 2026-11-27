/* agentnet/events.mjs — события сайта: sequence number, буфер для resume,
   SSE с Last-Event-ID. При обрыве клиент запрашивает snapshot и продолжает с seq. */
'use strict';

export const EVENT_TYPES = Object.freeze([
  'node.discovered', 'node.handshake', 'node.sync_progress', 'node.ready',
  'node.stale', 'node.offline', 'peer.connected', 'peer.disconnected',
  'fork.detected', 'fork.resolved', 'version.outdated', 'incident',
  'indexer.online', 'indexer.offline', 'update.applied', 'update.rolled_back',
]);

export class EventHub {
  constructor({ bufferSize = 1000 } = {}) {
    this.seq = 0;
    this.buffer = [];
    this.bufferSize = bufferSize;
    this.clients = new Set();
  }

  publish(type, data = {}) {
    this.seq++;
    const event = { seq: this.seq, type, data, at: new Date().toISOString() };
    this.buffer.push(event);
    if (this.buffer.length > this.bufferSize) this.buffer.splice(0, this.buffer.length - this.bufferSize);
    const payload = formatSse(event);
    for (const client of this.clients) {
      try { client.res.write(payload); } catch { this._drop(client); }
    }
    return event;
  }

  attach(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'access-control-allow-origin': '*',
    });
    res.write(`retry: 2000\n\n`);
    const url = new URL(req.url, 'http://localhost');
    const lastId = Number(req.headers['last-event-id'] || url.searchParams.get('after') || 0);
    const replay = this.buffer.filter((e) => e.seq > lastId);
    res.write(`event: snapshot\ndata: ${JSON.stringify({ seq: this.seq, replayed: replay.length })}\n\n`);
    for (const e of replay) {
      try { res.write(formatSse(e)); } catch { break; }
    }
    const client = { res, at: Date.now() };
    this.clients.add(client);
    const heartbeat = setInterval(() => {
      try { res.write(`: heartbeat ${Date.now()}\n\n`); } catch { this._drop(client); }
    }, 15000);
    if (heartbeat.unref) heartbeat.unref();
    const cleanup = () => { clearInterval(heartbeat); this._drop(client); };
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('close', cleanup);
    return client;
  }

  _drop(client) {
    this.clients.delete(client);
    try { client.res.end(); } catch { /* noop */ }
  }

  since(seq) {
    return this.buffer.filter((e) => e.seq > Number(seq || 0));
  }

  snapshot() {
    return { seq: this.seq, buffered: this.buffer.length, clients: this.clients.size };
  }

  close() {
    for (const c of [...this.clients]) this._drop(c);
  }
}

export function formatSse(event) {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify({ ...event.data, seq: event.seq, at: event.at })}\n\n`;
}
