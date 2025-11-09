import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';

function backendPathForKey(key) {
  const base = String(
    process?.env?.TMPDIR || process?.env?.TEMP || process?.env?.TMP || os.tmpdir()
  );
  const hex = Buffer.from(String(key)).toString('hex');
  const shard = hex.slice(0, 2) || '00';
  return path.join(base, 'urga_rl', shard, `${hex}.json`);
}

test('GC race safety: hammer key while GC runs; no deletion or lock starvation', async () => {
  // Enable GC with aggressive interval but sane TTL
  process.env.RL_GC_ENABLED = '1';
  process.env.RL_GC_TTL_MS = '60000';
  process.env.RL_GC_INTERVAL_MS = '200';
  process.env.RL_GC_MAX_DELETES = '100';
  process.env.RL_GC_MAX_RUN_MS = '50';

  const monolith = await import('../../monolith.js');
  const { createSharedRateLimiter } = monolith;
  const windowMs = 100;
  const limit = 2;
  const key = 'gc-race-key';
  const rl = createSharedRateLimiter({ windowMs, limit });
  const p = backendPathForKey(key);

  // Seed the file
  await rl.allow(key);
  const existsSeed = await fsp
    .stat(p)
    .then(() => true)
    .catch(() => false);
  assert.equal(existsSeed, true, 'backend file should exist at seed');

  // Hammer for 2 seconds while GC runs
  const end = Date.now() + 2000;
  let errors = 0;
  while (Date.now() < end) {
    try {
      await rl.allow(key);
    } catch (e) {
      errors++;
    }
  }

  // After hammer+GC, file should still exist; no lock starvation exceptions
  const existsAfter = await fsp
    .stat(p)
    .then(() => true)
    .catch(() => false);
  assert.equal(existsAfter, true, 'backend file should not be deleted by GC while live');
  assert.equal(errors, 0, 'no exceptions expected due to lock starvation');
});
