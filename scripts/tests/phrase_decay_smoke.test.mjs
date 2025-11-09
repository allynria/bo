import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { waitForUp } from './helpers/wait_for_up.mjs';

function startService(env = {}) {
  return spawn('node', ['scripts/service.js'], {
    env: { ...process.env,
      PORT:'3491', NODE_ENV:'production',
      LLM_TEST_STUBS:'1', URGA_PROVIDER:'stub-urga',
      CONV_AUTH:'t',
      PHRASE_DECAY_ENABLED:'1',
      PHRASE_LIST:'she smiles softly;you notice',
      PHRASE_MAX_SCORE:'2.0',
    }, stdio: 'inherit'
  });
}
async function postJSON(port, path, body) {
  const data = JSON.stringify(body);
  const opts = { hostname:'127.0.0.1', port, path, method:'POST',
    headers:{ 'content-type':'application/json','content-length':Buffer.byteLength(data), 'authorization':'Bearer t' } };
  return new Promise((resolve,reject)=>{
    const req = http.request(opts, res=>{
      let buf=''; res.on('data',d=>buf+=d); res.on('end',()=>resolve({status:res.statusCode, json: JSON.parse(buf||'{}')})); });
    req.on('error', reject); req.write(data); req.end();
  });
}
(async ()=>{
  const proc = startService();
  const port = 3491, conv='pdecay';
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 4000 });
  await postJSON(port, '/v1/conv/message', { conv_id: conv, text: 'she smiles softly.' });
  await postJSON(port, '/v1/conv/message', { conv_id: conv, text: 'she smiles softly again.' });
  const r = await postJSON(port, '/v1/conv/message', { conv_id: conv, text: 'repeat the vibe' });
  assert.equal(r.status, 200);
  // we can’t assert the exact text, but we at least executed; metrics visible in /metrics if needed
  try { proc.kill('SIGINT'); } catch {}
  console.log('OK phrase decay smoke');
})();
