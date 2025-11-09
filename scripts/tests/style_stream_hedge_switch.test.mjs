import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = process.env.PORT || '3341';
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

async function start() {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT,
    LLM_TEST_STUBS: '1',
    // Primary is slow → triggers hedge
    URGA_PROVIDER: 'stub-flaky',
    FLAKY_STALL_MS: '1200',
    // Backup is fast
    HEDGE_STYLE_PROVIDER: 'stub-dreams',
    STYLE_HEDGE_ENABLED: '1',
    STYLE_HEDGE_FIRST_MS: '120',
    STYLE_HEDGE_MAX_MS: '2000',
    // auth & CORS
    CONV_AUTH: 'test-token',
    CORS_ALLOWLIST: ' `http://ok.test` ',
    // beats on (not required, but nice)
    BEATS_ENABLED: '1',
    ULTRA_DEFAULT_ON: '1',
  };
  const child = spawn(process.execPath, ['scripts/service.js'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await onceReady();
  return child;
}

function sse(path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}${path}`, { method: 'GET', headers }, (res) => {
      let buf = '';
      res.on('data', (d) => {
        buf += d.toString('utf8');
        if (buf.includes('event: style.hedge.switch')) resolve(buf);
      });
      setTimeout(() => resolve(buf), 3000);
    });
    req.on('error', reject);
    req.end();
  });
}

test('style hedge switches to backup on first token', async () => {
  const svc = await start();
  try {
    const q = encodeURIComponent('She waits—tense—then shouts: Go!');
    const url = `/v1/conv/stream?conv_id=HSTYLE1&turn=0&engine=urga&text=${q}&ts=${Date.now()}`;
    const buf = await sse(url, {
      origin: ' `http://ok.test` ',
      authorization: 'Bearer test-token',
      accept: 'text/event-stream',
    });
    // show-off events
    assert.ok(buf.includes('event: style.hedge.start'), 'should announce hedge start');
    assert.ok(buf.includes('event: style.hedge.switch'), 'should cut over to faster style stream');
  } finally {
    svc.kill('SIGINT');
  }
});
