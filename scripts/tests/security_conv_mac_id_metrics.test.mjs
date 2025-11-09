import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import crypto from 'node:crypto';
import { waitForUp } from './helpers/wait_for_up.mjs';

function startService(env = {}) {
  const script = path.join(process.cwd(), 'scripts', 'service.js');
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
  return { child };
}

function postJson(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': String(data.length), ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c.toString(); });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function getRaw(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c.toString(); });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('auth_accepted_total includes mac_id labels for HMAC lineage', async () => {
  const port = 33800 + Math.floor(Math.random() * 500);
  const allowed = 'http://allowed.test';
  const base = `http://localhost:${port}`;
  const metricsToken = 'metrics123';
  const oldSec = 'old';
  const newSec = 'new';
  const { child } = startService({ NODE_ENV: 'production', LOG_JSON: '1', PORT: String(port), CONV_HMAC_SECRETS: `${oldSec},${newSec}`, CORS_ALLOWLIST: allowed, REPLAY_WINDOW_MS: '5000', METRICS_AUTH: metricsToken, LLM_TEST_STUBS: '1', URGA_PROVIDER: 'stub-urga' });
  await waitForUp(base, { timeout: 3000 });

  const ts1 = Date.now();
  const macMsg = crypto.createHmac('sha256', newSec).update(`POST:message:${String(ts1)}`).digest('hex');
  const r1 = await postJson(`${base}/conv/message`, { text: 'hi', conv_id: 'm1', ts: ts1 }, { origin: allowed, 'x-client-mac': macMsg, 'x-mac-id': 'new' });
  assert.equal(r1.status, 200);

  const ts2 = Date.now();
  const macStr = crypto.createHmac('sha256', oldSec).update(`GET:stream:${String(ts2)}`).digest('hex');
  const r2 = await getRaw(`${base}/conv/stream?text=hi&conv_id=s1&turn=0&ts=${ts2}`, { origin: allowed, 'x-client-mac': macStr, 'x-mac-id': 'old' });
  assert.equal(r2.status, 200);

  const m = await getRaw(`${base}/metrics`, { authorization: `Bearer ${metricsToken}` });
  assert.equal(m.status, 200);
  const parsed = JSON.parse(m.text);
  assert.ok(parsed && parsed.counters && Array.isArray(parsed.counters));
  const acc = parsed.counters.filter((c) => c.name === 'auth_accepted_total');
  const labels = acc.map((c) => c.labels).filter(Boolean);
  const hasNew = labels.some((l) => l.method === 'hmac' && l.mac_id === 'new' && l.path === 'message');
  const hasOld = labels.some((l) => l.method === 'hmac' && l.mac_id === 'old' && l.path === 'stream');
  assert.ok(hasNew, 'metrics must include mac_id=new for hmac acceptance');
  assert.ok(hasOld, 'metrics must include mac_id=old for hmac acceptance');

  try { child.kill(); } catch {}
  await new Promise((r) => child.on('exit', r));
});

