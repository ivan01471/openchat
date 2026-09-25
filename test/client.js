/**
 * Minimal WebSocket CLIENT for integration tests (no dependencies).
 * Implements the RFC 6455 handshake and client->server masked frames.
 */
'use strict';

const net = require('node:net');
const crypto = require('node:crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(payload, opcode = 0x1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const mask = crypto.randomBytes(4);
  const len = body.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = body[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

class TestClient {
  constructor(name) {
    this.name = name;
    this.socket = null;
    this.buf = Buffer.alloc(0);
    this.open = false;
    this.closed = false;
    this.messages = [];
    this.waiters = [];
    this.closeCode = null;
    this.handshake = '';
    this.headerBuf = Buffer.alloc(0);
    this.onData = this.#onData.bind(this);
  }

  connect(port, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      this.expectedAccept = crypto.createHash('sha1').update(key + GUID).digest('base64');
      const sock = net.connect(port, host, () => {
        sock.write(
          'GET / HTTP/1.1\r\n' +
          `Host: ${host}:${port}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n' +
          '\r\n',
        );
      });
      this.socket = sock;
      sock.on('data', this.onData);
      sock.on('error', (err) => {
        this.closed = true;
        if (!this.open) reject(err);
        else this.#flushWaiters();
      });
      sock.on('close', () => {
        this.open = false;
        this.closed = true;
        this.#flushWaiters();
      });
      this._resolveConnect = resolve;
      const t = setTimeout(() => {
        if (!this.open && !this.closed) {
          sock.destroy();
          reject(new Error(`${this.name}: connect timeout`));
        }
      }, 5000);
      t.unref && t.unref();
    });
  }

  #onData(chunk) {
    if (!this.open) {
      this.headerBuf = Buffer.concat([this.headerBuf, chunk]);
      const idx = this.headerBuf.indexOf('\r\n\r\n');
      if (idx === -1) {
        if (this.headerBuf.length > 8192) this._resolveConnect({ ok: false, status: 'headers too large' });
        return;
      }
      const head = this.headerBuf.subarray(0, idx + 4).toString('latin1');
      this.handshake = head;
      const rest = this.headerBuf.subarray(idx + 4);
      const status = head.split('\r\n')[0] || '';
      this.socket.removeListener('data', this.onData);
      if (!/ 101 /.test(status)) {
        this.closed = true;
        this.closeCode = Number((status.match(/ (\d{3}) /) || [])[1]) || 0;
        try { this.socket.destroy(); } catch { /* ignore */ }
        return this._resolveConnect({ ok: false, status });
      }
      const m = head.match(/sec-websocket-accept:\s*(\S+)/i);
      if (!m || m[1] !== this.expectedAccept) {
        try { this.socket.destroy(); } catch { /* ignore */ }
        return this._resolveConnect({ ok: false, status: 'bad accept key' });
      }
      this.open = true;
      this.socket.on('data', (c) => this.#onFrame(c));
      if (rest.length) this.#onFrame(rest);
      return this._resolveConnect({ ok: true, status });
    }
    return this.#onFrame(chunk);
  }
  #onFrame(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const opcode = b0 & 0x0f;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      if (this.buf.length < off + len) return;
      const payload = this.buf.subarray(off, off + len);
      this.buf = this.buf.subarray(off + len);

      if (opcode === 0x8) {
        this.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        this.open = false;
        this.closed = true;
        try { this.socket.end(); } catch { /* ignore */ }
        this.#flushWaiters();
        return;
      }
      if (opcode === 0x9) { this.socket.write(encodeFrame(payload, 0xa)); continue; }
      if (opcode === 0xa) continue;
      const text = payload.toString('utf8');
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
      this.messages.push(parsed);
      this.#flushWaiters();
    }
  }

  #flushWaiters() {
    if (!this.waiters.length) return;
    const remaining = [];
    for (const w of this.waiters) {
      const hit = this.messages.find(w.predicate);
      if (hit) { w.resolve(this.messages); continue; }
      if (this.closed) { w.reject(new Error(`${this.name}: socket closed while waiting`)); continue; }
      remaining.push(w);
    }
    this.waiters = remaining;
  }

  send(obj) {
    this.socket.write(encodeFrame(JSON.stringify(obj)));
  }

  sendRaw(text) {
    this.socket.write(encodeFrame(text));
  }

  /** Wait until a message matching `predicate` has arrived. */
  waitFor(predicate, timeoutMs = 5000) {
    if (this.messages.find(predicate)) return Promise.resolve(this.messages);
    return new Promise((resolve, reject) => {
      const w = { predicate, resolve, reject };
      this.waiters.push(w);
      const t = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i !== -1) this.waiters.splice(i, 1);
        const got = this.messages.map((m) => m.type || m.raw).join(', ');
        reject(new Error(`${this.name}: timeout (got: ${got || 'nothing'})`));
      }, timeoutMs);
      t.unref && t.unref();
    });
  }

  /** Await a predicate that must NOT appear yet. */
  expectNot(predicate) {
    return !this.messages.find(predicate);
  }

  find(predicate) {
    return this.messages.find(predicate);
  }

  destroy() {
    try { this.socket.destroy(); } catch { /* ignore */ }
  }
}

module.exports = { TestClient };

