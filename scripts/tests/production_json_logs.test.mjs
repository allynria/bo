import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { waitForUp } from './helpers/wait_for_up.mjs';
import * as path from 'node:path';

test('Production mode: all stdout lines are JSON', async () => {
  const script = path.join(process.cwd(), 'scripts', 'service.js');
  const port = 3200 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [script], { env: { ...process.env, NODE_ENV: 'production', PORT: String(port) } });
  const base = `http://localhost:${port}`;
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  // Wait for healthz readiness to avoid flake
  await waitForUp(base, { timeout: 3000 });
  const lines = out.trim().split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try { JSON.parse(line); } catch { assert.fail(`Non-JSON line in production: ${line}`); }
  }
  try { child.kill('SIGTERM'); } catch {}
  await new Promise((r) => child.on('exit', r));
});
