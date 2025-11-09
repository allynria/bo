import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = process.env.PORT || '3343';
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
    ULTRA_DEFAULT_ON: '1',
    STYLE_CADENCE_ENABLED: '1',
    BEATS_ENABLED: '1',
  };
  const child = spawn(process.execPath, ['scripts/service.js'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((r) => setTimeout(r, 600));
  return child;
}

test('cadence planner emits SSE with style rotation', async () => {
  const svc = await start();
  try {
    const url = `${BASE}/v1/conv/stream?conv_id=CAD1&turn=0&engine=urga&text=${encodeURIComponent('Tension rises as footsteps echo.')}&ts=${Date.now()}`;
    const buf = await new Promise((resolve, reject) => {
      const req = http.request(
        url,
        {
          method: 'GET',
          headers: {
            origin: ' `http://ok.test` ',
            authorization: 'Bearer test-token',
            accept: 'text/event-stream',
          },
        },
        (res) => {
          let acc = '';
          res.on('data', (d) => {
            acc += d.toString('utf8');
            if (acc.includes('event: cadence.plan')) resolve(acc);
          });
          setTimeout(() => resolve(acc), 3000);
        }
      );
      req.on('error', reject);
      req.end();
    });
    assert.ok(buf.includes('event: cadence.plan'), 'should announce cadence plan');
  } finally {
    svc.kill('SIGINT');
  }
});
