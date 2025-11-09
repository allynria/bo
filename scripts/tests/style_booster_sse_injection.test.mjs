import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = process.env.PORT || '3313';
const BASE = `http://127.0.0.1:${PORT}`;

function onceReady() {
  return new Promise((resolve) => {
    const t = setInterval(() => {
      http.get({ host:'127.0.0.1', port:Number(PORT), path:'/healthz' }, r => {
        if (r.statusCode === 200) { clearInterval(t); resolve(); }
      }).on('error', ()=>{});
    }, 100);
  });
}

async function startService() {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT,
    LLM_TEST_STUBS: '1',
    URGA_PROVIDER: 'stub-urga',
    CONV_AUTH: 'test-token',
    CORS_ALLOWLIST: ' `http://ok.test` ',
    STYLE_BOOSTER_ENABLED: '1',
    STYLE_DEFAULT_PRESET: 'noir',
  };
  const child = spawn(process.execPath, ['scripts/service.js'], { env, stdio:['ignore','pipe','pipe'] });
  await onceReady();
  return child;
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
        if (out.length > 4) resolve(out);
      });
      // Fallbacks to ensure completion
      res.on('end', () => { if (out.length > 0) resolve(out); });
      setTimeout(() => resolve(out), 3000);
    });
    req.on('error', reject);
    req.end();
  });
}

test('style booster event is emitted with compact text', async () => {
  const svc = await startService();
  try {
    // ensure preset is set (optional; default handled)
    await fetch(`${BASE}/admin/style`, {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body: JSON.stringify({ conv_id:'CB', preset:'noir' })
    });
    const url = `/v1/conv/stream?conv_id=CB&turn=0&engine=urga&text=We%20enter%20the%20alley.&ts=${Date.now()}`;
    const events = await sse(url, { origin:' `http://ok.test` ', authorization:'Bearer test-token', accept:'text/event-stream' });
    const boosterLine = events.find(e => e.startsWith('event: memory.style.booster'));
    assert.ok(boosterLine, 'missing memory.style.booster');
    const dataLine = (boosterLine.split('\n').find(l => l.startsWith('data:')) || '').replace(/^data:\s*/, '').trim();
    const payload = JSON.parse(dataLine);
    assert.equal(payload.preset, 'noir');
    assert.ok(payload.text?.length > 8, 'booster text too short');
    assert.ok(payload.estTokens <= (payload.tokenBudget || 40), 'booster exceeds budget');
  } finally {
    svc.kill('SIGINT');
  }
});
