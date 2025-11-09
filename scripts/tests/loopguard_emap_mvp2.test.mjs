import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

function startService(env = {}) {
  return spawn('node', ['scripts/service.js'], {
    env: {
      ...process.env,
      PORT: '3460',
      NODE_ENV: 'production',
      LLM_TEST_STUBS: '1',
      URGA_PROVIDER: 'stub-urga',
      // Enable both guards
      LOOP_GUARD_ENABLED: '1',
      LOOP_HISTORY_N: '5',
      LOOP_DELTA_SIM_THRESHOLD: '0.8',
      LOOP_RETRY_LIMIT: '1',
      LOOP_GUARD_STYLE_TOKENS: 'descriptive,terse',
      // EMAP
      LOOP_EMBED_ENABLED: '1',
      LOOP_EMBED_HISTORY_N: '5',
      LOOP_EMBED_SIM_MAX: '0.05',
      LOOP_EMBED_MIN_LEN: '1',
      // Auth & CORS for /v1/conv/message
      CONV_AUTH: 't',
      CORS_ALLOWLIST: 'http://ok.test',
      REPLAY_WINDOW_MS: '5000',
      ...env,
    },
    stdio: 'inherit',
  });
}

async function postJSON(port, path, body, headers = {}) {
  const data = JSON.stringify(body);
  const opts = {
    hostname: '127.0.0.1',
    port,
    path,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(data),
      ...headers,
    },
  };
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(buf || '{}') }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function getMetrics(port) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}/metrics`, (res) => {
        let buf = '';
        res.on('data', (d) => (buf += d));
        res.on('end', () => resolve(JSON.parse(buf || '{"counters":[]}')));
      })
      .on('error', reject);
  });
}

(async () => {
  const proc = startService();
  const port = 3460;
  // wait for readiness via /healthz
  async function waitForReady(maxMs = 2500) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const ok = await new Promise((resolve) => {
        try {
          http
            .get(`http://127.0.0.1:${port}/healthz`, (res) => {
              resolve(res.statusCode === 200);
            })
            .on('error', () => resolve(false));
        } catch {
          resolve(false);
        }
      });
      if (ok) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('service not ready in time');
  }
  await waitForReady();

  const conv = 'emap-loop-test';
  const a = await postJSON(
    port,
    '/v1/conv/message',
    { conv_id: conv, text: 'She smiles softly and nods.', ts: Date.now() },
    { origin: 'http://ok.test', authorization: 'Bearer t' }
  );
  assert.equal(a.status, 200);
  const b = await postJSON(
    port,
    '/v1/conv/message',
    { conv_id: conv, text: 'She smiles softly and nods once more.', ts: Date.now() },
    { origin: 'http://ok.test', authorization: 'Bearer t' }
  );
  assert.equal(b.status, 200);
  const m = await getMetrics(port);
  const hit = (m.counters || []).some(
    (c) => c.name === 'loopguard_emap_trigger_total' && c.labels?.path === 'message'
  );
  assert.equal(hit, true, 'expected loopguard_emap_trigger_total metric');
  proc.kill('SIGINT');
  console.log('OK loopguard emap mvp');
})();
