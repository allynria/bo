import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

test('A/B variant env overrides select correct provider', async () => {
  const script = path.join(process.cwd(), 'scripts', 'dev_probe_provider_env_ab.mjs');
  const child = spawn(process.execPath, [script], { env: { ...process.env } });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  await new Promise((r) => child.on('exit', r));
  const lines = out.trim().split(/\r?\n/).filter(Boolean);
  let j = null;
  for (let i = lines.length - 1; i >= 0 && !j; i--) {
    try { j = JSON.parse(lines[i]); } catch {}
  }
  assert.ok(j && j.ok === true, `AB probe failed: ${out}`);
});
