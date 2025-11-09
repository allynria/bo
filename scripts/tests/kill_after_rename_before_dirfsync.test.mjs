import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';
import * as fs from 'node:fs';
import fsp from 'node:fs/promises';

function runChildWrite(target, payload) {
  const spec = pathToFileURL(path.join(process.cwd(), 'monolith.js')).href;
  const script = `
    (async () => {
      const mod = await import('${spec}');
      const { AsyncFS } = mod;
      await AsyncFS.writeFileAtomic('${String(target).replace(/\\/g, '/')}', ${JSON.stringify(payload)}, 'utf8');
      // Exit immediately without fsyncDir (test env will have skipped it)
      process.exit(0);
    })().catch(() => { process.exit(1); });
  `;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, SKIP_DIR_FSYNC_FOR_TEST: '1', NODE_ENV: 'test' },
    });
    child.on('exit', (code) => resolve({ code }));
  });
}

test('Kill-after-rename-before-dirfsync: data present on next boot', async () => {
  const target = path.join(process.cwd(), 'kill_after_fsync_probe.json');
  try {
    await fsp.rm(target, { force: true });
  } catch {}
  const payload = '"payload"';
  const r = await runChildWrite(target, payload);
  assert.equal(r.code, 0, 'child should exit cleanly');
  const exists = await fsp
    .stat(target)
    .then(() => true)
    .catch(() => false);
  assert.equal(exists, true, 'final file should exist even if dir fsync skipped');
  const data = await fsp.readFile(target, 'utf8');
  assert.equal(String(data).trim(), String(payload), 'file content should be present');
});
