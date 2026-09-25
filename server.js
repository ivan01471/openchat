/**
 * OpenChat - anonymous random chat server.
 * ZERO dependencies: only Node.js built-ins (node:http, node:crypto).
 * Run: node server.js
 */
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');

// Tunables (all constants, no magic numbers scattered in the logic).
// Every limit is overridable through the environment so the integration tests
// can run many connections from one IP without tripping the anti-spam rules.
const envInt = (name, fallback) => {
  const v = Number.parseInt(process.env[name], 10);
  return Number.isInteger(v) && v > 0 ? v : fallback;
};

const LIMITS = {
  MAX_MESSAGE_BYTES: envInt('LIMIT_MAX_MESSAGE_BYTES', 2000),
  MAX_NICK_BYTES: envInt('LIMIT_MAX_NICK_BYTES', 24),
  MESSAGES_PER_WINDOW: envInt('LIMIT_MSG_PER_WINDOW', 5),
  RATE_WINDOW_MS: envInt('LIMIT_RATE_WINDOW_MS', 5000),
  CONNECTIONS_PER_IP: envInt('LIMIT_CONN_PER_IP', 30),
  CONNECTION_WINDOW_MS: 60_000,
  CONNECTS_PER_IP_PER_MIN: envInt('LIMIT_JOIN_PER_MIN', 30),
  QUEUE_TIMEOUT_MS: envInt('LIMIT_QUEUE_TIMEOUT_MS', 60_000),
  MIN_AGE: envInt('LIMIT_MIN_AGE', 16),
  MAX_AGE: envInt('LIMIT_MAX_AGE', 99),
  BAN_MS: envInt('LIMIT_BAN_MS', 10 * 60_000),
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:; " +
    "img-src 'self' data: https:; font-src 'self' https: data:; connect-src 'self' ws: wss: https:; " +
    "frame-src 'self' https:; " +
    "base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

// ---------------------------------------------------------------------------
// Rolling-window rate limiter
// ---------------------------------------------------------------------------
class RateLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }
  /** @returns {true|number} true when allowed, otherwise ms until retry */
  take(key, cost = 1) {
    const now = Date.now();
    const arr = this.hits.get(key);
    if (!arr) {
      this.hits.set(key, [now]);
      return true;
    }
    while (arr.length && now - arr[0] >= this.windowMs) arr.shift();
    if (arr.length + cost > this.limit) return this.windowMs - (now - arr[0]);
    for (let i = 0; i < cost; i++) arr.push(now);
    return true;
  }
  sweep() {
    const now = Date.now();
    for (const [k, arr] of this.hits) {
      while (arr.length && now - arr[0] >= this.windowMs) arr.shift();
      if (arr.length === 0) this.hits.delete(k);
    }
  }
}

const msgLimiter = new RateLimiter(LIMITS.MESSAGES_PER_WINDOW, LIMITS.RATE_WINDOW_MS);
const connLimiter = new RateLimiter(LIMITS.CONNECTIONS_PER_IP, LIMITS.CONNECTION_WINDOW_MS);
const joinLimiter = new RateLimiter(LIMITS.CONNECTS_PER_IP_PER_MIN, 60_000);

/** IP ban list: ip -> expiry timestamp */
const banned = new Map();
function isBanned(ip) {
  const exp = banned.get(ip);
  if (!exp) return false;
  if (Date.now() > exp) {
    banned.delete(ip);
    return false;
  }
  return true;
}
function ban(ip) {
  banned.set(ip, Date.now() + LIMITS.BAN_MS);
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, exp] of banned) if (now > exp) banned.delete(ip);
  msgLimiter.sweep();
  connLimiter.sweep();
  joinLimiter.sweep();
}, 60_000).unref();

// ---------------------------------------------------------------------------
// Minimal RFC 6455 WebSocket implementation (server side, text frames only)
// ---------------------------------------------------------------------------
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

/** Build a server->client unmasked frame. */
function frame(payload, opcode = 0x1) {
  const body = Buffer.from(payload, 'utf8');
  const len = body.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, body]);
}

