import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { waitForUp } from './helpers/wait_for_up.mjs';

function describeDiffB64(a, b, label = 'bytes_b64') {
  const A = Buffer.from(String(a || ''), 'base64');
  const B = Buffer.from(String(b || ''), 'base64');
  const lenA = A.length,
    lenB = B.length;
  const minLen = Math.min(lenA, lenB);
  let idx = -1;
  for (let i = 0; i < minLen; i++) {
    if (A[i] !== B[i]) {
      idx = i;
      break;
    }
  }
  if (idx === -1 && lenA !== lenB) return `${label} length mismatch: a=${lenA}, b=${lenB}`;
  if (idx === -1) return `${label} mismatch but no differing byte found (unexpected)`;
  const sliceA = A.subarray(Math.max(0, idx - 8), Math.min(lenA, idx + 8)).toString('hex');
  const sliceB = B.subarray(Math.max(0, idx - 8), Math.min(lenB, idx + 8)).toString('hex');
  return `${label} differs at byte ${idx}: a≈${sliceA}, b≈${sliceB}`;
}

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

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const u = new URL(url);
    const req = http.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
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

test('Determinism gate: /conv/compile returns stable hash/bytes_b64', async () => {
  const port = 4500 + Math.floor(Math.random() * 200);
  const env = { PORT: String(port), QUEUE_MAX: '0', MAX_HEADER_BYTES: '8192' };
  const { child } = startService(env);
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 5000 });
  const messages = [
    { role: 'system', content: ['You are precise.'] },
    { role: 'user', content: ['Check determinism of prompt assembly.'] },
  ];
  const r1 = await postJson(`${base}/conv/compile`, { messages });
  const r2 = await postJson(`${base}/conv/compile`, { messages });
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.ok(
    r1.json && r1.json.hash && r1.json.bytes_b64,
    'first compile provides determinism artifacts'
  );
  assert.ok(
    r2.json && r2.json.hash && r2.json.bytes_b64,
    'second compile provides determinism artifacts'
  );
  assert.equal(r1.json.hash, r2.json.hash, 'compile hash stable');
  if (r1.json.bytes_b64 !== r2.json.bytes_b64) {
    assert.fail(describeDiffB64(r1.json.bytes_b64, r2.json.bytes_b64, 'compile.bytes_b64'));
  }
  try {
    child.kill('SIGTERM');
  } catch {}
  await new Promise((r) => child.on('exit', r));
});

test('Determinism gate: /conv/message returns stable hash/bytes_b64 across restarts', async () => {
  const port = 4550 + Math.floor(Math.random() * 200);
  const env = {
    PORT: String(port),
    QUEUE_MAX: '0',
    LLM_TURN_BUDGET: '5',
    LLM_TEST_STUBS: '1',
    URGA_PROVIDER: 'stub-urga',
    MAX_HEADER_BYTES: '8192',
  };
  const { child } = startService(env);
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 5000 });
  const body = { text: 'Determinism check', conv_id: 'det-msg-1', turn: 0, engine: 'urga' };
  const r1 = await postJson(`${base}/conv/message`, body);
  const r2 = await postJson(`${base}/conv/message`, body);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.ok(r1.json && r1.json.hash && r1.json.bytes_b64, 'message includes determinism artifacts');
  assert.equal(r1.json.hash, r2.json.hash, 'message hash stable in-session');
  if (r1.json.bytes_b64 !== r2.json.bytes_b64) {
    assert.fail(
      describeDiffB64(r1.json.bytes_b64, r2.json.bytes_b64, 'message.bytes_b64.in_session')
    );
  }
  try {
    child.kill('SIGTERM');
  } catch {}
  await new Promise((r) => child.on('exit', r));

  const { child: child2 } = startService(env);
  await waitForUp(base, { timeout: 5000 });
  const r3 = await postJson(`${base}/conv/message`, body);
  assert.equal(r3.status, 200);
  assert.equal(r3.json.hash, r1.json.hash, 'message hash stable across restart');
  if (r3.json.bytes_b64 !== r1.json.bytes_b64) {
    assert.fail(
      describeDiffB64(r3.json.bytes_b64, r1.json.bytes_b64, 'message.bytes_b64.cross_restart')
    );
  }
  try {
    child2.kill('SIGTERM');
  } catch {}
  await new Promise((r) => child2.on('exit', r));
});
