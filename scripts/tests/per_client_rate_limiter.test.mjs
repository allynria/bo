import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

function startService(env = {}) {
  const script = path.join(process.cwd(), 'scripts', 'service.js');
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
  return child;
}

function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (c) => {
        body += c.toString();
      });
      res.on('end', () => {
        let json = {};
        try {
          json = JSON.parse(body);
        } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('per-client limiter returns 429 for excess requests within window', async () => {
  const port = 3900 + Math.floor(Math.random() * 100);
  const child = startService({
    NODE_ENV: 'production',
    LOG_JSON: '1',
    PORT: String(port),
    CLIENT_LIMIT: '2',
    CLIENT_WINDOW_MS: '500',
    CLIENT_INTERNAL_ERROR_ONCE: '0',
  });
  const base = `http://localhost:${port}`;
  // Ensure service is ready before proceeding
  let ready = false;
  for (let i = 0; i < 15 && !ready; i++) {
    try {
      const hz = await fetchJson(`${base}/healthz`);
      ready = hz.status === 200;
    } catch {}
    if (!ready) await new Promise((r) => setTimeout(r, 60));
  }
  assert.equal(ready, true, 'service should be ready');

  const H = { 'x-forwarded-for': '1.2.3.4' };
  const a = await fetchJson(`${base}/wait?ms=1`, H);
  const b = await fetchJson(`${base}/wait?ms=1`, H);
  const c = await fetchJson(`${base}/wait?ms=1`, H);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(c.status, 429);

  const H2 = { 'x-forwarded-for': '5.6.7.8' };
  const d = await fetchJson(`${base}/wait?ms=1`, H2);
  assert.equal(d.status, 200, 'independent client should not be limited yet');

  try {
    child.kill('SIGTERM');
  } catch {}
  await new Promise((r) => child.on('exit', r));
});
