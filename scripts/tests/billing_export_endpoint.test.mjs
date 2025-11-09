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

function postJson(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c.toString(); });
      res.on('end', () => {
        let j = {};
        try { j = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, json: j, headers: res.headers });
      });
    });
    req.on('error', reject);
    try { req.write(JSON.stringify(body || {})); } catch {}
    req.end();
  });
}

function fetchNdjson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c.toString(); });
      res.on('end', () => {
        resolve({ status: res.statusCode, body, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('billing export endpoint streams signed NDJSON with resume token', async () => {
  const port = 3900 + Math.floor(Math.random() * 500);
  const token = 'admintoken';
  const child = startService({ NODE_ENV: 'production', LOG_JSON: '1', PORT: String(port), ADMIN_TOKEN: token, USAGE_HMAC_SECRET: 'billing-secret', LLM_TEST_STUBS: '1', URGA_PROVIDER: 'stub-urga' });
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 3000 });

  // Trigger a simple message call to produce llm_cost metrics (stub provider)
  const tenant = 'test-tenant';
  const msg = await postJson(`${base}/message`, { message: { role: 'user', content: 'hello' }, ctx: { vars: { tenant } } }, { 'x-tenant': tenant });
  assert.equal(msg.status, 200);

  // Export usage ledger
  const ndj = await fetchNdjson(`${base}/billing/export`, { Authorization: `Bearer ${token}` });
  assert.equal(ndj.status, 200);
  assert.equal(String(ndj.headers['content-type'] || ''), 'application/x-ndjson');
  const lines = (ndj.body || '').trim().split(/\n+/);
  assert.ok(lines.length >= 1);
  const first = JSON.parse(lines[0]);
  assert.equal(typeof first.ts, 'number');
  assert.ok(first.event === 'llm_cost' || first.event === 'cost_usd');
  assert.equal(first.tenant, tenant);
  assert.equal(typeof first.sig, 'string');
  assert.ok(first.sig.length > 8);
  assert.equal(typeof ndj.headers['x-resume-token'], 'string');
  assert.equal(typeof ndj.headers['x-checksum'], 'string');

  try { child.kill('SIGTERM'); } catch {}
  await new Promise((r) => child.on('exit', r));
});

