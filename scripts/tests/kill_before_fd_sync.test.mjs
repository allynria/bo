import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

function tmpdir() {
  const dir = path.join(os.tmpdir(), `kill_before_sync_${process.pid}_${Math.random().toString(36).slice(2)}`);
  return dir;
}

test('Kill-before-fd.sync leaves tmp artifact and preserves original file', async () => {
  const dir = tmpdir();
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, 'target.txt');
  await fsp.writeFile(target, 'A', 'utf8');

  // Enable the test hook and attempt atomic write
  process.env.URGA_TEST_THROW_BEFORE_FD_SYNC = '1';
  const monolith = await import('../../monolith.js');
  const { AsyncFS } = monolith;
  let threw = false;
  try {
    await AsyncFS.writeFileAtomic(target, 'B', 'utf8');
  } catch (e) {
    threw = true;
    assert.equal(e?.code, 'E_TEST_KILL_BEFORE_SYNC');
  }
  assert.equal(threw, true, 'writeFileAtomic should throw due to test hook');

  // Original file content remains intact
  const content = await fsp.readFile(target, 'utf8');
  assert.equal(content, 'A', 'original file should remain intact');

  // Tmp artifact is present
  const files = await fsp.readdir(dir);
  const tmpNames = files.filter((n) => n.includes('target.txt.tmp-'));
  assert.ok(tmpNames.length >= 1, 'tmp artifact should exist');

  // Cleanup tmp artifacts and target
  for (const n of tmpNames) {
    try { await fsp.rm(path.join(dir, n), { force: true }); } catch {}
  }
  try { await fsp.rm(target, { force: true }); } catch {}
});

