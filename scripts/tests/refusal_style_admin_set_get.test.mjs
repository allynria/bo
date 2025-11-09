import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { spawn } from 'node:child_process';

function startService(env = {}) {
  const PORT = 4470 + Math.floor(Math.random() * 200);
  const child = spawn(process.execPath, ['scripts/service.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(PORT),
      LLM_TEST_STUBS: '1',
      URGA_PROVIDER: 'stub-urga',
      ADMIN_TOKEN: 'adm',
      CORS_ALLOWLIST: 'http://ok.test',
      CONV_AUTH: 't',
      ...env,
    },
    stdio: 'inherit',
  });
  return { child, port: PORT };
}

async function waitForUp(port, timeoutMs = 4000) {
  const t0 = Date.now();
  let lastErr = null;
  while ((Date.now() - t0) < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        http.get({ hostname: '127.0.0.1', port, path: '/healthz' }, (res) => {
          if (res.statusCode === 200) resolve(); else reject(new Error('bad_status'));
        }).on('error', reject);
      });
      return true;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (lastErr) throw lastErr;
  throw new Error('service_unavailable');
}

function postJSON(port, path, body, headers = {}) {
  const data = JSON.stringify(body || {});
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

function getJSON(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path, headers }, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(buf || '{}'); } catch {}
        resolve({ status: res.statusCode, json });
      });
    }).on('error', reject);
  });
}

test('admin refusal-style set/get and metric increment', async (t) => {
  const { child, port } = startService();
  t.after(() => { try { child.kill('SIGINT'); } catch {} });
  await waitForUp(port);

  const agent = 'AG1';
  const hdrs = { authorization: 'Bearer adm' };

  const setRes = await postJSON(port, `/admin/refusal-style/${agent}`, { style: 'sarcastic' }, hdrs);
  assert.equal(setRes.status, 200);
  assert.equal(setRes.json.style, 'sarcastic');
  assert.equal(setRes.json.agent, agent);

  const getRes = await getJSON(port, `/admin/refusal-style/${agent}`, hdrs);
  assert.equal(getRes.status, 200);
  assert.equal(getRes.json.style, 'sarcastic');

  const metrics = await getJSON(port, '/metrics');
  assert.equal(metrics.status, 200);
  const hasCounter = Array.isArray(metrics.json?.counters) && metrics.json.counters.some((c) => c.name === 'refusal_style_set_total');
  assert.equal(hasCounter, true, 'expected refusal_style_set_total counter');
});
