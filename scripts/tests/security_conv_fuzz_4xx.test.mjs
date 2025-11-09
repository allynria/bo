import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { waitForUp } from './helpers/wait_for_up.mjs';

function startService(env = {}) {
  const script = path.join(process.cwd(), 'scripts', 'service.js');
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d.toString(); });
  child.stderr.on('data', (d) => { logs += d.toString(); });
  return { child, getLogs: () => logs };
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

test('fuzz invalid headers and ts skew taxonomy', async () => {
  const port = 33500 + Math.floor(Math.random() * 500);
  const token = 'topsecret';
  const allowed = 'http://allowed.test';
  const base = `http://localhost:${port}`;
  const { child } = startService({ NODE_ENV: 'production', LOG_JSON: '1', PORT: String(port), CONV_AUTH: token, CORS_ALLOWLIST: allowed, REPLAY_WINDOW_MS: '50', REPLAY_SKEW_TOLERANCE_MS: '10000', LLM_TEST_STUBS: '1', URGA_PROVIDER: 'stub-urga' });
  await waitForUp(base, { timeout: 3000 });

  const now = Date.now();
  const cases = [
    // Message variations
    () => postJson(`${base}/conv/message`, { text: 'hi', conv_id: 'm1', ts: now }, { origin: allowed }), // no auth
    () => postJson(`${base}/conv/message`, { text: 'hi', conv_id: 'm2', ts: now }, { origin: 'http://evil.test', authorization: `Bearer ${token}` }), // bad CORS
    () => postJson(`${base}/conv/message`, { text: 'hi', conv_id: 'm3' }, { origin: allowed, authorization: `Bearer ${token}` }), // missing ts
    () => postJson(`${base}/conv/message`, { text: 'hi', conv_id: 'm4', ts: now - 20000 }, { origin: allowed, authorization: `Bearer ${token}` }), // stale beyond tolerance
    // Stream variations
    () => getRaw(`${base}/conv/stream?text=hi&conv_id=s1&turn=0&ts=${now}`, { origin: allowed }), // no auth
    () => getRaw(`${base}/conv/stream?text=hi&conv_id=s2&turn=0&ts=${now}`, { origin: 'http://evil.test', authorization: `Bearer ${token}` }), // bad CORS
    () => getRaw(`${base}/conv/stream?text=hi&conv_id=s3&turn=0`, { origin: allowed, authorization: `Bearer ${token}` }), // missing ts
    () => getRaw(`${base}/conv/stream?text=hi&conv_id=s4&turn=0&ts=${now - 20000}`, { origin: allowed, authorization: `Bearer ${token}` }), // stale beyond tolerance
  ];

  const results = await Promise.all(cases.map((fn) => fn()));
  const statuses = results.map((r) => r.status);
  // Expect taxonomy 401 or 403; never 200
  results.forEach((r, i) => {
    assert.ok([401,403].includes(r.status), `case ${i} expected 4xx, got ${r.status}`);
    assert.ok(r.text.includes('error'), `case ${i} body must include error`);
  });

  // Positive skew within tolerance should be accepted
  const okMsg = await postJson(`${base}/conv/message`, { text: 'hi', conv_id: 'm5', ts: now - 500 }, { origin: allowed, authorization: `Bearer ${token}` });
  assert.equal(okMsg.status, 200);
  const okStr = await getRaw(`${base}/conv/stream?text=hi&conv_id=s5&turn=0&ts=${now - 500}`, { origin: allowed, authorization: `Bearer ${token}` });
  assert.equal(okStr.status, 200);

  try { child.kill(); } catch {}
  await new Promise((r) => child.on('exit', r));
});

test('HMAC rotation supports multiple secrets', async () => {
  const port = 33600 + Math.floor(Math.random() * 500);
  const allowed = 'http://allowed.test';
  const base = `http://localhost:${port}`;
  const oldSec = 'old-secret';
  const newSec = 'new-secret';
  const { child } = startService({ NODE_ENV: 'production', LOG_JSON: '1', PORT: String(port), CONV_HMAC_SECRETS: `${oldSec},${newSec}`, CORS_ALLOWLIST: allowed, REPLAY_WINDOW_MS: '10000', URGA_PROVIDER: 'stub-urga', LLM_TEST_STUBS: '1' });
  await waitForUp(base, { timeout: 3000 });

  const ts = Date.now();
  const macOldMsg = crypto.createHmac('sha256', oldSec).update(`POST:message:${String(ts)}`).digest('hex');
  const macNewStr = crypto.createHmac('sha256', newSec).update(`GET:stream:${String(ts)}`).digest('hex');
  const macBadMsg = crypto.createHmac('sha256', 'bad').update(`POST:message:${String(ts)}`).digest('hex');

  const okMsg = await postJson(`${base}/conv/message`, { text: 'hi', conv_id: 'mm', ts }, { origin: allowed, 'x-client-mac': macOldMsg });
  assert.equal(okMsg.status, 200, 'message accepts old secret');
  const okStr = await getRaw(`${base}/conv/stream?text=hi&conv_id=ss&turn=0&ts=${ts}`, { origin: allowed, 'x-client-mac': macNewStr });
  assert.equal(okStr.status, 200, 'stream accepts new secret');

  const badMsg = await postJson(`${base}/conv/message`, { text: 'hi', conv_id: 'bad', ts }, { origin: allowed, 'x-client-mac': macBadMsg });
  assert.equal(badMsg.status, 401, 'message rejects bad secret');

  try { child.kill(); } catch {}
  await new Promise((r) => child.on('exit', r));
});

