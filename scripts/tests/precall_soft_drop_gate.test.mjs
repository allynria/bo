import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { waitForUp } from './helpers/wait_for_up.mjs';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

function startService(env = {}) {
  const script = path.join(process.cwd(), 'scripts', 'service.js');
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d.toString(); });
  child.stderr.on('data', (d) => { logs += d.toString(); });
  return { child, getLogs: () => logs };
}

function fetchJson(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + (u.search || ''), headers }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d.toString(); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(data || '{}') }); }
        catch (e) { resolve({ status: res.statusCode, headers: res.headers, json: {} }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('Pre-call soft-drop gate triggers under CPU override and recovers', async () => {
  const port = 4620 + Math.floor(Math.random() * 200);
  const env = { PORT: String(port), QUEUE_MAX: '0', LLM_TURN_BUDGET: '5', LLM_TEST_STUBS: '1', URGA_PROVIDER: 'stub-urga', CPU_SOFT_DROP_FORCE: '1', PRECALL_SHED_JITTER_MS: '300' };
  const { child } = startService(env);
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 5000 });

  const conv_id = 'softdrop-cpu-1';
  const body = JSON.stringify({ text: 'probe text', conv_id, turn: 0, engine: 'urga' });
  const res1 = await fetchJson(`${base}/conv/message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  console.log('CPU soft-drop message status=', res1.status, 'headers.retry-after=', res1.headers?.['retry-after'], 'json=', res1.json);
  assert.equal(res1.status, 503, 'soft-drop should 503 message path');
  assert.ok(res1.headers?.['retry-after'], 'Retry-After header should be present');
  assert.equal(res1.json?.error, 'soft_drop');
  assert.equal(res1.json?.reason, 'cpu');

  const u = `${base}/conv/stream?conv_id=${encodeURIComponent('softdrop-cpu-2')}&turn=0&engine=urga&text=${encodeURIComponent('probe stream')}`;
  const res2 = await fetchJson(u);
  console.log('CPU soft-drop stream status=', res2.status, 'json=', res2.json);
  assert.equal(res2.status, 503, 'soft-drop should 503 stream path');
  assert.equal(res2.json?.error, 'soft_drop');
  assert.equal(res2.json?.reason, 'cpu');

  const metrics1 = await fetchJson(`${base}/metrics`).catch(() => ({ status: 0, json: {} }));
  console.log('CPU soft-drop metrics status=', metrics1.status, 'counters len=', Array.isArray(metrics1.json?.counters) ? metrics1.json.counters.length : 0);
  assert.equal(metrics1.status, 200);
  const cs1 = Array.isArray(metrics1.json?.counters) ? metrics1.json.counters : [];
  console.log('CPU soft-drop counters:', cs1);
  assert.ok(!!cs1.find((c) => c.name === 'precall_soft_drop_total' && String(c.labels?.reason) === 'cpu'), 'precall_soft_drop_total counter seen for cpu');
  assert.ok(!!cs1.find((c) => c.name === 'host_cpu_pct'), 'host_cpu_pct gauge present');
  assert.ok(!!cs1.find((c) => c.name === 'host_rss_mb'), 'host_rss_mb gauge present');

  try { child.kill('SIGTERM'); } catch {}
  await new Promise((r) => child.on('exit', r));

  // Recovery phase: restart without overrides and observe successful responses and reasonable P99
  const port2 = port + 1;
  const env2 = { PORT: String(port2), QUEUE_MAX: '0', LLM_TURN_BUDGET: '5', LLM_TEST_STUBS: '1', URGA_PROVIDER: 'stub-urga', CPU_SOFT_DROP_FORCE: '0' };
  const { child: child2, getLogs: getLogs2 } = startService(env2);
  const base2 = `http://localhost:${port2}`;
  try { await waitForUp(base2, { timeout: 5000 }); console.log('CPU recovery: service up at', base2); }
  catch (e) { console.log('CPU recovery: service failed to start. Logs=', getLogs2()); throw e; }

  const durations = [];
  for (let i = 0; i < 20; i++) {
    const t0 = Date.now();
    const r = await fetchJson(`${base2}/conv/message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `probe ${i}`, conv_id: `softdrop-cpu-recover-${i}`, turn: 0, engine: 'urga' }) });
    const dt = Date.now() - t0;
    durations.push(dt);
    assert.equal(r.status, 200, 'post-recovery message should succeed');
  }
  const sorted = durations.slice().sort((a, b) => a - b);
  const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))];
  console.log('CPU recovery durations(ms)=', durations, 'p99=', p99);
  assert.ok(p99 < 5000, `P99 should be under 5000ms, got ${p99}ms`);

  try { child2.kill('SIGTERM'); } catch {}
  await new Promise((r) => child2.on('exit', r));
});

test('Pre-call soft-drop gate triggers under RSS override', async () => {
  const port = 4680 + Math.floor(Math.random() * 200);
  const env = { PORT: String(port), QUEUE_MAX: '0', LLM_TURN_BUDGET: '5', LLM_TEST_STUBS: '1', URGA_PROVIDER: 'stub-urga', RSS_SOFT_DROP_FORCE: '1', PRECALL_SHED_JITTER_MS: '300' };
  const { child } = startService(env);
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 5000 });

  const body = JSON.stringify({ text: 'probe text', conv_id: 'softdrop-rss-1', turn: 0, engine: 'urga' });
  const res = await fetchJson(`${base}/conv/message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  assert.equal(res.status, 503, 'soft-drop should 503 message path');
  assert.ok(res.headers?.['retry-after'], 'Retry-After header should be present');
  assert.equal(res.json?.error, 'soft_drop');
  assert.equal(res.json?.reason, 'rss');

  const metrics = await fetchJson(`${base}/metrics`).catch(() => ({ status: 0, json: {} }));
  assert.equal(metrics.status, 200);
  const cs = Array.isArray(metrics.json?.counters) ? metrics.json.counters : [];
  assert.ok(!!cs.find((c) => c.name === 'precall_soft_drop_total' && c.labels?.reason === 'rss'), 'precall_soft_drop_total counter seen for rss');

  try { child.kill('SIGTERM'); } catch {}
  await new Promise((r) => child.on('exit', r));
});
