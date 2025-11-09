import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

test('Shared RL: recreates shard directories after purge mid-run', async () => {
  const orig = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  // Use a fresh temp base so we don’t touch repo-local urga_rl
  const tmpBase = path.join(
    os.tmpdir(),
    `trae_rl_purge_${process.pid}_${Math.random().toString(36).slice(2)}`
  );
  await fsp.mkdir(tmpBase, { recursive: true });
  delete process.env.TMPDIR; // ensure file backend picks TEMP
  delete process.env.TMP;
  process.env.TEMP = tmpBase;

  const monolith = await import('../../monolith.js');
  const { createSharedRateLimiter } = monolith;

  const limiter = createSharedRateLimiter({ limit: 1, windowMs: 100, internalErrorOnce: false });
  const key = 'purge-midrun-' + Math.random().toString(36).slice(2);

  // First allow should create backend file
  const out1 = await limiter.allow(key);
  assert.equal(out1.ok, true, 'first allow should be ok');

  const hex = Buffer.from(String(key)).toString('hex');
  const shard = hex.slice(0, 2) || '00';
  const filePath = path.join(tmpBase, 'urga_rl', shard, `${hex}.json`);
  const exists1 = await fsp
    .stat(filePath)
    .then(() => true)
    .catch(() => false);
  assert.equal(exists1, true, 'backend file should exist after first allow');

  // Disaster drill: purge the entire RL base directory mid-run
  await fsp.rm(path.join(tmpBase, 'urga_rl'), { recursive: true, force: true });
  const existsBaseAfterPurge = await fsp
    .stat(path.join(tmpBase, 'urga_rl'))
    .then(() => true)
    .catch(() => false);
  assert.equal(existsBaseAfterPurge, false, 'urga_rl base should be deleted by purge');

  // Next allow must recreate shard directories and continue cleanly
  const out2 = await limiter.allow(key);
  assert.equal(out2.ok, true, 'allow should succeed after purge');
  const exists2 = await fsp
    .stat(filePath)
    .then(() => true)
    .catch(() => false);
  assert.equal(exists2, true, 'backend file should be recreated after purge');

  // Cleanup
  try {
    await fsp.rm(path.join(tmpBase, 'urga_rl'), { recursive: true, force: true });
  } catch {}
  try {
    await fsp.rm(tmpBase, { recursive: true, force: true });
  } catch {}
  if (orig.TMPDIR != null) process.env.TMPDIR = orig.TMPDIR;
  else delete process.env.TMPDIR;
  if (orig.TEMP != null) process.env.TEMP = orig.TEMP;
  else delete process.env.TEMP;
  if (orig.TMP != null) process.env.TMP = orig.TMP;
  else delete process.env.TMP;
});
