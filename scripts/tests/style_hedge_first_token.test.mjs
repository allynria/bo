import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = process.env.PORT || '3327';
const BASE = `http://127.0.0.1:${PORT}`;

function onceReady() {
  return new Promise((resolve) => {
    const t = setInterval(() => {
      http
        .get({ host: '127.0.0.1', port: Number(PORT), path: '/healthz' }, (r) => {
          if (r.statusCode === 200) {
            clearInterval(t);
            resolve();
          }
        })
        .on('error', () => {});
    }, 100);
  });
}

async function startService() {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT,
    LLM_TEST_STUBS: '1',
    // Make primary slow-ish so hedge can win
    URGA_PROVIDER: 'stub-flaky',
    FLAKY_STALL_MS: '800',
    CONV_AUTH: 'test-token',
    CORS_ALLOWLIST: ' `http://ok.test` ',
    STYLE_BOOSTER_ENABLED: '1',
    STYLE_HEDGE_ENABLED: '1',
    STYLE_DEFAULT_PRESET: 'poetic',
    STYLE_HEDGE_SECOND_PRESET: 'terse',
    // Fire backup immediately
    LLM_HEDGE_FIRST_TOKEN_MS: '0',
  };
  const child = spawn(process.execPath, ['scripts/service.js'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await onceReady();
  return child;
}

function sse(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}${path}`, { method: 'GET', headers }, (res) => {
      let buf = '';
      const out = [];
      res.on('data', (d) => {
        buf += d.toString('utf8');
        const parts = buf.split(/\n\n+/);
        buf = parts.pop();
        for (const p of parts) out.push(p);
        if (out.length > 10) resolve(out);
      });
      // Prevent indefinite wait: resolve on end or after timeout
      res.on('end', () => { if (out.length > 0) resolve(out); });
      setTimeout(() => resolve(out), 3500);
    });
    req.on('error', reject);
    req.end();
  });
}

test('style hedge backup starts and can switch', async () => {
  const svc = await startService();
  try {
    const url = `/v1/conv/stream?conv_id=HEDGE1&turn=0&engine=urga&text=Test%20the%20alley.&ts=${Date.now()}`;
    const lines = await sse(url, {
      origin: ' `http://ok.test` ',
      authorization: 'Bearer test-token',
      accept: 'text/event-stream',
    });
    const hasPlan = lines.some((l) => l.startsWith('event: style.hedge.plan'));
    assert.ok(hasPlan, 'missing style.hedge.plan');
    const switched = lines.some((l) => l.startsWith('event: style.hedge.switch'));
    assert.ok(switched, 'backup did not win/switch');
  } finally {
    svc.kill('SIGINT');
  }
});
