import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { waitForUp } from './helpers/wait_for_up.mjs';

function startService(env = {}) {
  const script = path.join(process.cwd(), 'scripts', 'service.js');
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
  return child;
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const u = new URL(url);
    const req = http.request({ method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname, headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => {
      let out = '';
      res.on('data', (d) => { out += d.toString(); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(out || '{}') }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (d) => { data += d.toString(); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(data || '{}') }); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

test('per-tenant limiter returns 429 for excess requests within window', async () => {
  const port = 3950 + Math.floor(Math.random() * 100);
  const env = { PORT: String(port), QUEUE_MAX: '0', TENANT_LIMIT: '2', TENANT_WINDOW_MS: '500', TENANT_INTERNAL_ERROR_ONCE: '0', LOG_JSON: '1' };
  const child = startService(env);
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 4000 });

  const conv_id = 'tenant-msg-1';
  const mkBody = (tenant) => ({ text: 'hello', conv_id, turn: 0, ctx: { meta: { tenant } } });
  const a = await postJson(`${base}/conv/message`, mkBody('tenant-A'));
  const b = await postJson(`${base}/conv/message`, mkBody('tenant-A'));
  const c = await postJson(`${base}/conv/message`, mkBody('tenant-A'));
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(c.status, 429);
  assert.ok(c.headers['retry-after']);

  const d = await postJson(`${base}/conv/message`, mkBody('tenant-B'));
  assert.equal(d.status, 200, 'different tenant should not be limited yet');

  const m = await fetchJson(`${base}/metrics`);
  const counters = m.json.counters || [];
  const tenant429 = counters.find((c) => c.name === 'rate_limited_total' && c.labels?.reason === 'tenant')?.value || 0;
  const resp429 = counters.find((c) => c.name === 'responses_total' && c.labels?.status === '429')?.value || 0;
  assert.equal(tenant429, 1);
  assert.ok(resp429 >= 1);

  try { child.kill('SIGTERM'); } catch {}
  await new Promise((r) => child.on('exit', r));
});

