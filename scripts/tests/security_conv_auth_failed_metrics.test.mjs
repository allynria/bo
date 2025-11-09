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
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(data.length),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => {
          text += c.toString();
        });
        res.on('end', () => resolve({ status: res.statusCode, text }));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function getRaw(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', headers }, (res) => {
      let text = '';
      res.on('data', (c) => {
        text += c.toString();
      });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('auth_failed_total includes method and mac_id on 401s', async () => {
  const port = 34000 + Math.floor(Math.random() * 500);
  const allowed = 'http://allowed.test';
  const base = `http://localhost:${port}`;
  const metricsToken = 'metrics123';
  const token = 'topsecret';
  const secret = 'hmacKey';
  const { child } = startService({
    NODE_ENV: 'production',
    LOG_JSON: '1',
    PORT: String(port),
    CONV_AUTH: token,
    CONV_HMAC_SECRET: secret,
    CORS_ALLOWLIST: allowed,
    REPLAY_WINDOW_MS: '5000',
    METRICS_AUTH: metricsToken,
    LLM_TEST_STUBS: '1',
    URGA_PROVIDER: 'stub-urga',
  });
  await waitForUp(base, { timeout: 3000 });

  // message: wrong token -> 401
  const ts1 = Date.now();
  const mBadTok = await postJson(
    `${base}/conv/message`,
    { text: 'hi', conv_id: 'mX', ts: ts1 },
    { origin: allowed, authorization: 'Bearer wrong' }
  );
  assert.equal(mBadTok.status, 401);

  // stream: wrong hmac -> 401
  const ts2 = Date.now();
  const badMac = crypto
    .createHmac('sha256', 'other')
    .update(`GET:stream:${String(ts2)}`)
    .digest('hex');
  const sBadMac = await getRaw(`${base}/conv/stream?text=hi&conv_id=sX&turn=0&ts=${ts2}`, {
    origin: allowed,
    'x-client-mac': badMac,
    'x-mac-id': 'kidA',
  });
  assert.equal(sBadMac.status, 401);

  const m = await getRaw(`${base}/metrics`, { authorization: `Bearer ${metricsToken}` });
  assert.equal(m.status, 200);
  const parsed = JSON.parse(m.text);
  assert.ok(Array.isArray(parsed?.counters));
  const failed = parsed.counters.filter((c) => c.name === 'auth_failed_total');
  assert.ok(failed.length >= 2, 'expects at least two auth_failed_total counters');
  const labels = failed.map((c) => c.labels).filter(Boolean);
  const hasMsgTokenFail = labels.some(
    (l) => l.reason === 'token_invalid' && l.path === 'message' && l.method === 'token'
  );
  const hasStrHmacFail = labels.some(
    (l) =>
      l.reason === 'hmac_invalid' &&
      l.path === 'stream' &&
      l.method === 'hmac' &&
      l.mac_id === 'kidA'
  );
  assert.ok(hasMsgTokenFail, 'auth_failed_total must record token failures on message');
  assert.ok(hasStrHmacFail, 'auth_failed_total must record hmac failures with mac_id on stream');

  try {
    child.kill();
  } catch {}
  await new Promise((r) => child.on('exit', r));
});

test('auth_missing increments auth_failed_total for missing credentials', async () => {
  const port = 34100 + Math.floor(Math.random() * 500);
  const allowed = 'http://allowed.test';
  const base = `http://localhost:${port}`;
  const metricsToken = 'metrics123';
  const token = 'topsecret';
  const { child } = startService({
    NODE_ENV: 'production',
    LOG_JSON: '1',
    PORT: String(port),
    CONV_AUTH: token,
    CORS_ALLOWLIST: allowed,
    REPLAY_WINDOW_MS: '5000',
    METRICS_AUTH: metricsToken,
    LLM_TEST_STUBS: '1',
    URGA_PROVIDER: 'stub-urga',
  });
  await waitForUp(base, { timeout: 3000 });

  const ts = Date.now();
  const r = await postJson(
    `${base}/conv/message`,
    { text: 'hi', conv_id: 'mY', ts },
    { origin: allowed }
  );
  assert.equal(r.status, 401);

  const m = await getRaw(`${base}/metrics`, { authorization: `Bearer ${metricsToken}` });
  assert.equal(m.status, 200);
  const parsed = JSON.parse(m.text);
  const labels = (parsed?.counters || [])
    .filter((c) => c.name === 'auth_failed_total')
    .map((c) => c.labels)
    .filter(Boolean);
  const hasMissing = labels.some(
    (l) => l.reason === 'auth_missing' && l.path === 'message' && l.method === 'none'
  );
  assert.ok(hasMissing, 'auth_failed_total must record auth_missing for missing credentials');

  try {
    child.kill();
  } catch {}
  await new Promise((r2) => child.on('exit', r2));
});
