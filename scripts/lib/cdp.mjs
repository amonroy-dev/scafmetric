// Minimal Chrome DevTools Protocol client: a hand-rolled WebSocket (RFC 6455)
// over node:http's upgrade event, so the visual harness needs no dependencies.
//
// Only what CDP actually needs: text frames, continuation frames, ping/pong.

import { request } from 'node:http';
import { randomBytes } from 'node:crypto';

function openSocket(wsUrl) {
  const u = new URL(wsUrl);
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
      },
    });
    req.on('upgrade', (_res, socket) => { socket.setNoDelay(true); resolve(socket); });
    req.on('response', res => reject(new Error(`websocket upgrade refused: HTTP ${res.statusCode}`)));
    req.on('error', reject);
    req.end();
  });
}

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, 0x80 | len]);
  else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const mask = randomBytes(4);
  const body = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, body]);
}

export class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this._buf = Buffer.alloc(0);
    this._parts = [];
    this._partOpcode = 0;
    this.closed = false;
    socket.on('data', chunk => { this._buf = Buffer.concat([this._buf, chunk]); this._drain(); });
    socket.on('close', () => { this.closed = true; for (const p of this.pending.values()) p.reject(new Error('cdp socket closed')); this.pending.clear(); });
    socket.on('error', () => { this.closed = true; });
  }

  static async attach(wsUrl) { return new Cdp(await openSocket(wsUrl)); }

  _drain() {
    for (;;) {
      const b = this._buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (masked) off += 4; // servers must not mask, but stay tolerant
      if (b.length < off + len) return;
      const payload = b.subarray(off, off + len);
      this._buf = b.subarray(off + len);

      if (opcode === 0x9) { this.socket.write(encodeFrame(0xa, payload)); continue; } // ping
      if (opcode === 0xa) continue;                                                   // pong
      if (opcode === 0x8) { this.socket.end(); this.closed = true; return; }          // close
      if (opcode === 0x0) this._parts.push(payload);
      else { this._parts = [payload]; this._partOpcode = opcode; }
      if (!fin) continue;
      const full = Buffer.concat(this._parts);
      this._parts = [];
      if (this._partOpcode === 0x1) this._dispatch(full.toString('utf8'));
    }
  }

  _dispatch(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message}${msg.error.data ? `: ${msg.error.data}` : ''}`));
      else resolve(msg.result);
      return;
    }
    if (msg.method) for (const fn of this.listeners.get(msg.method) || []) fn(msg.params || {});
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  send(method, params = {}, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error('cdp socket closed'));
    const id = this.nextId++;
    const frame = encodeFrame(0x1, Buffer.from(JSON.stringify({ id, method, params }), 'utf8'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`cdp timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject: e => { clearTimeout(timer); reject(e); },
      });
      this.socket.write(frame);
    });
  }

  /** Run an expression in the page and return its value (awaiting promises). */
  async evaluate(expression, { awaitPromise = true } = {}) {
    const res = await this.send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true, userGesture: true,
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(d.exception?.description || d.text || 'page exception');
    }
    return res.result?.value;
  }

  close() { if (!this.closed) { try { this.socket.end(); } catch { /* already gone */ } this.closed = true; } }
}

/** Ask the browser for its page target, retrying while Chrome starts up. */
export async function browserTargets(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const body = await new Promise((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port, path: '/json/list' }, res => {
          const parts = [];
          res.on('data', c => parts.push(c));
          res.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
        });
        req.on('error', reject);
        req.end();
      });
      const list = JSON.parse(body);
      if (Array.isArray(list) && list.some(t => t.type === 'page')) return list;
    } catch { /* not listening yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`Chrome never opened a debugging port on ${port}`);
}
