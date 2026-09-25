/**
 * Integration test suite. Starts the real server, drives it over a real
 * WebSocket connection, and asserts observable behaviour.
 * Run: npm test
 */
'use strict';

const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const { TestClient: BaseTestClient } = require('./client');

/**
 * Every client created during a test is tracked so it can be torn down right
 * after each test. Without this, a client left in the matching queue would
 * silently pollute the following test and produce false results.
 */
const openClients = [];
class TestClient extends BaseTestClient {
  constructor(name) {
    super(name);
    openClients.push(this);
  }
}

function closeOpenClients() {
  for (const c of openClients) {
    try { c.destroy(); } catch { /* ignore */ }
  }
  openClients.length = 0;
}

const PORT = 3457;
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const SERVER = path.join(__dirname, '..', 'server.js');

let passed = 0;
const failures = [];

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  \u2717 ${name}\n      ${err.message}`);
  } finally {
    // Always reset the matching queue so tests stay independent.
    closeOpenClients();
    await sleep(60);
  }
}

function httpGet(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get(BASE + pathname, { timeout: 4000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('http timeout')); });
    req.on('error', reject);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Connect + join in one step. */
async function makeClient(name, profile) {
  const c = new TestClient(name);
  const res = await c.connect(PORT, HOST);
  assert(res.ok, `${name}: handshake failed (${res.status})`);
  c.send({ type: 'join', ...profile });
  return c;
}

const PROFILE_A = { nick: 'Alice', age: 24, gender: 'female', lookingFor: 'any', lang: 'fr' };
const PROFILE_B = { nick: 'Bob', age: 30, gender: 'male', lookingFor: 'any', lang: 'fr' };

// ---------------------------------------------------------------------------
// Server harness
// ---------------------------------------------------------------------------
function spawnServer(port, env = {}) {
  const proc = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      LIMIT_CONN_PER_IP: '500',
      LIMIT_JOIN_PER_MIN: '500',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (d) => process.stderr.write(`[srv:${port}] ${d}`));
  return proc;
}

async function waitForHealth(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await httpGetPath(port, '/healthz');
      if (r.status === 200) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server on ${port} did not become healthy`);
    await sleep(120);
  }
}

