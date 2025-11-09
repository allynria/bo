import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';

test('Path-length guard: 2–4 KB logical keys hashed/shortened under ~240 chars', async () => {
  const tmpBase = path.join(
    os.tmpdir(),
    `trae_rl_pathlen2_${process.pid}_${Math.random().toString(36).slice(2)}`
  );
  await fsp.mkdir(tmpBase, { recursive: true });
  process.env.TMPDIR = tmpBase;
  process.env.TEMP = '';
  process.env.TMP = '';

  const monolith = await import('../../monolith.js');
  const { createSharedRateLimiter } = monolith;
  const rl = createSharedRateLimiter({ limit: 1, windowMs: 1000 });

  const sizes = [2048, 4096];
  for (const sz of sizes) {
    const key = 'k'.repeat(sz);
    const hex = Buffer.from(String(key)).toString('hex');
    const shard = hex.slice(0, 2) || '00';
    function fnv1aHex(s) {
      let h = 0x811c9dc5;
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
      }
      return (h >>> 0).toString(16).padStart(8, '0');
    }
    const short = hex.slice(0, 120) + '_' + fnv1aHex(key);
    const expectedFile = path.join(tmpBase, 'urga_rl', shard, `${short}.json`);
    await rl.allow(key);
    const st = await fsp.stat(expectedFile).catch(() => null);
    assert.ok(!!st, `expected truncated backend file to exist for size ${sz}`);
    const base = path.basename(expectedFile);
    assert.ok(base.length <= 240, `filename too long (${base.length}) for size ${sz}`);
  }
});
