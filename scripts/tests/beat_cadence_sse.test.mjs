import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = process.env.PORT || '3331';
const BASE = `http://127.0.0.1:${PORT}`;

async function start() {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT,
    LLM_TEST_STUBS: '1',
    URGA_PROVIDER: 'stub-urga',
    CONV_AUTH: 'test-token',
    CORS_ALLOWLIST: ' `http://ok.test` ',
    BEATS_ENABLED: '1',
    BEATS_SMOOTH_ALPHA: '0.8',
    BEATS_RISING_THRESHOLD: '0.2',
    BEATS_PEAK_THRESHOLD: '0.5',
    BEATS_FALLING_THRESHOLD: '0.15',
  };
  const child = spawn(process.execPath, ['scripts/service.js'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((r) => setTimeout(r, 700));
  return child;
}

function sseCollect(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}${path}`, { method: 'GET', headers }, (res) => {
      let buf = '';
      res.on('data', (d) => {
        buf += d.toString('utf8');
        if (buf.includes('event: beat.tick') && buf.includes('event: cadence.plan')) {
          resolve(buf);
        }
      });
      setTimeout(() => resolve(buf), 2500);
    });
    req.on('error', reject);
    req.end();
  });
}

test('emits beat.tick and cadence.plan', async () => {
  const svc = await start();
  try {
    const q = encodeURIComponent('She gasps—heart pounding—"Run!"');
    const url = `/v1/conv/stream?conv_id=BEAT1&turn=0&engine=urga&text=${q}&ts=${Date.now()}`;
    const buf = await sseCollect(url, {
      origin: ' `http://ok.test` ',
      authorization: 'Bearer test-token',
      accept: 'text/event-stream',
    });
    assert.ok(buf.includes('event: beat.tick'), 'expected beat.tick');
    assert.ok(buf.includes('event: cadence.plan'), 'expected cadence.plan');
  } finally {
    svc.kill('SIGINT');
  }
});
