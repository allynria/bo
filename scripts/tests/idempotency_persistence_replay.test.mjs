import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { waitForUp } from './helpers/wait_for_up.mjs';

function startService(env = {}) {
  const script = path.join(process.cwd(), 'scripts', 'service.js');
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
  let logs = '';
  child.stdout.on('data', (d) => {
    logs += d.toString();
  });
  child.stderr.on('data', (d) => {
    logs += d.toString();
  });
  return { child, getLogs: () => logs };
}

function postJson(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const u = new URL(url);
    const req = http.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers },
      },
      (res) => {
        let out = '';
        res.on('data', (d) => {
          out += d.toString();
        });
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode,
              headers: res.headers,
              json: JSON.parse(out || '{}'),
            });
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

test('Idempotent message replay persists across restarts and 1,000 replays', async () => {
  const port = 4400 + Math.floor(Math.random() * 200);
  const env = {
    PORT: String(port),
    QUEUE_MAX: '0',
    LLM_TURN_BUDGET: '5',
    LLM_TEST_STUBS: '1',
    URGA_PROVIDER: 'stub-urga',
    IDEMPOTENCY_TTL_MS: '300000',
    CONV_SOFT_MAX: '5000',
    MAX_HEADER_BYTES: '8192',
  };
  const { child } = startService(env);
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 5000 });

  const conv_id = 'idem-persist-1';
  const idemKey = 'idem-key-1';
  const body = { text: 'Hello idempotency', conv_id, turn: 0, engine: 'urga' };

  const first = await postJson(`${base}/conv/message`, body, { 'Idempotency-Key': idemKey });
  assert.equal(first.status, 200, 'first call succeeds');
  assert.ok(
    first.json && first.json.hash && first.json.bytes_b64,
    'first response includes determinism artifacts'
  );

  try {
    child.kill('SIGTERM');
  } catch {}
  await new Promise((r) => child.on('exit', r));

  // Restart and verify 1,000 idempotent replays
  const { child: child2 } = startService(env);
  await waitForUp(base, { timeout: 5000 });
  for (let i = 0; i < 1000; i++) {
    const rep = await postJson(`${base}/conv/message`, body, { 'Idempotency-Key': idemKey });
    assert.equal(rep.status, 200, `replay ${i} status 200`);
    assert.equal(rep.json.idempotent_replay, true, `replay ${i} flagged as idempotent`);
    assert.equal(rep.json.hash, first.json.hash, `replay ${i} hash matches`);
    assert.equal(rep.json.bytes_b64, first.json.bytes_b64, `replay ${i} bytes_b64 matches`);
  }
  try {
    child2.kill('SIGTERM');
  } catch {}
  await new Promise((r) => child2.on('exit', r));
});
