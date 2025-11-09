import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

function start() {
  return spawn(process.execPath, ['scripts/service.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: '3822',
      LLM_TEST_STUBS: '1',
      URGA_PROVIDER: 'stub-urga',
      CONV_AUTH: 'test-token',
      ADMIN_TOKEN: 'adm',
      // Disable Ultra/cadence/phrase decay so stream d100FR seed matches raw text
      ULTRA_DEFAULT_ON: '0',
      CADENCE_ENABLED: '0',
      PHRASE_DECAY_ENABLED: '0',
      FAILROLL_ENABLED: '1',
      FAILROLL_RISK_REGEX: 'charm|convince|deceive|bluff|intimidate',
      // Stabilize threshold for deterministic near-miss search
      FAILROLL_TRUST_WEIGHT: '0',
      FAILROLL_SUSPICION_WEIGHT: '0',
      FAILROLL_TENSION_WEIGHT: '0',
      FAILROLL_BASE_CHANCE: '0.30',
      FAILROLL_VERB_COOLDOWN_ENABLED: '0',
      COMPLICATION_ENABLED: '1',
      COMPLICATION_BAND: '20',
      NEARMISS_PHRASE_COOLDOWN_ENABLED: '1',
      NEARMISS_PHRASE_COOLDOWN_MS: '60000',
      NEARMISS_PHRASE_COOLDOWN_PICK: '2'
    },
    stdio: 'ignore'
  });
}

function waitForUp(url, { timeout = 3000 } = {}) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      http.get(url, res => { res.resume(); resolve(); }).on('error', () => {
        if (Date.now() - start > timeout) return reject(new Error('service not up'));
        setTimeout(tick, 50);
      });
    };
    tick();
  });
}

function sse(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://localhost:3822${path}`, { headers: { accept: 'text/event-stream', authorization: 'Bearer test-token', 'cache-control': 'no-cache', connection: 'keep-alive' } }, res => {
      let buf = '';
      const chunksAgg = [];
      let resolved = false;
      res.on('data', c => {
        buf += c.toString('utf8');
        const chunks = buf.split(/\r?\n\r?\n/);
        buf = chunks.pop();
        for (const chunk of chunks) {
          chunksAgg.push(chunk);
          const evtLine = chunk.split(/\r?\n/).find(l => l.startsWith('event:')) || '';
          const evt = evtLine.replace(/^event:\s*/, '').trim();
          if (!resolved && evt === 'end') {
            resolved = true;
            const full = chunksAgg.concat(buf ? [buf] : []).join('\n\n');
            resolve(full);
            return;
          }
        }
      });
      res.on('end', () => { if (!resolved) resolve(chunksAgg.concat(buf ? [buf] : []).join('\n\n')); });
      res.on('error', (e) => { if (!resolved) reject(e); });
      setTimeout(() => { if (!resolved) resolve(chunksAgg.concat(buf ? [buf] : []).join('\n\n')); }, 4000);
    });
    req.on('error', (e) => { reject(e); });
  });
}

(async () => {
  const ps = start();
  await waitForUp('http://localhost:3822');
  const conv = 'nm-demo';
  // Start with '(' to prevent dream injection from mutating textInput
  const baseText = '(NM) I try to charm the warden';
  // Use preview to deterministically find a near-miss candidate, then stream it
  let candidate = '';
  for (let i = 0; i < 200; i++) {
    const text = `(NM ${i}) I try to charm the warden`;
    const prev = await new Promise((resolve, reject) => {
      http.get(`http://localhost:3822/admin/failroll/preview?token=adm&conv_id=${encodeURIComponent(conv)}&text=${encodeURIComponent(text)}&turn=0`, res => {
        let d=''; res.on('data', c => d += c); res.on('end', () => resolve({ code: res.statusCode, body: d }));
      }).on('error', reject);
    });
    if (prev.code === 200) {
      try {
        const js = JSON.parse(prev.body);
        if (js && js.nearMiss === true && js.fail === false) { candidate = text; break; }
      } catch {}
    }
  }
  assert.ok(candidate, 'failed to locate near-miss via preview');
  const idem = `nmseed-${Date.now()}`;
  const log = await sse(`/conv/stream?conv_id=${conv}&engine=urga&turn=0&idempotency_key=${encodeURIComponent(idem)}&agent=none&text=${encodeURIComponent(candidate)}&ts=${Date.now()}`);
  assert.ok(log.includes('event: loopguard.cooldown'), 'should emit cooldown event during stream');

  // Verify cooldown event payload fields and ordering
  const chunks = log.split(/\r?\n\r?\n/);
  const events = [];
  for (const chunk of chunks) {
    const lines = chunk.split(/\r?\n/);
    const evtLine = lines.find(l => l.startsWith('event:')) || '';
    const dataLine = lines.find(l => l.startsWith('data:')) || '';
    const evt = evtLine.replace(/^event:\s*/, '').trim();
    let payload = null;
    try { payload = JSON.parse(dataLine.replace(/^data:\s*/, '').trim()); } catch {}
    if (evt) events.push({ evt, payload });
  }
  const idxEnd = events.findIndex(e => e.evt === 'end');
  const idxCool = events.findIndex(e => e.evt === 'loopguard.cooldown' && e.payload && Array.isArray(e.payload.phrases));
  assert.ok(idxCool >= 0, 'should include cooldown synergy with phrases');
  assert.ok(idxEnd === -1 || idxCool < idxEnd, 'cooldown synergy should occur before end');
  const p = events[idxCool].payload;
  assert.equal(p.conv_id, conv, 'conv_id should match conversation');
  assert.ok(Array.isArray(p.phrases) && p.phrases.length === 2, 'should cool two phrases');
  assert.ok(typeof p.style === 'string' && p.style.length > 0, 'style should be present');
  assert.ok(Number(p.ttl_ms) >= 1000, 'ttl_ms should be a positive number');

  // Optional: if cooldown.hit is present, validate conv_id field
  const idxHit = events.findIndex(e => e.evt === 'loopguard.cooldown.hit');
  if (idxHit >= 0) {
    assert.equal(events[idxHit].payload.conv_id, conv, 'cooldown.hit conv_id should match conversation');
  }

  // call preview again to ensure endpoint still works (sanity)
  const prev = await new Promise((resolve, reject) => {
    http.get('http://localhost:3822/admin/failroll/preview?token=adm&conv_id=nm-demo&text=I try to charm the warden&turn=1', res => {
      let d=''; res.on('data', c => d += c); res.on('end', () => resolve({ code: res.statusCode, body: d }));
    }).on('error', reject);
  });
  assert.equal(prev.code, 200);

  ps.kill('SIGINT');
  console.log('✓ near-miss cooldown synergy smoke test OK');
})().catch(e => { console.error(e); process.exit(1); });
