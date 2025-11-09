import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { waitForUp } from './helpers/wait_for_up.mjs';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

function startService(env = {}) {
  const script = path.join(process.cwd(), 'scripts', 'service.js');
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
  return child;
}

function fetchRaw(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', reject);
    req.end();
  });
}

// Using shared readiness polling helper

test('header size cap returns 431 on oversized headers', async () => {
  const port = 33000 + Math.floor(Math.random() * 2000);
  const child = startService({ NODE_ENV: 'production', LOG_JSON: '1', PORT: String(port), MAX_HEADER_BYTES: '64' });
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 3000 });

  const large = 'x'.repeat(1024);
  const res = await fetchRaw(`${base}/wait?ms=1`, { 'X-Long-Header': large });
  assert.equal(res.status, 431);

  try { child.kill('SIGTERM'); } catch {}
  await new Promise((r) => child.on('exit', r));
});