function httpGetPath(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://${HOST}:${port}${pathname}`, { timeout: 3000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

/** Raw upgrade attempt so we can control the Sec-WebSocket-Version header. */
function rawUpgrade(port, extraHeaders) {
  return new Promise((resolve) => {
    const net = require('node:net');
    const key = Buffer.from('0123456789abcdef').toString('base64');
    const sock = net.connect(port, HOST, () => {
      sock.write(
        'GET / HTTP/1.1\r\n' +
        `Host: ${HOST}:${port}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: ${extraHeaders.version || '13'}\r\n` +
        (extraHeaders.upgrade ? '' : 'X-Ignore: 1\r\n') +
        '\r\n',
      );
    });
    let buf = Buffer.alloc(0);
    const onData = (c) => {
      buf = Buffer.concat([buf, c]);
      const s = buf.toString('latin1');
      if (s.includes('\r\n\r\n') || buf.length > 4096) {
        sock.removeListener('data', onData);
        sock.destroy();
        resolve(s);
      }
    };
    sock.on('data', onData);
    sock.on('error', () => resolve(''));
    setTimeout(() => { sock.destroy(); resolve(buf.toString('latin1')); }, 3000).unref();
  });
}

const cleanups = [];
async function withServer(port, env, fn) {
  const proc = spawnServer(port, env);
  cleanups.push(proc);
  await waitForHealth(port);
  try {
    return await fn();
  } finally {
    try { proc.kill(); } catch { /* ignore */ }
  }
}
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
async function main() {
  const live = spawnServer(PORT);
  cleanups.push(live);

  console.log('\nHTTP + security');
  await waitForHealth(PORT);

  await test('GET / serves the app', async () => {
    const r = await httpGet('/');
    assert(r.status === 200, `status ${r.status}`);
    assert(r.body.includes('OpenChat'), 'missing brand');
    assert((r.headers['content-type'] || '').includes('text/html'), 'bad content-type');
  });

  await test('security headers are set (CSP, nosniff, frame DENY)', async () => {
    const r = await httpGet('/');
    assert(r.headers['content-security-policy'], 'missing CSP');
    assert(r.headers['x-content-type-options'] === 'nosniff', 'missing nosniff');
    assert(r.headers['x-frame-options'] === 'DENY', 'missing XFO');
    assert(r.headers['referrer-policy'] === 'no-referrer', 'missing referrer-policy');
    assert(!r.headers['server'], 'server header should not leak');
  });

  await test('path traversal is blocked', async () => {
    const r = await httpGet('/%2e%2e/%2e%2e/server.js');
    assert(r.status === 403 || r.status === 404, `status ${r.status}`);
    assert(!r.body.includes('require('), 'server source leaked!');
  });

  await test('unknown path returns 404', async () => {
    const r = await httpGet('/definitely-not-here-xyz');
    assert(r.status === 404, `status ${r.status}`);
  });

  await test('non-GET methods are rejected', async () => {
    const res = await new Promise((resolve) => {
      const req = http.request(BASE + '/', { method: 'POST' }, (r) => resolve(r));
      req.on('error', () => resolve({ statusCode: 0 }));
      req.end('x');
    });
    assert(res.statusCode === 405 || res.statusCode === 0, `status ${res.statusCode}`);
  });

  await test('/healthz reports live stats', async () => {
    const r = await httpGet('/healthz');
    assert(r.status === 200, `status ${r.status}`);
    const j = JSON.parse(r.body);
    assert(typeof j.connected === 'number', 'no connected field');
  });

  console.log('\nWebSocket handshake');
  await test('rejects an unsupported protocol version', async () => {
    const raw = await rawUpgrade(PORT, { version: '8' });
    assert(raw.includes('426'), `expected 426, got: ${raw.split('\r\n')[0]}`);
  });

  console.log('\nPairing + messaging');
  await test('two users are paired and see each other', async () => {
    const a = new TestClient('A');
    const b = new TestClient('B');
    assert((await a.connect(PORT)).ok, 'A handshake');
    assert((await b.connect(PORT)).ok, 'B handshake');
    a.send({ type: 'join', ...PROFILE_A });
    b.send({ type: 'join', ...PROFILE_B });
    await a.waitFor((m) => m.type === 'matched');
    await b.waitFor((m) => m.type === 'matched');
    assert(a.find((m) => m.type === 'matched').peer.nick === 'Bob', 'A sees wrong peer');
    assert(b.find((m) => m.type === 'matched').peer.nick === 'Alice', 'B sees wrong peer');
    a.destroy(); b.destroy();
  });

  await test('messages are relayed to the partner', async () => {
    const a = new TestClient('A2');
    const b = new TestClient('B2');
    await a.connect(PORT); await b.connect(PORT);
    a.send({ type: 'join', ...PROFILE_A });
    b.send({ type: 'join', ...PROFILE_B });
    await a.waitFor((m) => m.type === 'matched');
    a.send({ type: 'message', text: 'salut !' });
    await b.waitFor((m) => m.type === 'message');
    const got = b.find((m) => m.type === 'message');
    assert(got.text === 'salut !', `text=${JSON.stringify(got.text)}`);
    assert(got.from === 'Alice', `from=${got.from}`);
    a.destroy(); b.destroy();
  });

  await test('XSS payload travels as inert text, never as markup', async () => {
    const a = new TestClient('A3');
    const b = new TestClient('B3');
    await a.connect(PORT); await b.connect(PORT);
    a.send({ type: 'join', ...PROFILE_A });
    b.send({ type: 'join', ...PROFILE_B });
    await a.waitFor((m) => m.type === 'matched');
    const payload = '<img src=x onerror="alert(1)">';
    a.send({ type: 'message', text: payload });
    await b.waitFor((m) => m.type === 'message');
    const got = b.find((m) => m.type === 'message');
    // The server must forward the raw text inside a JSON string: rendering is
    // done with textContent on the client, so the tag stays inert.
    assert(got.text === payload, `payload altered: ${JSON.stringify(got.text)}`);
    assert(typeof got.text === 'string', 'payload should stay a plain string');
    a.destroy(); b.destroy();
  });

  await test('message flood is rate-limited after the limit', async () => {
    const a = new TestClient('A4');
    const b = new TestClient('B4');
    await a.connect(PORT); await b.connect(PORT);
    a.send({ type: 'join', ...PROFILE_A });
    b.send({ type: 'join', ...PROFILE_B });
    await a.waitFor((m) => m.type === 'matched');
    for (let i = 0; i < 7; i++) a.send({ type: 'message', text: `flood ${i}` });
    await a.waitFor((m) => m.type === 'error' && m.code === 'rate_limited', 3000);
    a.destroy(); b.destroy();
  });

  await test('oversized message is truncated to the limit', async () => {
    const a = new TestClient('A5');
    const b = new TestClient('B5');
    await a.connect(PORT); await b.connect(PORT);
    a.send({ type: 'join', ...PROFILE_A });
    b.send({ type: 'join', ...PROFILE_B });
    await a.waitFor((m) => m.type === 'matched');
    a.send({ type: 'message', text: 'x'.repeat(9000) });
    await b.waitFor((m) => m.type === 'message');
    const got = b.find((m) => m.type === 'message');
    assert(Buffer.byteLength(got.text, 'utf8') <= 2000, `len=${Buffer.byteLength(got.text, 'utf8')}`);
    a.destroy(); b.destroy();
  });
  console.log('\nValidation + moderation');

  await test('rejects users under the minimum age', async () => {
    const c = new TestClient('young');
    await c.connect(PORT);
    c.send({ type: 'join', nick: 'Kid', age: 12, gender: 'any', lookingFor: 'any', lang: 'fr' });
    await c.waitFor((m) => m.type === 'error' && m.code === 'bad_age');
    c.destroy();
  });

  await test('rejects a too-short nickname', async () => {
    const c = new TestClient('shortnick');
    await c.connect(PORT);
    c.send({ type: 'join', nick: 'a', age: 20, gender: 'any', lookingFor: 'any', lang: 'fr' });
    await c.waitFor((m) => m.type === 'error' && m.code === 'bad_nick');
    c.destroy();
  });

  await test('answers malformed JSON with a clean error', async () => {
    const c = new TestClient('badjson');
    await c.connect(PORT);
    c.sendRaw('{not json at all');
    await c.waitFor((m) => m.type === 'error' && m.code === 'bad_json');
    c.destroy();
  });

  await test('a messaging without a partner is refused', async () => {
    const c = new TestClient('nopartner');
    await c.connect(PORT);
    c.send({ type: 'join', nick: 'Solo', age: 30, gender: 'any', lookingFor: 'any', lang: 'fr' });
    await c.waitFor((m) => m.type === 'waiting');
    c.send({ type: 'message', text: 'hello?' });
    await c.waitFor((m) => m.type === 'error' && m.code === 'no_partner');
    c.destroy();
  });

  await test('lookingFor filter prevents a mismatched pairing', async () => {
    const a = new TestClient('F1');   // wants men only
    const b = new TestClient('F2');   // is a woman -> must not match
    await a.connect(PORT); await b.connect(PORT);
    a.send({ type: 'join', nick: 'WantsMale', age: 25, gender: 'other', lookingFor: 'male', lang: 'fr' });
    b.send({ type: 'join', nick: 'IsFemale', age: 25, gender: 'female', lookingFor: 'any', lang: 'fr' });
    await a.waitFor((m) => m.type === 'waiting');
    await b.waitFor((m) => m.type === 'waiting');
    await sleep(600);
    assert(!a.find((m) => m.type === 'matched'), 'must NOT pair (gender filter)');
    a.destroy(); b.destroy();
  });

  await test('lookingFor filter allows a matching pairing', async () => {
    const a = new TestClient('F3');   // wants men only
    const b = new TestClient('F4');   // is a man
    await a.connect(PORT); await b.connect(PORT);
    a.send({ type: 'join', nick: 'WantsMale2', age: 25, gender: 'other', lookingFor: 'male', lang: 'fr' });
    b.send({ type: 'join', nick: 'IsMale', age: 27, gender: 'male', lookingFor: 'any', lang: 'fr' });
    await a.waitFor((m) => m.type === 'matched', 4000);
    assert(a.find((m) => m.type === 'matched').peer.nick === 'IsMale', 'should have paired');
    a.destroy(); b.destroy();
  });

  await test('language filter keeps matching languages together', async () => {
    const a = new TestClient('L1');
    const b = new TestClient('L2');
    await a.connect(PORT); await b.connect(PORT);
    a.send({ type: 'join', nick: 'FRonly', age: 30, gender: 'any', lookingFor: 'any', lang: 'fr' });
    b.send({ type: 'join', nick: 'ENonly', age: 30, gender: 'any', lookingFor: 'any', lang: 'en' });
    await sleep(600);
    assert(!a.find((m) => m.type === 'matched'), 'must NOT pair (language filter)');
    a.destroy(); b.destroy();
  });

  console.log('\nChatiw Features (Country list, direct private chat, disconnect-reconnect)');

  await test('connect, join, disconnect and reconnect cleanly without being blocked', async () => {
    const a = new TestClient('ReconUser');
    assert((await a.connect(PORT)).ok, 'First connect');
    a.send({ type: 'join', nick: 'ReconNick', age: 25, gender: 'male', lookingFor: 'any', lang: 'fr', country: 'France' });
    await a.waitFor((m) => m.type === 'waiting');
    // Leave, then join again on the SAME socket = the real Chatiw scenario
    a.send({ type: 'leave' });
    await a.waitFor((m) => m.type === 'idle');
    a.send({ type: 'join', nick: 'ReconNick', age: 25, gender: 'male', lookingFor: 'any', lang: 'fr', country: 'France' });
    await a.waitFor((m) => m.type === 'joined' || m.type === 'waiting');
    // Full socket disconnect then immediate reconnect
    a.destroy();
    await sleep(200);

    const a2 = new TestClient('ReconUser2');
    assert((await a2.connect(PORT)).ok, 'Second connect after disconnect');
    a2.send({ type: 'join', nick: 'ReconNick', age: 25, gender: 'male', lookingFor: 'any', lang: 'fr', country: 'France' });
    await a2.waitFor((m) => m.type === 'waiting');
    a2.destroy();
  });

  await test('receives live user list with country information and supports direct private chat', async () => {
    const a = new TestClient('UserFrance');
    const b = new TestClient('UserCanada');
    await a.connect(PORT);
    await b.connect(PORT);

    a.send({ type: 'join', nick: 'AliceFR', age: 22, gender: 'female', lookingFor: 'female', lang: 'fr', country: 'France' });
    b.send({ type: 'join', nick: 'BobCA', age: 28, gender: 'male', lookingFor: 'male', lang: 'fr', country: 'Canada' });
    
    // Alice and Bob do not auto-match because of lookingFor filters (female vs male)
    await a.waitFor((m) => m.type === 'waiting');
    await b.waitFor((m) => m.type === 'waiting');

    // Request active user list
    a.send({ type: 'get_users' });
    await a.waitFor((m) => m.type === 'user_list' && Array.isArray(m.users) && m.users.some(u => u.nick === 'BobCA'));
    const allLists = a.messages.filter((m) => m.type === 'user_list');
    const userListMsg = allLists.reverse().find(m => m.users.some(u => u.nick === 'BobCA'));
    const bobInList = userListMsg.users.find(u => u.nick === 'BobCA');
    assert(bobInList, 'BobCA should be in the user list');
    assert(bobInList.country === 'Canada', `Expected Canada, got ${bobInList.country}`);

    // Direct private chat: Alice clicks on Bob in the list
    a.send({ type: 'start_private', targetId: bobInList.id });
    await a.waitFor((m) => m.type === 'matched');
    await b.waitFor((m) => m.type === 'matched');

    assert(a.find((m) => m.type === 'matched').peer.nick === 'BobCA', 'Alice paired with BobCA');
    assert(b.find((m) => m.type === 'matched').peer.nick === 'AliceFR', 'Bob paired with AliceFR');

    a.destroy(); b.destroy();
  });

  console.log('\nIsolated servers (ban + connection flood)');

  await test('reporting a partner bans their address', async () => {
    await withServer(3461, { LIMIT_BAN_MS: '120000' }, async () => {
      const a = new TestClient('Reporter');
      const b = new TestClient('Reported');
      assert((await a.connect(3461)).ok, 'A handshake');
      assert((await b.connect(3461)).ok, 'B handshake');
      a.send({ type: 'join', nick: 'Good', age: 30, gender: 'any', lookingFor: 'any', lang: 'fr' });
      b.send({ type: 'join', nick: 'Troll', age: 30, gender: 'any', lookingFor: 'any', lang: 'fr' });
      await a.waitFor((m) => m.type === 'matched');
      a.send({ type: 'report' });
      await a.waitFor((m) => m.type === 'reported');
      await b.waitFor((m) => m.type === 'banned');
      await sleep(250);
      const c = new TestClient('AfterBan');
      const res = await c.connect(3461);
      assert(!res.ok, `banned address should be refused, got ${res.status}`);
      assert(/403/.test(res.status), `expected 403, got ${res.status}`);
      c.destroy(); a.destroy(); b.destroy();
    });
  });

  await test('connection flood from one address is throttled', async () => {
    await withServer(3462, { LIMIT_CONN_PER_IP: '2' }, async () => {
      const ok = [];
      for (let i = 0; i < 5; i++) {
        const c = new TestClient('flood' + i);
        const res = await c.connect(3462).catch(() => ({ ok: false, status: 'err' }));
        ok.push(res.ok);
        if (res.ok) cleanups.push(c);
      }
      assert(ok.filter(Boolean).length <= 3, `allowed ${ok.filter(Boolean).length} connections, expected <=3`);
      assert(ok.includes(false), 'no connection was throttled');
    });
  });
  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  const total = passed + failures.length;
  console.log('\n' + '-'.repeat(58));
  if (failures.length === 0) {
    console.log(`  ALL ${total} TESTS PASSED`);
  } else {
    console.log(`  ${passed}/${total} passed — ${failures.length} FAILED`);
    console.log('\n  Failures:');
    for (const f of failures) console.log(`   - ${f.name}\n       ${f.err.message}`);
  }
  console.log('-'.repeat(58));

  shutdown();
  process.exit(failures.length === 0 ? 0 : 1);
}

function shutdown() {
  for (const c of cleanups) {
    try {
      if (c && typeof c.kill === 'function') c.kill();
      else if (c && typeof c.destroy === 'function') c.destroy();
    } catch { /* ignore */ }
  }
}

process.on('SIGINT', () => { shutdown(); process.exit(130); });

main().catch((err) => {
  console.error('\nTest harness crashed:', err && err.stack ? err.stack : err);
  shutdown();
  process.exit(1);
});