/** Incremental frame decoder: fragmentation, masking, ping/pong/close. */
class FrameDecoder {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.fragments = [];
  }
  /** @param {Buffer} chunk @returns {{type:string,payload?:Buffer,code?:number}[]} */
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out = [];
    for (;;) {
      if (this.buf.length < 2) break;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buf.length < 4) break;
        len = this.buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) break;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(64 * 1024 * 1024)) throw new Error('frame too large');
        len = Number(big);
        offset = 10;
      }
      if (len > 64 * 1024 * 1024) throw new Error('frame too large');
      if (masked) {
        if (this.buf.length < offset + 4) break;
        const maskKey = this.buf.subarray(offset, offset + 4);
        offset += 4;
        let payload = this.buf.subarray(offset, offset + len);
        if (this.buf.length < offset + len) break;
        const un = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) un[i] = payload[i] ^ maskKey[i & 3];
        payload = un;
        this.buf = this.buf.subarray(offset + len);
        const handled = this.#classify(payload, fin, opcode, out);
        if (handled === 'return') return out;
        continue;
      }
      if (this.buf.length < offset + len) break;
      const payload = this.buf.subarray(offset, offset + len);
      this.buf = this.buf.subarray(offset + len);
      const handled = this.#classify(payload, fin, opcode, out);
      if (handled === 'return') return out;
    }
    return out;
  }

  /** @returns {'continue'|'return'} */
  #classify(payload, fin, opcode, out) {
    if (opcode === 0x8) {
      out.push({ type: 'close', code: payload.length >= 2 ? payload.readUInt16BE(0) : 1005 });
      return 'return';
    }
    if (opcode === 0x9) { out.push({ type: 'ping' }); return 'continue'; }
    if (opcode === 0xa) { out.push({ type: 'pong' }); return 'continue'; }
    if (opcode === 0x1 || opcode === 0x2) {
      if (fin) out.push({ type: 'message', payload });
      else this.fragments = [payload];
      return 'continue';
    }
    if (opcode === 0x0) {
      this.fragments.push(payload);
      if (fin) {
        out.push({ type: 'message', payload: Buffer.concat(this.fragments) });
        this.fragments = [];
      }
      return 'continue';
    }
    throw new Error('unsupported opcode ' + opcode);
  }
}

// ---------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------
/** @type {Set<Client>} */
const clients = new Set();
/** Waiting queue of clients looking for a partner. */
const queue = [];
let seq = 0;

function json(obj) {
  return JSON.stringify(obj);
}

function sanitizeNick(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/\s+/g, ' ');
  const buf = Buffer.from(s, 'utf8');
  if (buf.length > LIMITS.MAX_NICK_BYTES) s = buf.subarray(0, LIMITS.MAX_NICK_BYTES).toString('utf8');
  return s;
}

function sanitizeMessage(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  if (Buffer.byteLength(s, 'utf8') > LIMITS.MAX_MESSAGE_BYTES) {
    s = Buffer.from(s, 'utf8').subarray(0, LIMITS.MAX_MESSAGE_BYTES).toString('utf8');
  }
  if (!s.trim()) return null;
  return s;
}

class Client {
  constructor(socket, ip) {
    this.id = ++seq;
    this.socket = socket;
    this.ip = ip;
    this.nick = '';
    this.age = null;
    this.gender = 'any';
    this.lookingFor = 'any';
    this.country = 'any';
    this.lang = 'any';
    this.partner = null;
    this.queueSince = 0;
    this.decoder = new FrameDecoder();
    this.alive = true;
    this.blocked = new Set();
  }

  send(obj) {
    if (!this.alive || this.socket.destroyed) return;
    try {
      this.socket.write(frame(json(obj)));
    } catch {
      this.destroy();
    }
  }

  close() {
    if (!this.alive) return;
    try { this.socket.write(frame('', 0x8)); } catch { /* ignore */ }
    this.destroy();
  }

  destroy() {
    if (!this.alive) return;
    this.alive = false;
    try { this.socket.destroy(); } catch { /* ignore */ }
    leaveQueue(this);
    unpair(this, 'gone');
    clients.delete(this);
    broadcastUserList();
  }
}

