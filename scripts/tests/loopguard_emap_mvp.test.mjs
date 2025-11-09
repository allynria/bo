import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

function startService(env = {}) {
  return spawn('node', ['scripts/service.js'], {
    env: { ...process.env,
      PORT:'3457',
      NODE_ENV:'production',
      LLM_TEST_STUBS:'1',
      URGA_PROVIDER:'stub-urga',
      CONV_AUTH:'t',
      CORS_ALLOWLIST:'http://ok.test',
      REPLAY_WINDOW_MS:'5000',
      // Enable EMAP reroll logic
      LOOP_EMBED_ENABLED:'1',
      LOOP_EMBED_HISTORY_N:'5',
      LOOP_EMBED_SIM_MAX:'0.1', // low to force trigger under stubs
      LOOP_EMBED_MIN_LEN:'1',   // allow short stub replies
      // Disable delta-sim reroll to isolate EMAP in this test
      LOOP_GUARD_ENABLED:'0',
      ...env
    },
    stdio: 'inherit'
  });
}

async function postJSON(port, path, body, headers = {}) {
  const data = JSON.stringify(body);
  const opts = { hostname:'127.0.0.1', port, path, method:'POST',
    headers: { 'content-type':'application/json', 'content-length': Buffer.byteLength(data), ...headers } };
  return new Promise((resolve,reject)=>{
    const req = http.request(opts, res=>{
      let buf=''; res.on('data',d=>buf+=d); res.on('end',()=>resolve({status:res.statusCode, json: JSON.parse(buf||'{}')})); });
    req.on('error', reject); req.write(data); req.end();
  });
}

async function getMetrics(port) {
  return new Promise((resolve,reject)=>{
    http.get(`http://127.0.0.1:${port}/metrics`, res=>{
      let buf=''; res.on('data',d=>buf+=d); res.on('end',()=>resolve(JSON.parse(buf||'{"counters":[]}'))); }).on('error', reject);
  });
}

(async () => {
  const port = 3457;
  const proc = startService();
  // wait for readiness via /healthz
  async function waitForReady(maxMs = 2500) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const ok = await new Promise((resolve) => {
        try {
          http.get(`http://127.0.0.1:${port}/healthz`, res => { resolve(res.statusCode === 200); }).on('error', () => resolve(false));
        } catch { resolve(false); }
      });
      if (ok) return;
      await new Promise(r=>setTimeout(r, 100));
    }
    throw new Error('service not ready in time');
  }
  await waitForReady();
  const conv = 'emap-test-1';
  const a = await postJSON(port, '/v1/conv/message', { conv_id: conv, text: 'She smiles softly and nods.', ts: Date.now() }, { origin: 'http://ok.test', authorization: 'Bearer t' });
  assert.equal(a.status, 200);
  const b = await postJSON(port, '/v1/conv/message', { conv_id: conv, text: 'She smiles softly and nods again.', ts: Date.now() }, { origin: 'http://ok.test', authorization: 'Bearer t' });
  assert.equal(b.status, 200);
  const m = await getMetrics(port);
  const hit = (m.counters||[]).some(c => c.name === 'loopguard_emap_trigger_total' && c.labels?.path === 'message');
  assert.equal(hit, true, 'expected loopguard_emap_trigger_total metric');
  proc.kill('SIGINT');
  console.log('OK loopguard emap mvp');
})();

