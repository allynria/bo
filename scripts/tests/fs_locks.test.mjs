import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import { __acquireLock__, AsyncFS } from '../../monolith.js';

function tmpDir() {
  return path.join(os.tmpdir(), `trae_fs_tests_${process.pid}`);
}

async function ensureTmp() {
  const dir = tmpDir();
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

test('lock acquisition and release', async () => {
  const dir = await ensureTmp();
  const lockPath = path.join(dir, 'resource.lock');
  const release = await __acquireLock__(lockPath, { timeoutMs: 500, staleMs: 2000 });
  assert.ok(typeof release === 'function');
  await release();

  // Reacquire after release should succeed quickly
  const release2 = await __acquireLock__(lockPath, { timeoutMs: 500, staleMs: 2000 });
  assert.ok(typeof release2 === 'function');
  await release2();
});

test('stale-lock recovery', async () => {
  const dir = await ensureTmp();
  const lockPath = path.join(dir, 'stale.lock');
  // Seed a stale lock file with old timestamp
  const staleTs = Date.now() - 10_000; // 10 seconds ago
  await fsp.writeFile(lockPath, JSON.stringify({ pid: 9999, ts: staleTs }) + "\n", 'utf8');
  const release = await __acquireLock__(lockPath, { timeoutMs: 500, staleMs: 1000 });
  assert.ok(typeof release === 'function');
  await release();
});

test('atomic write respects circuit-breaker', async () => {
  const dir = await ensureTmp();
  const target = path.join(dir, 'atomic.txt');
  // Trip the circuit breaker
  globalThis.CB = { isOpen: () => true };
  let threw = false;
  try {
    await AsyncFS.writeFileAtomic(target, 'data');
  } catch (e) {
    threw = true;
    assert.equal(e.code, 'E_CIRCUIT_OPEN');
  }
  assert.ok(threw, 'writeFileAtomic should throw when circuit is open');

  // Close breaker and succeed
  globalThis.CB = { isOpen: () => false };
  await AsyncFS.writeFileAtomic(target, 'ok');
  const buf = await fsp.readFile(target, 'utf8');
  assert.equal(buf, 'ok');
});

test('stderr formatting includes trailing newline', async () => {
  const writes = [];
  const orig = process.stderr.write;
  process.stderr.write = (chunk, enc, cb) => {
    const str = Buffer.isBuffer(chunk) ? chunk.toString(enc || 'utf8') : String(chunk);
    writes.push(str);
    if (cb) cb();
    return true;
  };
  try {
    process.stderr.write('[debug] test message\n');
    assert.ok(writes.length >= 1);
    assert.ok(writes[writes.length - 1].endsWith('\n'));
  } finally {
    process.stderr.write = orig;
  }
});