// ---------------------------------------------------------------------------
// Pairing engine
// ---------------------------------------------------------------------------
function leaveQueue(client) {
  const i = queue.indexOf(client);
  if (i !== -1) queue.splice(i, 1);
  client.queueSince = 0;
}

function preferencesMatch(a, b) {
  // `gender` is the user's own gender (for display); `lookingFor` is the filter.
  // "any" on either side of a comparison acts as a wildcard.
  const wants = (seeker, peerGender) =>
    seeker.lookingFor === 'any' || peerGender === 'any' || seeker.lookingFor === peerGender;

  if (!wants(a, b.gender) || !wants(b, a.gender)) return false;
  if (a.lang !== 'any' && b.lang !== 'any' && a.lang !== b.lang) return false;
  if (a.country !== 'any' && b.country !== 'any' && a.country !== b.country) return false;
  return true;
}

/** Try to pair everyone in the queue who has a compatible partner. */
function drainQueue() {
  let guard = 0;
  for (let i = 0; i < queue.length; i++) {
    if (++guard > 10_000) break;
    const a = queue[i];
    if (!a.alive) continue;
    for (let j = i + 1; j < queue.length; j++) {
      const b = queue[j];
      if (!b.alive) continue;
      // NOTE: we deliberately do NOT filter on IP here.
      // Filtering same-IP pairs looks like an anti-abuse measure but breaks
      // real users: carriers CGNAT thousands of subscribers behind a single
      // address, and people on the same home/office network would never be
      // able to talk to each other. Self-pairing is structurally impossible
      // because each Client instance is one distinct socket.
      if (!preferencesMatch(a, b)) continue;
      queue.splice(j, 1);
      queue.splice(i, 1);
      i--;
      pair(a, b);
      break;
    }
  }
}

function pair(a, b) {
  a.partner = b;
  b.partner = a;
  a.queueSince = 0;
  b.queueSince = 0;
  a.send({ type: 'matched', peer: { nick: b.nick, gender: b.gender, age: b.age, country: b.country } });
  b.send({ type: 'matched', peer: { nick: a.nick, gender: a.gender, age: a.age, country: a.country } });
  broadcastUserList();
}

function getPublicUserList() {
  const users = [];
  for (const c of clients) {
    if (c.alive && c.nick) {
      users.push({
        id: c.id,
        nick: c.nick,
        age: c.age,
        gender: c.gender,
        country: c.country,
        busy: !!c.partner,
      });
    }
  }
  return users;
}

function broadcastUserList() {
  const users = getPublicUserList();
  const payload = frame(json({ type: 'user_list', users }));
  for (const c of clients) {
    if (c.alive && !c.socket.destroyed) {
      try { c.socket.write(payload); } catch { /* ignore */ }
    }
  }
}

/** Notify the remaining partner that the other side left. */
function unpair(client, reason) {
  const p = client.partner;
  if (!p) return;
  client.partner = null;
  p.partner = null;
  p.send({ type: 'left', reason });
  broadcastUserList();
}

function enqueue(client) {
  if (queue.includes(client)) return;
  client.queueSince = Date.now();
  queue.push(client);
  client.send({ type: 'waiting' });
  drainQueue();
}

/** Drop queue entries that have been waiting too long. */
setInterval(() => {
  const now = Date.now();
  for (let i = queue.length - 1; i >= 0; i--) {
    const c = queue[i];
    if (!c.alive) { queue.splice(i, 1); continue; }
    if (c.queueSince && now - c.queueSince > LIMITS.QUEUE_TIMEOUT_MS) {
      queue.splice(i, 1);
      c.queueSince = 0;
      c.send({ type: 'queue_timeout' });
    }
  }
}, 5000).unref();

function stats() {
  let waiting = 0;
  let paired = 0;
  for (const c of clients) {
    if (c.partner) paired++;
    else if (c.queueSince) waiting++;
  }
  return { connected: clients.size, waiting, pairs: Math.floor(paired / 2), banned: banned.size };
}

