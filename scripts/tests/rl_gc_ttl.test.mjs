import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import fsp from 'node:fs/promises';

test('Rate-limit file TTL/GC deletes expired files', async () => {
  // Configure GC respecting minimums: TTL >= 60s, interval >= 5s
  process.env.RL_GC_ENABLED = '1';
  process.env.RL_GC_TTL_MS = '60000';
  process.env.RL_GC_INTERVAL_MS = '5000';
  process.env.RL_GC_MAX_DELETES = '100';
  process.env.RL_GC_MAX_RUN_MS = '500';

  // Isolate TMPDIR to ensure GC scans a small, dedicated directory
  const tmpBase = path.join(os.tmpdir(), `trae_rl_gc_${process.pid}_${Math.random().toString(36).slice(2)}`);
  await fsp.mkdir(tmpBase, { recursive: true });
  process.env.TMPDIR = tmpBase;
  process.env.TEMP = '';
  process.env.TMP = '';

  const monolith = await import('../../monolith.js');
  const { createSharedRateLimiter } = monolith;
  const limiter = createSharedRateLimiter({ limit: 1, windowMs: 100, internalErrorOnce: false });

  const key = 'gc-test-' + Math.random().toString(36).slice(2);
  await limiter.allow(key); // create the file

  const base = String(process?.env?.TMPDIR || process?.env?.TEMP || process?.env?.TMP || os.tmpdir());
  const hex = Buffer.from(String(key)).toString('hex');
  const shard = (hex.slice(0, 2) || '00');
  const p = path.join(base, 'urga_rl', shard, `${hex}.json`);
  const existsBefore = await fsp.stat(p).then(() => true).catch(() => false);
  assert.equal(existsBefore, true, 'backend file should exist before GC');

  // Make it stale beyond TTL (older than 70s)
  const old = new Date(Date.now() - 70000);
  await fsp.utimes(p, old, old);

  // Wait for at least one GC run (interval >= 5s)
  await new Promise((r) => setTimeout(r, 6000));

  const existsAfter = await fsp.stat(p).then(() => true).catch(() => false);
  assert.equal(existsAfter, false, 'backend file should be deleted by GC');
});
