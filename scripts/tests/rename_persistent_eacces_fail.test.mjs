import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

test('Persistent EACCES on rename surfaces actionable error and emits metrics', async () => {
  const captured = [];
  globalThis.UrgaCoreDeps = globalThis.UrgaCoreDeps || {};
  globalThis.UrgaCoreDeps.Metrics = {
    count: (_ctx, name, delta = 1, labels = {}) => {
      captured.push({ event: `${name}.count`, delta, labels });
    },
    gauge: () => {},
    histogramMs: () => {},
  };

  const dir = path.join(
    os.tmpdir(),
    `rename_fail_${process.pid}_${Math.random().toString(36).slice(2)}`
  );
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, 'target.json');
  await fsp.writeFile(target, 'seed', 'utf8');

  // Configure simulation: force EACCES on rename to target.json
  process.env.URGA_TEST_FS_ERROR_OP = 'rename';
  process.env.URGA_TEST_FS_ERROR_CODE = 'EACCES';
  process.env.URGA_TEST_RENAME_FAILS_N = '10';
  process.env.URGA_TEST_FS_ERROR_PATH_RX = 'target\.json$';
  process.env.RENAME_RETRY_MAX_MS = '10';
  process.env.RENAME_RETRY_STEP_MS = '5';

  const monolith = await import('../../monolith.js');
  const { AsyncFS } = monolith;
  let caught = null;
  try {
    await AsyncFS.writeFileAtomic(target, JSON.stringify({ x: 1 }), 'utf8');
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, 'rename failure should throw');
  assert.equal(String(caught?.code || '').toUpperCase(), 'EACCES');

  const failed = captured.find((e) => e.event === 'fs_rename_failed_total.count');
  assert.ok(failed, 'fs_rename_failed_total should be emitted');
  assert.equal(String(failed.labels?.code || '').toUpperCase(), 'EACCES');

  // Cleanup
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch {}
});
