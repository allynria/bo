import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = process.env.PORT || '3311';
const BASE = `http://127.0.0.1:${PORT}`;

async function startService() {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT,
    LLM_TEST_STUBS: '1',
    URGA_PROVIDER: 'stub-urga',
    CONV_AUTH: 'test-token',
    CORS_ALLOWLIST: ' `http://ok.test` ',
  };
  const child = spawn(process.execPath, ['scripts/service.js'], { env, stdio:['ignore','pipe','pipe'] });
  await onceReady();
  return child;
}

function onceReady() {
  return new Promise((resolve) => {
    const t = setInterval(() => {
      http.get({ host:'127.0.0.1', port:Number(PORT), path:'/healthz' }, r => {
        if (r.statusCode === 200) { clearInterval(t); resolve(); }
      }).on('error', ()=>{});
    }, 100);
  });
}

function sse(path, headers={}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}${path}`, { method:'GET', headers }, (res) => {
      let buf = '';
      const out = [];
      res.on('data', (d) => {
        buf += d.toString('utf8');
        const parts = buf.split(/\n\n+/);
        buf = parts.pop();
        for (const p of parts) out.push(p);
        if (out.length > 3) resolve(out);
      });
      // Fallbacks to resolve even if event threshold isn't met
      res.on('end', () => { if (out.length > 0) resolve(out); });
      setTimeout(() => resolve(out), 3000);
    });
    req.on('error', reject);
    req.end();
  });
}

test('style.pref SSE appears (admin channel) and start contains style meta', async () => {
  const svc = await startService();
  try {
    // set style first
    await fetch(`${BASE}/admin/style`, {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body: JSON.stringify({ conv_id:'C2', preset:'snappy' })
    });
    const url = `/v1/conv/stream?conv_id=C2&turn=0&engine=urga&text=Try%20something%20fast.&ts=${Date.now()}`;
    const adminEvP = sse(`/admin/sse/style?conv_id=C2`);
    const convEvP = sse(url, { origin:' `http://ok.test` ', authorization:'Bearer test-token', accept:'text/event-stream' });
    const [adminEv, convEv] = await Promise.all([adminEvP, convEvP]);
    const hasPref = adminEv.some(e => e.startsWith('event: style.pref'));
    const startLineIdx = convEv.findIndex(e => e.startsWith('event: start'));
    assert.ok(hasPref, 'style.pref SSE missing on admin channel');
    assert.ok(startLineIdx >= 0, 'start missing');
    const startChunk = convEv[startLineIdx] || '';
    const dataLine = (startChunk.split('\n').find(l => l.startsWith('data:')) || '').replace(/^data:\s*/,'').trim();
    const payload = JSON.parse(dataLine);
    assert.equal(payload?.style?.preset, 'snappy');
    assert.ok(typeof payload?.style?.token_count === 'number');
  } finally {
    svc.kill('SIGINT');
  }
});
