import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import { waitForUp } from './helpers/wait_for_up.mjs';

function startService(env = {}) {
  const child = spawn(process.execPath, ['scripts/service.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: '3809',
      LLM_TEST_STUBS: '1',
      URGA_PROVIDER: 'stub-urga',
      CONV_AUTH: 'test-token',
      CORS_ALLOWLIST: 'http://ok.test',
      FAILROLL_ENABLED: '1',
      COMPLICATION_ENABLED: '1',
      COMPLICATION_BAND: '12',
      BEAT_DELTA_SUCCESS_FALLING: '-0.08',
      BEAT_DELTA_FAIL_RISING: '0.09',
      CONV_SOFT_MAX: '5000',
      CONV_SOFT_WINDOW_MS: '2000',
      SSE_HEARTBEAT_MS: '500',
      ...env,
    },
    stdio: 'ignore'
  });
  return child;
}

function sse(url, idemKey) {
  return new Promise((resolve, reject) => {
    const headers = { accept: 'text/event-stream', authorization: 'Bearer test-token', origin: 'http://ok.test' };
    if (idemKey) headers['x-idempotency-key'] = idemKey;
    http.get(url, { headers }, res => {
      let buf = '';
      res.on('data', d => { buf += d.toString('utf8'); });
      // Resolve when stream ends or after timeout
      res.on('end', () => resolve(buf));
      setTimeout(() => resolve(buf), 3000);
      res.on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  // Stabilize base chance and weights for predictable threshold (near-miss search loop)
  const convId = 'comp-test';
  const turn = 0;
  const baseText = 'I try to sneak past the guards quietly';

  const ps = startService({
    FAILROLL_TRUST_WEIGHT: '0',
    FAILROLL_SUSPICION_WEIGHT: '0',
    FAILROLL_TENSION_WEIGHT: '0',
    FAILROLL_BASE_CHANCE: '0.30',
    FAILROLL_VERB_COOLDOWN_ENABLED: '0'
  });
  await waitForUp('http://localhost:3809', { timeout: 3000 });

  // Try multiple text variants to deterministically hit a near-miss
  let near = null;
  for (let i = 0; i < 40; i++) {
    const text = `${baseText}${' '.repeat(i)}`;
    const idem = `${convId}:${turn}:${Date.now()}:${i}`;
    const url = `http://localhost:3809/conv/stream?conv_id=${convId}&engine=urga&turn=${turn}&text=${encodeURIComponent(text)}&ts=${Date.now()}`;
    const body = await sse(url, idem);
    if (!/event: failroll\.eval/.test(body)) continue;
    const m = body.match(/event: failroll\.eval[\s\S]*?data:\s*(\{[\s\S]*?\})/);
    if (!m || !m[1]) continue;
    const payload = JSON.parse(m[1]);
    // Stop when success with near-miss is observed
    if (payload && payload.outcome && /success/.test(String(payload.outcome)) && payload.nearMiss === true) {
      near = payload;
      break;
    }
  }

  assert.ok(near, 'expected a nearMiss success within 60 attempts');
  // Optional: check we emitted a tension delta
  assert.ok(typeof near.tensionAfter !== 'undefined', 'tensionAfter present');

  // Hit /metrics to confirm counters
  const metrics = await new Promise((resolve, reject) => {
    http.get('http://localhost:3809/metrics', res => {
      let data=''; res.on('data', c => data += c); res.on('end', () => resolve(data));
    }).on('error', reject);
  });

  assert.match(metrics, /failroll_evaluations_total/);
  assert.match(metrics, /failroll_complications_total/);
  assert.match(metrics, /failroll_tension_adjust_total/);

  try { ps.kill('SIGINT'); } catch {}
  console.log('✓ failroll complication + beat rewards OK');
})().catch(e => { console.error(e); process.exit(1); });
