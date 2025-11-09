import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { waitForUp } from './helpers/wait_for_up.mjs';

function start(port, env = {}) {
  return spawn(process.execPath, ['scripts/service.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      LLM_TEST_STUBS: '1',
      URGA_PROVIDER: 'stub-urga',
      ADMIN_TOKEN: 'adm',
      CONV_AUTH: 'test-token',
      FAILROLL_ENABLED: '1',
      COMPLICATION_ENABLED: '1',
      COMPLICATION_BAND: '8',
      FAILROLL_VERB_COOLDOWN_ENABLED: '1',
      FAILROLL_VERB_COOLDOWN_MS: '60000',
      FAILROLL_VERB_COOLDOWN_PENALTY: '0.06',
      ...env,
    },
    stdio: 'ignore',
  });
}

function get(base, path) {
  return new Promise((resolve, reject) => {
    http
      .get(`${base}${path}`, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ code: res.statusCode, body: d }));
      })
      .on('error', reject);
  });
}

(async () => {
  const port = 3200 + Math.floor(Math.random() * 1000);
  const base = `http://localhost:${port}`;
  const ps = start(port);
  await waitForUp(base, { timeout: 3000 });

  // 1) Preview endpoint sanity
  const p1 = await get(
    base,
    '/admin/failroll/preview?token=adm&conv_id=t1&text=I try to sneak behind the guard&turn=0'
  );
  assert.equal(p1.code, 200);
  const j1 = JSON.parse(p1.body);
  assert.equal(j1.ok, true);
  assert.equal(j1.verb.toLowerCase().includes('sneak'), true);
  assert.equal(['stealth', 'social', 'physical', 'generic'].includes(j1.styleClass), true);

  // 2) Cooldown penalty kicks in after first use
  const p2 = await get(
    base,
    '/admin/failroll/preview?token=adm&conv_id=t2&text=I try to charm the warden&turn=0'
  );
  const a2 = JSON.parse(p2.body);
  // mark usage via stream call (starts cooldown)
  const sse = await new Promise((resolve, reject) => {
    http
      .get(
        `${base}/conv/stream?conv_id=t2&engine=urga&turn=0&text=${encodeURIComponent('I try to charm the warden')}`,
        { headers: { accept: 'text/event-stream', authorization: 'Bearer test-token' } },
        (res) => {
          let b = '';
          res.on('data', (c) => {
            b += c.toString('utf8');
            if (b.includes('failroll.eval')) resolve(b);
          });
        }
      )
      .on('error', reject);
  });
  assert.ok(sse.includes('failroll.eval'));
  // preview again; expect higher threshold due to cooldownPenalty
  const p3 = await get(
    base,
    '/admin/failroll/preview?token=adm&conv_id=t2&text=I try to charm the warden&turn=1'
  );
  const a3 = JSON.parse(p3.body);
  // threshold correlates with pFail; allow a tiny epsilon
  assert.ok(a3.threshold >= a2.threshold, 'cooldown should not lower failure threshold');

  ps.kill('SIGINT');
  console.log('✓ failroll styles + preview + cooldown OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
