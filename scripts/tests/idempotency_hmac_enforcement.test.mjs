import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { waitForUp } from './helpers/wait_for_up.mjs';

function startService(env = {}) {
  const script = path.join(process.cwd(), 'scripts', 'service.js');
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d.toString(); });
  child.stderr.on('data', (d) => { logs += d.toString(); });
  return { child, getLogs: () => logs };
}

function postJsonWithHeaders(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const u = new URL(url);
    const req = http.request({ method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname, headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers } }, (res) => {
      let out = '';
      res.on('data', (d) => { out += d.toString(); });
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(out || '{}'); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

test('Idempotency HMAC enforcement: missing/invalid MAC rejected; valid accepted and replays', async () => {
  const port = 4700 + Math.floor(Math.random() * 200);
  const secret = 'supersecret';
  const env = {
    PORT: String(port),
    QUEUE_MAX: '0',
    LLM_TURN_BUDGET: '5',
    LLM_TEST_STUBS: '1',
    URGA_PROVIDER: 'stub-urga',
    IDEMPOTENCY_TTL_MS: '300000',
    IDEMPOTENCY_HMAC_SECRET: secret
  };
  const { child, getLogs } = startService(env);
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 5000 }).catch(async () => { try { child.kill('SIGTERM'); } catch {}; throw new Error('service did not become ready: ' + getLogs()); });

  const idemKey = 'idem-hmac-key-1';
  const body = { text: 'HMAC enforced', conv_id: 'conv-hmac-1', turn: 0, engine: 'urga' };

  // Missing MAC -> 401
  const miss = await postJsonWithHeaders(`${base}/conv/message`, body, { 'Idempotency-Key': idemKey });
  assert.equal(miss.status, 401);
  assert.equal(miss.json?.error, 'idem_mac_missing');

  // Invalid MAC -> 401
  const expected = crypto.createHmac('sha256', secret).update(idemKey).digest('hex');
  const wrong = expected.slice(0, -1) + (expected.endsWith('a') ? 'b' : 'a');
  const bad = await postJsonWithHeaders(`${base}/conv/message`, body, { 'Idempotency-Key': idemKey, 'Idempotency-MAC': wrong });
  assert.equal(bad.status, 401);
  assert.equal(bad.json?.error, 'idem_mac_invalid');

  // Valid MAC -> 200 and idempotent replay works
  const ok1 = await postJsonWithHeaders(`${base}/conv/message`, body, { 'Idempotency-Key': idemKey, 'Idempotency-MAC': expected });
  assert.equal(ok1.status, 200);
  assert.ok(ok1.json && ok1.json.hash && ok1.json.bytes_b64, 'first response includes determinism artifacts');

  const ok2 = await postJsonWithHeaders(`${base}/conv/message`, body, { 'Idempotency-Key': idemKey, 'Idempotency-MAC': expected });
  assert.equal(ok2.status, 200);
  assert.equal(ok2.json?.idempotent_replay, true);
  assert.equal(ok2.json?.hash, ok1.json?.hash);
  assert.equal(ok2.json?.bytes_b64, ok1.json?.bytes_b64);

  try { child.kill('SIGTERM'); } catch {}
  await new Promise((r) => child.on('exit', r));
});

