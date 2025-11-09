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

test('conv endpoints block unauth and enforce CORS in prod', async () => {
  const port = 33200 + Math.floor(Math.random() * 500);
  const token = 'topsecret';
  const allowed = 'http://allowed.test';
  const base = `http://localhost:${port}`;
  const { child } = startService({ NODE_ENV: 'production', LOG_JSON: '1', PORT: String(port), CONV_AUTH: token, CORS_ALLOWLIST: allowed, LLM_TEST_STUBS: '1', URGA_PROVIDER: 'stub-urga' });
  await waitForUp(base, { timeout: 3000 });

  const nowTs = Date.now();

  // message: no auth -> 401
  const mNoAuth = await postJson(`${base}/conv/message`, { text: 'hi', conv_id: 'c1', ts: nowTs }, { origin: allowed });
  assert.equal(mNoAuth.status, 401, 'message without auth is blocked');
  assert.ok(mNoAuth.text.includes('error'));

  // message: wrong origin -> 403
  const mBadCors = await postJson(`${base}/conv/message`, { text: 'hi', conv_id: 'c1', ts: nowTs }, { origin: 'http://evil.test', authorization: `Bearer ${token}` });
  assert.equal(mBadCors.status, 403, 'message disallowed origin blocked');
  assert.ok(mBadCors.text.includes('cors_forbidden'));

  // message: valid auth + allowed origin -> 200
  const mOk = await postJson(`${base}/conv/message`, { text: 'hi', conv_id: 'c1', ts: nowTs }, { origin: allowed, authorization: `Bearer ${token}` });
  assert.equal(mOk.status, 200, 'message authorized');

  // stream: no auth -> 401
  const sNoAuth = await getRaw(`${base}/conv/stream?text=hi&conv_id=c2&turn=0&ts=${nowTs}`, { origin: allowed });
  assert.equal(sNoAuth.status, 401, 'stream without auth is blocked');
  assert.ok(sNoAuth.text.includes('error'));

  // stream: bad CORS -> 403
  const sBadCors = await getRaw(`${base}/conv/stream?text=hi&conv_id=c2&turn=0&ts=${nowTs}`, { origin: 'http://evil.test', authorization: `Bearer ${token}` });
  assert.equal(sBadCors.status, 403, 'stream disallowed origin blocked');
  assert.ok(sBadCors.text.includes('cors_forbidden'));

  // stream: valid -> 200
  const sOk = await getRaw(`${base}/conv/stream?text=hi&conv_id=c2&turn=0&ts=${nowTs}`, { origin: allowed, authorization: `Bearer ${token}` });
  assert.equal(sOk.status, 200, 'stream authorized');

  try { child.kill(); } catch {}
  await new Promise((r) => child.on('exit', r));
});

test('replay window enforced for message and stream', async () => {
  const port = 33300 + Math.floor(Math.random() * 500);
  const token = 'topsecret';
  const allowed = 'http://allowed.test';
  const base = `http://localhost:${port}`;
  const { child } = startService({ NODE_ENV: 'production', LOG_JSON: '1', PORT: String(port), CONV_AUTH: token, CORS_ALLOWLIST: allowed, REPLAY_WINDOW_MS: '50', LLM_TEST_STUBS: '1', URGA_PROVIDER: 'stub-urga' });
  await waitForUp(base, { timeout: 3000 });

  const staleTs = Date.now() - 10_000;
  const freshTs = Date.now();

  const mStale = await postJson(`${base}/conv/message`, { text: 'hi', conv_id: 'c3', ts: staleTs }, { origin: allowed, authorization: `Bearer ${token}` });
  assert.equal(mStale.status, 401, 'stale ts blocked');
  assert.ok(mStale.text.includes('replay_window_exceeded'));

  const mFresh = await postJson(`${base}/conv/message`, { text: 'hi', conv_id: 'c3', ts: freshTs }, { origin: allowed, authorization: `Bearer ${token}` });
  assert.equal(mFresh.status, 200, 'fresh ts accepted');

  const sStale = await getRaw(`${base}/conv/stream?text=hi&conv_id=c3&turn=0&ts=${staleTs}`, { origin: allowed, authorization: `Bearer ${token}` });
  assert.equal(sStale.status, 401, 'stream stale ts blocked');
  assert.ok(sStale.text.includes('replay_window_exceeded'));

  const sFresh = await getRaw(`${base}/conv/stream?text=hi&conv_id=c3&turn=0&ts=${freshTs}`, { origin: allowed, authorization: `Bearer ${token}` });
  assert.equal(sFresh.status, 200, 'stream fresh ts accepted');

  try { child.kill(); } catch {}
  await new Promise((r) => child.on('exit', r));
});

test('HMAC signatures accepted; invalid or missing rejected', async () => {
  const port = 33400 + Math.floor(Math.random() * 500);
  const secret = 'hmac-secret';
  const allowed = 'http://allowed.test';
  const base = `http://localhost:${port}`;
  const { child } = startService({ NODE_ENV: 'production', LOG_JSON: '1', PORT: String(port), CONV_HMAC_SECRET: secret, CORS_ALLOWLIST: allowed, REPLAY_WINDOW_MS: '5000', LLM_TEST_STUBS: '1', URGA_PROVIDER: 'stub-urga' });
  await waitForUp(base, { timeout: 3000 });

  const ts = Date.now();
  const macMsg = crypto.createHmac('sha256', secret).update(`POST:message:${String(ts)}`).digest('hex');
  const macStr = crypto.createHmac('sha256', secret).update(`GET:stream:${String(ts)}`).digest('hex');

  const mNoMac = await postJson(`${base}/conv/message`, { text: 'hi', conv_id: 'c4', ts }, { origin: allowed });
  assert.equal(mNoMac.status, 401, 'message missing mac blocked');
  assert.ok(mNoMac.text.includes('error'));

  const mOk = await postJson(`${base}/conv/message`, { text: 'hi', conv_id: 'c4', ts }, { origin: allowed, 'x-client-mac': macMsg });
  assert.equal(mOk.status, 200, 'message with mac accepted');

  const sNoMac = await getRaw(`${base}/conv/stream?text=hi&conv_id=c4&turn=0&ts=${ts}`, { origin: allowed });
  assert.equal(sNoMac.status, 401, 'stream missing mac blocked');

  const sOk = await getRaw(`${base}/conv/stream?text=hi&conv_id=c4&turn=0&ts=${ts}`, { origin: allowed, 'x-client-mac': macStr });
  assert.equal(sOk.status, 200, 'stream with mac accepted');

  try { child.kill(); } catch {}
  await new Promise((r) => child.on('exit', r));
});

