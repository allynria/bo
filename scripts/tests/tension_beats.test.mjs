import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

// Simple integration: start service in prod-ish mode with stubs, then
// call /v1/conv/stream and verify memory.tension + memory.beat SSE events appear.

const PORT = process.env.PORT || '3309';
const BASE = `http://127.0.0.1:${PORT}`;

async function startService() {
  const { spawn } = await import('node:child_process');
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT,
    LLM_TEST_STUBS: '1',
    URGA_PROVIDER: 'stub-urga',
    CONV_AUTH: 'test-token',
    CORS_ALLOWLIST: ' `http://ok.test` ',
    TENSION_ENABLED: '1',
  };
  const child = spawn(process.execPath, ['scripts/service.js'], { env, stdio: ['ignore','pipe','pipe'] });
  await new Promise((r)=>setTimeout(r, 600)); // small boot wait
  return child;
}

async function sse(url, headers={}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method:'GET', headers }, (res) => {
      let buf = '';
      const out = [];
      res.on('data', (d)=> {
        buf += d.toString('utf8');
        const parts = buf.split(/\n\n+/);
        buf = parts.pop();
        for (const p of parts) out.push(p);
        if (out.length > 3) resolve(out);
      });
      // Fallbacks to avoid hanging indefinitely
      res.on('end', () => { if (out.length > 0) resolve(out); });
      setTimeout(() => resolve(out), 3000);
    });
    req.on('error', reject);
    req.end();
  });
}

test('tension & beat events appear and start payload carries them', async () => {
  const svc = await startService();
  try {
    // stream with auth + ts + origin
    const url = `${BASE}/v1/conv/stream?conv_id=T1&turn=0&engine=urga&text=` +
      encodeURIComponent('She shouts: Leave me alone! Blood on the steps...') +
      `&ts=${Date.now()}`;
    const events = await sse(url, { origin:' `http://ok.test` ', authorization:'Bearer test-token', accept:'text/event-stream' });
    const hasTension = events.some(e => e.startsWith('event: memory.tension'));
    const hasBeat = events.some(e => e.startsWith('event: memory.beat'));
    assert.ok(hasTension, 'memory.tension SSE missing');
    assert.ok(hasBeat, 'memory.beat SSE missing');
    const startChunk = events.find(e=> e.startsWith('event: start'));
    assert.ok(startChunk, 'start missing');
    const dataLine = (startChunk.split(/\n/).find(l => l.startsWith('data:')) || '').replace(/^data:\s*/,'').trim();
    const payload = JSON.parse(dataLine);
    assert.ok(typeof payload.tension === 'number', 'start.tension missing');
    assert.ok(['rising','high','falling','lull'].includes(payload.beat), 'start.beat invalid');
  } finally {
    svc.kill('SIGINT');
  }
});
