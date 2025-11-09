import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Minimal helpers (mirroring style used in other tests)
function startService(env = {}) {
  const AUTH = 'test-token-123';
  const ORIGIN = 'http://allowed.test';
  const PORT = String(env.PORT || '3480');
  const child = spawn('node', ['scripts/service.js'], {
    env: {
      ...process.env,
      PORT,
      NODE_ENV: 'production',
      LLM_TEST_STUBS: '1',
      URGA_PROVIDER: 'stub-urga',
      LOOP_ENTROPY_ENABLED: '1',
      LOOP_ENTROPY_MIN: '2.8',
      LOOP_ENTROPY_MIN_TURBO: '3.1', // stricter during turbo
      CONV_AUTH: AUTH,
      CORS_ALLOWLIST: ORIGIN,
      ...env,
    },
    stdio: 'inherit',
  });
  return { child, auth: AUTH, origin: ORIGIN, port: Number(PORT) };
}

async function waitForUp(port, path = '/healthz', timeoutMs = 4000, intervalMs = 100) {
  const t0 = Date.now();
  let lastErr = null;
  while ((Date.now() - t0) < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        http.get({ hostname: '127.0.0.1', port, path }, (res) => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) resolve(); else reject(new Error('bad_status'));
        }).on('error', reject);
      });
      return true;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  if (lastErr) throw lastErr;
  throw new Error('service_unavailable');
}

async function postJSON(port, path, body, { auth, origin }) {
  const data = JSON.stringify(body);
  const opts = {
    hostname: '127.0.0.1',
    port,
    path,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(data),
      'authorization': `Bearer ${auth}`,
      'origin': origin,
    },
  };
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(buf || '{}'); } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function getMetrics(port) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: '/metrics' }, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => {
        let json = { counters: [] };
        try { json = JSON.parse(buf || '{"counters":[]}'); } catch {}
        resolve(json);
      });
    }).on('error', reject);
  });
}

test('LoopBreak command increments metric on v1 message path', async (t) => {
  const { child, auth, origin, port } = startService();
  t.after(() => { try { child.kill('SIGINT'); } catch {} });
  await waitForUp(port);

  const conv = 'loopbreak-demo';
  // Enable turbo for 2 turns
  const a = await postJSON(port, '/v1/conv/message', { conv_id: conv, text: '!loopbreak 2', engine: 'urga', turn: 0 }, { auth, origin });
  assert.equal(a.status, 200);

  // Two normal messages
  await postJSON(port, '/v1/conv/message', { conv_id: conv, text: 'She smiles softly and nods.', engine: 'urga', turn: 1 }, { auth, origin });
  await postJSON(port, '/v1/conv/message', { conv_id: conv, text: 'She smiles softly again.', engine: 'urga', turn: 2 }, { auth, origin });

  const m = await getMetrics(port);
  const seen = Array.isArray(m?.counters) && m.counters.some((c) => c?.name === 'loopguard_loopbreak_total');
  assert.equal(seen, true, 'expected loopguard_loopbreak_total metric');
});

