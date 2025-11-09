import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const PORT = 4721;
function onceReady() {
  return new Promise((resolve) => {
    const t = setInterval(() => {
      http.get({ host:'127.0.0.1', port:PORT, path:'/healthz' }, r => {
        if (r.statusCode === 200) { clearInterval(t); resolve(); }
      }).on('error', ()=>{});
    }, 100);
  });
}

async function getJSON(path) {
  return new Promise((resolve, reject) => {
    http.get({ host:'127.0.0.1', port:PORT, path }, (res) => {
      let s=''; res.on('data', d => s+=d); res.on('end', ()=>{ try { resolve(JSON.parse(s)); } catch(e){ reject(e); } });
    }).on('error', reject);
  });
}

async function postJSON(path, body, headers={}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host:'127.0.0.1', port:PORT, path, method:'POST',
      headers: { 'content-type':'application/json', origin: ' `http://ok.test` ', authorization:'Bearer t', ...headers }}, (res) => {
      let s=''; res.on('data', d => s+=d); res.on('end', ()=>{ try { resolve({ status:res.statusCode, json:JSON.parse(s) }); } catch(e){ reject(e); } });
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  const env = {
    ...process.env,
    NODE_ENV:'production',
    PORT:String(PORT),
    LLM_TEST_STUBS:'1',
    URGA_PROVIDER:'stub-urga',
    CONV_AUTH:'t',
    CORS_ALLOWLIST:'',
    MEMORY_ENABLED:'1',
    MEMORY_INJECT_BUDGET_TOKENS:'80',
  };
  const ps = spawn(process.execPath, ['scripts/service.js'], { env, stdio:'inherit' });
  await onceReady();

  // Warm memory store a bit
  const conv = 'conv-mem-apply';
  await getJSON('/memory/preview?conv_id='+conv+'&text=intro&model=o200k_base&token=t');

  // Message path
  const m = await postJSON('/v1/conv/message', { conv_id: conv, engine:'urga', text: 'We crossed the bridge again.', ts: Date.now() });
  assert.equal(m.status, 200);
  assert.equal(typeof m.json.memory_applied, 'boolean');
  assert.ok(m.json.memory_injected_tokens >= 0);

  // Stream start event flags
  await new Promise((resolve, reject) => {
    const req = http.request({
      host:'127.0.0.1', port:PORT,
      path:`/v1/conv/stream?conv_id=${encodeURIComponent(conv)}&turn=0&engine=urga&text=${encodeURIComponent('Testing stream memory')}&ts=${Date.now()}`,
      method:'GET', headers: { origin:' `http://ok.test` ', authorization:'Bearer t' }
    }, (res) => {
      let startLine = '';
      res.on('data', c => {
        const s = String(c);
        if (s.includes('event: start')) startLine = s;
        if (s.includes('event: end')) resolve();
      });
      res.on('end', resolve);
    });
    req.on('error', reject);
    req.end();
  });

  ps.kill('SIGINT'); await delay(50);
}
main().catch(e => { console.error(e); process.exit(1); });

