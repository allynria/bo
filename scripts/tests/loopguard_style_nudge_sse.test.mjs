import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

function startService(env = {}) {
  const PORT = 4485 + Math.floor(Math.random() * 200);
  const child = spawn(process.execPath, ['scripts/service.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(PORT),
      LLM_TEST_STUBS: '1',
      URGA_PROVIDER: 'stub-urga',
      CONV_AUTH: 't',
      CORS_ALLOWLIST: 'http://ok.test',
      LOOP_GUARD_ENABLED: '1',
      // Leave ULTRA_DEFAULT_ON at default '1' so expanded palette applies
      ...env,
    },
    stdio: 'ignore',
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

function sse(port, path, headers = {}) {
  const opts = { hostname: '127.0.0.1', port, path, method: 'GET', headers };
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      let buf = '';
      const events = [];
      res.on('data', (d) => {
        buf += d.toString('utf8');
        const parts = buf.split(/\n\n+/);
        buf = parts.pop();
        for (const p of parts) events.push(p);
        if (events.some((e) => e.startsWith('event: memory.loopguard_style'))) {
          resolve(events);
        }
      });
      // Fallbacks to ensure the promise resolves even if event does not appear
      res.on('end', () => { if (events.length > 0) resolve(events); });
      setTimeout(() => resolve(events), 3500);
    });
    req.on('error', reject);
    req.end();
  });
}

function getJSON(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path }, (res) => {
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

test('LoopGuard style nudge emits SSE and increments metric', async (t) => {
  const { child, port } = startService();
  t.after(() => { try { child.kill('SIGINT'); } catch {} });
  await waitForUp(port);

  const url = `/v1/conv/stream?conv_id=LGSTYLE1&turn=0&engine=urga&text=${encodeURIComponent('We walk into the crypt quietly.')}&ts=${Date.now()}`;
  const events = await sse(port, url, { origin: 'http://ok.test', authorization: 'Bearer t', accept: 'text/event-stream' });
  const styleEvt = events.find((e) => e.startsWith('event: memory.loopguard_style'));
  assert.ok(styleEvt, 'memory.loopguard_style event missing');
  const dataLine = (styleEvt.split('\n').find((l) => l.startsWith('data:')) || '').replace(/^data:\s*/, '').trim();
  const payload = JSON.parse(dataLine || '{}');
  assert.ok(typeof payload.token === 'string' && payload.token.length > 0, 'style token missing');

  const metrics = await getJSON(port, '/metrics');
  assert.equal(metrics.status, 200);
  const hit = Array.isArray(metrics.json?.counters) && metrics.json.counters.some((c) => c.name === 'loopguard_style_nudge_total' && c.labels?.path === 'stream');
  assert.equal(hit, true, 'expected loopguard_style_nudge_total metric with path=stream');
});
