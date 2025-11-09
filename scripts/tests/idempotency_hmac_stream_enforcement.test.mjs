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

function getJsonWithHeaders(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ method: 'GET', hostname: u.hostname, port: u.port, path: u.pathname + (u.search || ''), headers }, (res) => {
      let out = '';
      res.on('data', (d) => { out += d.toString(); });
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(out || '{}'); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function fetchSSE(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ method: 'GET', hostname: u.hostname, port: u.port, path: u.pathname + (u.search || ''), headers }, (res) => {
      let buf = '';
      let startEvent = null;
      let endEvent = null;
      const flush = () => {
        const chunks = buf.split(/\r?\n\r?\n/);
        buf = chunks.pop();
        for (const chunk of chunks) {
          const lines = chunk.split(/\r?\n/);
          let evt = null;
          let dataStr = '';
          for (const line of lines) {
            if (line.startsWith('event:')) evt = line.slice(6).trim();
            else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
          }
          if (evt === 'start') {
            try { startEvent = JSON.parse(dataStr); } catch {}
          } else if (evt === 'end') {
            try { endEvent = JSON.parse(dataStr); } catch {}
          }
        }
      };
      res.on('data', (d) => { buf += d.toString(); flush(); });
      res.on('end', () => { flush(); resolve({ status: res.statusCode, headers: res.headers, startEvent, endEvent }); });
    });
    req.on('error', reject);
    req.end();
  });
}

test('Idempotency HMAC enforcement (stream): missing/invalid MAC rejected; valid accepted and replays', async () => {
  const port = 4720 + Math.floor(Math.random() * 200);
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

  const idemKey = 'idem-hmac-stream-key-1';
  const conv_id = 'conv-hmac-s1';
  const turn = 0;
  const q = `conv_id=${encodeURIComponent(conv_id)}&turn=${turn}&engine=urga&text=${encodeURIComponent('hello world')}`;

  // Missing MAC -> 401 JSON error
  const miss = await getJsonWithHeaders(`${base}/conv/stream?${q}`, { 'Idempotency-Key': idemKey });
  assert.equal(miss.status, 401);
  assert.equal(miss.json?.error, 'idem_mac_missing');

  // Invalid MAC -> 401 JSON error
  const expected = crypto.createHmac('sha256', secret).update(idemKey).digest('hex');
  const wrong = expected.slice(0, -1) + (expected.endsWith('a') ? 'b' : 'a');
  const bad = await getJsonWithHeaders(`${base}/conv/stream?${q}`, { 'Idempotency-Key': idemKey, 'Idempotency-MAC': wrong });
  assert.equal(bad.status, 401);
  assert.equal(bad.json?.error, 'idem_mac_invalid');

  // Valid MAC -> 200 with SSE events and replay works
  const s1 = await fetchSSE(`${base}/conv/stream?${q}`, { 'Idempotency-Key': idemKey, 'Idempotency-MAC': expected });
  assert.equal(s1.status, 200);
  assert.ok(s1.startEvent && s1.endEvent, 'initial stream carried start/end');

  const s2 = await fetchSSE(`${base}/conv/stream?${q}&replay=true`, { 'Idempotency-Key': idemKey, 'Idempotency-MAC': expected });
  assert.equal(s2.status, 200);
  assert.ok(s2.endEvent && s2.endEvent.idempotent_replay === true, 'replay end flagged as idempotent');

  try { child.kill('SIGTERM'); } catch {}
  await new Promise((r) => child.on('exit', r));
});