// ---------------------------------------------------------------------------
// Message protocol (client -> server)
// ---------------------------------------------------------------------------
function sendError(c, code, message, extra = {}) {
  c.send({ type: 'error', code, message, ...extra });
}

function handlePayload(c, obj) {
  if (!obj || typeof obj !== 'object') return;
  switch (obj.type) {
    case 'join': return onJoin(c, obj);
    case 'message': return onMessage(c, obj);
    case 'next': return onNext(c);
    case 'leave': return onLeave(c);
    case 'report': return onReport(c);
    case 'block': return onBlock(c);
    case 'typing': return onTyping(c, obj);
    case 'start_private': return onStartPrivate(c, obj);
    case 'get_users': return c.send({ type: 'user_list', users: getPublicUserList() });
    case 'ping': return c.send({ type: 'pong', ts: Date.now() });
    default: return sendError(c, 'unknown_type', 'Unknown message type.');
  }
}

function onJoin(c, obj) {
  if (c.partner || c.queueSince) {
    return sendError(c, 'already_active', 'You are already searching or chatting.');
  }
  const join = joinLimiter.take(c.ip);
  if (join !== true) {
    return sendError(c, 'rate_limited', 'Too many attempts. Please wait.', { retryAfter: join });
  }

  const nick = sanitizeNick(obj.nick);
  if (nick.length < 2) {
    return sendError(c, 'bad_nick', 'Nickname must be at least 2 characters.');
  }
  const age = Number.parseInt(obj.age, 10);
  if (!Number.isInteger(age) || age < LIMITS.MIN_AGE || age > LIMITS.MAX_AGE) {
    return sendError(c, 'bad_age', `Age must be between ${LIMITS.MIN_AGE} and ${LIMITS.MAX_AGE}.`);
  }
  const GENDERS = ['any', 'male', 'female', 'other'];
  const gender = GENDERS.includes(obj.gender) ? obj.gender : 'any';
  const lookingFor = GENDERS.includes(obj.lookingFor) ? obj.lookingFor : 'any';
  const lang = typeof obj.lang === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(obj.lang) ? obj.lang : 'any';
  const country = typeof obj.country === 'string' && /^[A-Za-z0-9 ?_=-]{0,16}$/.test(obj.country)
    ? obj.country.trim() || 'any' : 'any';

  c.nick = nick;
  c.age = age;
  c.gender = gender;
  c.lookingFor = lookingFor;
  c.lang = lang;
  c.country = country;
  c.send({ type: 'joined', you: { nick, age, gender, lookingFor, lang, country } });
  enqueue(c);
  broadcastUserList();
}

function onMessage(c, obj) {
  if (!c.partner) return sendError(c, 'no_partner', 'You are not in a conversation.');
  const allowed = msgLimiter.take(c.id);
  if (allowed !== true) {
    return sendError(c, 'rate_limited', 'You are sending messages too fast.', { retryAfter: allowed });
  }
  const text = sanitizeMessage(obj.text);
  if (text === null) return sendError(c, 'empty', 'Message is empty.');
  if (c.partner.blocked.has(c.id)) return; // silently dropped for a blocker
  c.partner.send({ type: 'message', from: c.nick, text, ts: Date.now() });
}

function onNext(c) {
  unpair(c, 'next');
  leaveQueue(c);
  if (c.nick) enqueue(c);
}

function onLeave(c) {
  unpair(c, 'left');
  leaveQueue(c);
  c.send({ type: 'idle' });
  broadcastUserList();
}

function onReport(c) {
  if (!c.partner) return sendError(c, 'no_partner', 'Nobody to report.');
  const p = c.partner;
  ban(p.ip);
  // Detach BEFORE destroying: otherwise p.destroy() -> unpair() would already
  // clear c.partner and the reporter would receive a generic "left" notice.
  c.partner = null;
  p.partner = null;
  p.send({ type: 'banned', reason: 'reported' });
  p.destroy();
  c.send({ type: 'reported' });
  leaveQueue(c);
  enqueue(c);
}

function onBlock(c) {
  if (!c.partner) return sendError(c, 'no_partner', 'Nobody to block.');
  const p = c.partner;
  c.blocked.add(p.id);
  unpair(c, 'blocked');
  leaveQueue(c);
  enqueue(c);
}

