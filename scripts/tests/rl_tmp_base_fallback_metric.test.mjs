import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

test('TMP base fallback metrics emitted when TMP envs are missing', async () => {
  const orig = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  delete process.env.TMPDIR;
  delete process.env.TEMP;
  delete process.env.TMP;

  const captured = [];
  globalThis.UrgaCoreDeps = globalThis.UrgaCoreDeps || {};
  globalThis.UrgaCoreDeps.Metrics = {
    count: (_ctx, name, delta = 1, labels = {}) => {
      captured.push({ event: `${name}.count`, delta, labels });
    },
    gauge: () => {},
    histogramMs: () => {},
  };

  const monolith = await import('../../monolith.js');
  const { createSharedRateLimiter } = monolith;

  const limiter = createSharedRateLimiter({ limit: 1, windowMs: 100, internalErrorOnce: false });
  const key = 'fallback-probe-' + Math.random().toString(36).slice(2);
  await limiter.allow(key);

  const resolved = captured.find((e) => e.event === 'rl_tmp_base_resolved_total.count');
  assert.ok(resolved, 'rl_tmp_base_resolved_total.count should be emitted');
  assert.equal(String(resolved.labels?.source), 'cwd', 'source label should be cwd when no TMP envs');

  const fallback = captured.find((e) => e.event === 'rl_tmp_base_fallback_total.count');
  assert.ok(fallback, 'rl_tmp_base_fallback_total.count should be emitted for non-TMPDIR');
  assert.equal(String(fallback.labels?.source), 'cwd', 'fallback source should be cwd');

  // Cleanup created file if present
  try {
    const hex = Buffer.from(String(key)).toString('hex');
    const shard = hex.slice(0, 2) || '00';
    const baseDir = path.join('.', 'urga_rl', shard);
    await fsp.rm(path.join(baseDir, `${hex}.json`), { force: true });
  } catch {}

  // Restore env
  if (orig.TMPDIR != null) process.env.TMPDIR = orig.TMPDIR; else delete process.env.TMPDIR;
  if (orig.TEMP != null) process.env.TEMP = orig.TEMP; else delete process.env.TEMP;
  if (orig.TMP != null) process.env.TMP = orig.TMP; else delete process.env.TMP;
});

test('TMP base metrics label TEMP when TEMP is set', async () => {
  const orig = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  delete process.env.TMPDIR;
  delete process.env.TMP;

  const tmpBase = path.join(
    os.tmpdir(),
    `trae_tmp_fallback_${process.pid}_${Math.random().toString(36).slice(2)}`
  );
  await fsp.mkdir(tmpBase, { recursive: true });
  process.env.TEMP = tmpBase;

  const captured = [];
  globalThis.UrgaCoreDeps = globalThis.UrgaCoreDeps || {};
  globalThis.UrgaCoreDeps.Metrics = {
    count: (_ctx, name, delta = 1, labels = {}) => {
      captured.push({ event: `${name}.count`, delta, labels });
    },
    gauge: () => {},
    histogramMs: () => {},
  };

  const monolith = await import('../../monolith.js');
  const { createSharedRateLimiter } = monolith;

  const limiter = createSharedRateLimiter({ limit: 1, windowMs: 100, internalErrorOnce: false });
  const key = 'fallback-temp-' + Math.random().toString(36).slice(2);
  await limiter.allow(key);

  const resolved = captured.find((e) => e.event === 'rl_tmp_base_resolved_total.count');
  assert.ok(resolved, 'resolved metric should be emitted');
  assert.equal(String(resolved.labels?.source), 'TEMP');

  const fallback = captured.find((e) => e.event === 'rl_tmp_base_fallback_total.count');
  assert.ok(fallback, 'fallback metric should be emitted');
  assert.equal(String(fallback.labels?.source), 'TEMP');

  // Cleanup
  try {
    const hex = Buffer.from(String(key)).toString('hex');
    const shard = hex.slice(0, 2) || '00';
    await fsp.rm(path.join(tmpBase, 'urga_rl', shard, `${hex}.json`), { force: true });
    await fsp.rm(path.join(tmpBase, 'urga_rl', shard), { recursive: true, force: true });
    await fsp.rm(path.join(tmpBase, 'urga_rl'), { recursive: true, force: true });
  } catch {}

  try { await fsp.rm(tmpBase, { recursive: true, force: true }); } catch {}

  // Restore env
  if (orig.TMPDIR != null) process.env.TMPDIR = orig.TMPDIR; else delete process.env.TMPDIR;
  if (orig.TEMP != null) process.env.TEMP = orig.TEMP; else delete process.env.TEMP;
  if (orig.TMP != null) process.env.TMP = orig.TMP; else delete process.env.TMP;
});

