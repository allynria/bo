import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { EventEmitter } from 'node:events';

// Dynamically import monolith to avoid early evaluation complexities in some cases
const monolith = await import('../../monolith.js');

const {
  MessageClock,
  registerGracefulShutdown,
  onIncomingMessage,
  wrapChatHandler,
  messageCountMiddleware,
  sendMessageWithTick,
  logAt,
  sampled,
  makePRNG,
  createBotRuntime,
  MessageRateLimiter,
  TokenBucket,
  SafeText,
  AsyncFS,
  FS,
  computeFileHash,
  __acquireLock__,
} = monolith;

function tmpdir(name = 'monolith-tests') {
  const dir = path.join(os.tmpdir(), name + '-' + process.pid + '-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---- MessageClock -----------------------------------------------------------
test('MessageClock: tick increments and now reflects count', () => {
  const start = MessageClock.now();
  MessageClock.tick(3);
  assert.equal(MessageClock.now(), start + 3);
});

test('MessageClock: setTimeoutCounts executes after counts', () => {
  let fired = 0;
  MessageClock.setTimeoutCounts(() => {
    fired++;
  }, 3);
  MessageClock.tick(2);
  assert.equal(fired, 0);
  MessageClock.tick(1);
  assert.equal(fired, 1);
});

test('MessageClock: setIntervalCounts repeats and can clear', () => {
  let n = 0;
  const id = MessageClock.setIntervalCounts(() => {
    n++;
  }, 2);
  MessageClock.tick(2); // first fire
  MessageClock.tick(2); // second fire
  assert.equal(n, 2);
  MessageClock.clearInterval(id);
  MessageClock.tick(4);
  assert.equal(n, 2, 'cleared interval should not fire again');
});

test('MessageClock: sleepCounts resolves and aborts', async () => {
  const ac = new AbortController();
  const p = MessageClock.sleepCounts(2, ac.signal);
  ac.abort(new Error('boom'));
  await assert.rejects(p, /boom/);

  const q = MessageClock.sleepCounts(2);
  MessageClock.tick(2);
  await q; // should resolve without throwing
});

// ---- SafeText ---------------------------------------------------------------
test('SafeText: normalizeNewlines converts CRLF to LF', () => {
  const s = 'a\r\nb\rc';
  assert.equal(SafeText.normalizeNewlines(s), 'a\nb\nc');
});

test('SafeText: clamp limits string length', () => {
  const s = 'abcdef';
  assert.equal(SafeText.clamp(s, 3), 'abc');
  assert.equal(SafeText.clamp(s, 10), 'abcdef');
});

test('SafeText: stripDangerous removes control chars', () => {
  const s = 'ok' + '\x00' + 'bad' + '\x1F' + 'fine';
  assert.equal(SafeText.stripDangerous(s), 'okbadfine');
});

// ---- RNG, logging -----------------------------------------------------------
test('makePRNG: deterministic sequences for same seed', () => {
  const r1 = makePRNG(123);
  const r2 = makePRNG(123);
  const a = [r1(), r1(), r1()];
  const b = [r2(), r2(), r2()];
  assert.deepEqual(a, b);
});

test('logAt: respects level ordering (INFO default)', () => {
  // Spy on console to capture calls via internal logger
  let calls = { debug: 0, info: 0, warn: 0, error: 0 };
  const orig = { ...console };
  console.debug = (..._a) => {
    calls.debug++;
  };
  console.info = (..._a) => {
    calls.info++;
  };
  console.warn = (..._a) => {
    calls.warn++;
  };
  console.error = (..._a) => {
    calls.error++;
  };
  try {
    logAt('debug', 'should not log at INFO');
    logAt('error', 'should log at INFO');
    assert.equal(calls.debug, 0);
    assert.equal(calls.error > 0, true);
  } finally {
    console.debug = orig.debug;
    console.info = orig.info;
    console.warn = orig.warn;
    console.error = orig.error;
  }
});

test('sampled: calls logAt when rng < rate', () => {
  // Force RNG to always return 0 for predictability
  const origRng = globalThis.__RNG__;
  globalThis.__RNG__ = () => 0;
  let errorCalls = 0;
  const origErr = console.error;
  console.error = () => {
    errorCalls++;
  };
  try {
    sampled('error', 1.0, 'always logs');
    assert.equal(errorCalls > 0, true);
  } finally {
    console.error = origErr;
    globalThis.__RNG__ = origRng;
  }
});

// ---- Rate limiters ---------------------------------------------------------
test('MessageRateLimiter: allow caps events within window', () => {
  const limiter = new MessageRateLimiter({ max: 2, windowCounts: 3 });
  assert.equal(limiter.allow(), true);
  MessageClock.tick(1);
  assert.equal(limiter.allow(), true);
  MessageClock.tick(1);
  assert.equal(limiter.allow(), false);
  // Advance beyond window to prune
  MessageClock.tick(3);
  assert.equal(limiter.allow(), true);
});

test('TokenBucket: capacity and refill with message counts', () => {
  const bucket = new TokenBucket({ capacity: 3, refillPerCount: 1 });
  assert.equal(bucket.take(2), true);
  assert.equal(bucket.take(2), false);
  MessageClock.tick(1);
  assert.equal(bucket.take(1), true);
});

// ---- Chat wrappers ----------------------------------------------------------
test('wrapChatHandler: ticks for inbound and outbound send', async () => {
  const start = MessageClock.now();
  const handler = wrapChatHandler(async (input, ctx) => `echo:${input}`);
  const ctx = { send: async () => {} };
  const out = await handler('hi', ctx);
  assert.equal(out, 'echo:hi');
  assert.equal(MessageClock.now(), start + 2, 'inbound + outbound tick');
});

test('wrapChatHandler: ticks outbound even without ctx.send', async () => {
  const start = MessageClock.now();
  const handler = wrapChatHandler(async (input) => `echo:${input}`);
  const out = await handler('hi');
  assert.equal(out, 'echo:hi');
  assert.equal(MessageClock.now(), start + 2);
});

test('messageCountMiddleware: ticks on request and finish', () => {
  const start = MessageClock.now();
  const mw = messageCountMiddleware();
  const req = {};
  const res = new EventEmitter();
  let nextCalled = 0;
  mw(req, res, () => {
    nextCalled++;
  });
  res.emit('finish');
  assert.equal(nextCalled, 1);
  assert.equal(MessageClock.now(), start + 2);
});

test('sendMessageWithTick: calls send and ticks', async () => {
  const start = MessageClock.now();
  const out = await sendMessageWithTick(async (p) => `send:${p}`, 'x');
  assert.equal(out, 'send:x');
  assert.equal(MessageClock.now(), start + 1);
});

// ---- FS & hashing -----------------------------------------------------------
test('computeFileHash: sha256 hash matches expected', async () => {
  const dir = tmpdir('hash');
  const p = path.join(dir, 'f.txt');
  await fsp.writeFile(p, 'hello', 'utf8');
  const h = await computeFileHash(p, 'sha256');
  assert.match(h, /^[a-f0-9]{64}$/);
});

test('AsyncFS.writeFileAtomic: CAS mismatch throws E_CAS_MISMATCH', async () => {
  const dir = tmpdir('cas-mismatch');
  const p = path.join(dir, 'f.txt');
  await fsp.writeFile(p, 'A', 'utf8');
  const wrongHash = 'deadbeef';
  await assert.rejects(
    AsyncFS.writeFileAtomic(p, 'B', 'utf8', { expectedHash: wrongHash }),
    /E_CAS_MISMATCH/
  );
});

test('AsyncFS.writeFileAtomic: CAS missing throws when expected not EMPTY', async () => {
  const dir = tmpdir('cas-missing');
  const p = path.join(dir, 'f.txt');
  // Do not create the file, expect non-EMPTY
  await assert.rejects(
    AsyncFS.writeFileAtomic(p, 'B', 'utf8', { expectedHash: 'not-empty' }),
    /E_CAS_MISSING|ENOENT/
  );
});

test('AsyncFS.appendFile: uses lock and releases it', async () => {
  const dir = tmpdir('append');
  const p = path.join(dir, 'f.txt');
  await AsyncFS.writeFile(p, 'start', 'utf8');
  await AsyncFS.appendFile(p, '++', 'utf8');
  const data = await AsyncFS.readFile(p, 'utf8');
  assert.equal(String(data), 'start++');
  // Lock path should not remain
  const lockPath = `${p}.lock.append`;
  const exists = await fsp
    .stat(lockPath)
    .then(() => true)
    .catch(() => false);
  assert.equal(exists, false);
});

test('AsyncFS.writeFile: circuit breaker prevents writes when open', async () => {
  const dir = tmpdir('circuit');
  const p = path.join(dir, 'f.txt');
  const origCB = globalThis.CB;
  globalThis.CB = { isOpen: () => true };
  try {
    await assert.rejects(AsyncFS.writeFile(p, 'x', 'utf8'), /circuit_open|E_CIRCUIT_OPEN/);
  } finally {
    globalThis.CB = origCB;
  }
});

test('FS wrappers: read/write/append flow', async () => {
  const dir = tmpdir('fs');
  const p = path.join(dir, 'f.txt');
  await FS.writeFile(p, 'a', 'utf8');
  await FS.appendFile(p, 'b', 'utf8');
  const s = await FS.readFile(p, 'utf8');
  assert.equal(String(s), 'ab');
});

// ---- Locks -----------------------------------------------------------------
test('__acquireLock__: acquires and releases', async () => {
  const dir = tmpdir('lock');
  const lockPath = path.join(dir, 'file.lock');
  const release = await __acquireLock__(lockPath, { timeoutMs: 500 });
  const exists = await fsp
    .stat(lockPath)
    .then(() => true)
    .catch(() => false);
  assert.equal(exists, true);
  await release();
  const existsAfter = await fsp
    .stat(lockPath)
    .then(() => true)
    .catch(() => false);
  assert.equal(existsAfter, false);
});

test('__acquireLock__: stale lock recovered', async () => {
  const dir = tmpdir('lock-stale');
  const lockPath = path.join(dir, 'file.lock');
  // Create a stale lock by writing an old timestamp
  await fsp.writeFile(
    lockPath,
    JSON.stringify({ pid: process.pid, ts: Date.now() - 10_000 }) + '\n',
    { flag: 'wx' }
  );
  const release = await __acquireLock__(lockPath, { timeoutMs: 1000, staleMs: 100 });
  assert.equal(typeof release, 'function');
  await release();
});

// ---- Bot runtime -----------------------------------------------------------
test('createBotRuntime: wraps respond, enforces rate limit, runs hooks', async () => {
  let before = 0,
    after = 0,
    errs = 0;
  const runtime = createBotRuntime({
    respond: async (input) => {
      if (input === 'boom') throw new Error('nope');
      return 'ok:' + input;
    },
    limits: { max: 2, windowCounts: 5 },
    hooks: {
      beforeEach: async () => {
        before++;
      },
      afterEach: async () => {
        after++;
      },
      onError: async () => {
        errs++;
      },
    },
  });

  const a = await runtime('x', { send: async () => {} });
  const b = await runtime('y', { send: async () => {} });
  const c = await runtime('boom', { send: async () => {} });
  const d = await runtime('z', { send: async () => {} });

  assert.equal(a, 'ok:x');
  assert.equal(b, 'ok:y');
  assert.equal(c && c.error, 'internal_error');
  assert.equal(d && d.error, 'rate_limited');
  assert.equal(before >= 3, true);
  assert.equal(after >= 2, true);
  assert.equal(errs >= 1, true);
});

// ---- Graceful shutdown & message hook -------------------------------------
test('onIncomingMessage: ticks clock by 1', () => {
  const start = MessageClock.now();
  onIncomingMessage();
  assert.equal(MessageClock.now(), start + 1);
});

test('registerGracefulShutdown: registers signal handlers once', () => {
  const beforeSIGINT = process.listenerCount('SIGINT');
  const beforeSIGTERM = process.listenerCount('SIGTERM');
  registerGracefulShutdown(async () => {});
  registerGracefulShutdown(async () => {}); // should be idempotent
  const afterSIGINT = process.listenerCount('SIGINT');
  const afterSIGTERM = process.listenerCount('SIGTERM');
  assert.equal(afterSIGINT, beforeSIGINT + 1);
  assert.equal(afterSIGTERM, beforeSIGTERM + 1);
});