function onTyping(c, obj) {
  if (!c.partner) return;
  if (Date.now() - c.lastTypeAt < 800) return; // throttle
  c.lastTypeAt = Date.now();
  c.partner.send({ type: 'typing', on: obj.on === true });
}

function onStartPrivate(c, obj) {
  const targetId = Number(obj.targetId);
  if (!targetId || targetId === c.id) return sendError(c, 'invalid_target', 'Cible invalide.');
  let target = null;
  for (const client of clients) {
    if (client.id === targetId && client.alive) {
      target = client;
      break;
    }
  }
  if (!target) return sendError(c, 'user_offline', 'Cet utilisateur n\'est plus connecté.');
  if (target.blocked.has(c.id)) return sendError(c, 'blocked', 'Impossible de contacter cet utilisateur.');

  // Unpair any active chats
  unpair(c, 'new_chat');
  leaveQueue(c);
  unpair(target, 'new_chat');
  leaveQueue(target);

  pair(c, target);
}

// ---------------------------------------------------------------------------
// Static files (with path traversal protection)
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  const resolved = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!resolved.startsWith(PUBLIC_DIR + path.sep) && resolved !== PUBLIC_DIR) {
    res.writeHead(403, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }

  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket upgrade
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
    return res.end(JSON.stringify(stats()));
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', ...SECURITY_HEADERS });
    return res.end('Method not allowed');
  }
  serveStatic(req, res);
});

function clientIp(req) {
  // No reverse-proxy trust by default: use the socket address.
  return req.socket.remoteAddress || 'unknown';
}

server.on('upgrade', (req, socket, head) => {
  const ip = clientIp(req);
  const key = req.headers['sec-websocket-key'];
  const version = req.headers['sec-websocket-version'];
  const upgrade = (req.headers.upgrade || '').toLowerCase();

  const reject = (code, msg) => {
    socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };

  if (upgrade !== 'websocket' || !key) return reject(400, 'Bad Request');
  if (version !== '13') return reject(426, 'Upgrade Required');
  if (isBanned(ip)) return reject(403, 'Forbidden');

  const conn = connLimiter.take(ip);
  if (conn !== true) return reject(429, 'Too Many Requests');

  socket.setNoDelay(true);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n` +
    '\r\n',
  );

  const c = new Client(socket, ip);
  clients.add(c);
  c.send({ type: 'hello', limits: { maxMessage: LIMITS.MAX_MESSAGE_BYTES, minAge: LIMITS.MIN_AGE } });
  c.send({ type: 'stats', ...stats() });

  if (head && head.length) {
    try {
      for (const ev of c.decoder.push(head)) handleSocketEvent(c, ev);
    } catch { c.close(); }
  }

  socket.on('data', (chunk) => {
    let events;
    try {
      events = c.decoder.push(chunk);
    } catch {
      return c.close();
    }
    for (const ev of events) {
      if (!c.alive) break;
      handleSocketEvent(c, ev);
    }
  });
  socket.on('error', () => c.destroy());
  socket.on('end', () => c.destroy());
  socket.on('close', () => c.destroy());
});

function handleSocketEvent(c, ev) {
  if (ev.type === 'ping') {
    try { c.socket.write(frame('', 0xa)); } catch { c.destroy(); }
    return;
  }
  if (ev.type === 'close') return c.close();
  if (ev.type !== 'message') return;

  let obj;
  try {
    obj = JSON.parse(ev.payload.toString('utf8'));
  } catch {
    return sendError(c, 'bad_json', 'Malformed payload.');
  }
  try {
    handlePayload(c, obj);
  } catch (err) {
    // Never leak internals to the client; log server-side only.
    console.error('[handler]', err && err.message);
    sendError(c, 'server_error', 'Unexpected error.');
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`OpenChat listening on http://localhost:${PORT}`);
  console.log('Zero dependencies. Only Node.js built-ins.');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const c of [...clients]) c.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}

process.on('uncaughtException', (err) => {
  console.error('[uncaught]', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandled]', err);
});





