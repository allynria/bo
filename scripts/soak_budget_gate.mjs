import http from 'node:http';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

function startService(env = {}) {
  const script = path.join(process.cwd(), 'scripts', 'service.js');
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  return child;
}

function fetchStatus(url) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    http.get(url, (res) => {
      res.resume();
      res.on('end', () => {
        const t1 = process.hrtime.bigint();
        const ms = Number(t1 - t0) / 1e6;
        resolve({ status: res.statusCode, ms });
      });
    }).on('error', reject);
  });
}

function fetchJson(url) {
  return new Promise((resolve) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch { resolve({ status: res.statusCode, body: null }); }
      });
    }).on('error', () => resolve({ status: 0, body: null }));
  });
}

async function main() {
  const port = Number(process.env.PORT || 3600);
  const durationMin = Number(process.env.DURATION_MIN || 60);
  const durationMs = Math.max(60_000, Math.floor(durationMin * 60_000));
  const base = String(process.env.BASE_URL || `http://localhost:${port}`);
  const pathTarget = String(process.env.PATH_TARGET || '/healthz');
  const targetQps = Number(process.env.TARGET_QPS || 2000);
  const concurrent = Number(process.env.CONCURRENCY || 256);
  const p99TargetMs = Number(process.env.RESPOND_P99_TARGET_MS || (process.platform === 'win32' ? 20 : 10));
  const baselineP99Ms = Number(process.env.BASELINE_P99_MS || 0);
  const allowedRegressionPct = Math.max(0, Number(process.env.ALLOWED_P99_REGRESSION_PCT || 10));
  const allowServiceSpawn = String(process.env.SPAWN_SERVICE || '1') === '1';

  const child = allowServiceSpawn ? startService({ NODE_ENV: 'production', LOG_JSON: '1', PORT: String(port), QUEUE_MAX: '0', ADMIN_TOKEN: String(process.env.ADMIN_TOKEN || 'ci'), NODE_OPTIONS: String(process.env.NODE_OPTIONS || '--max-old-space-size=256') }) : null;
  // Wait for readiness
  await new Promise((r) => setTimeout(r, 500));

  // Baseline memory
  const hz0 = await fetchJson(`${base}/healthz`);
  const baselineMb = Number(hz0?.body?.memory_mb || 0);
  // Capture initial heap snapshot if admin is enabled
  let snapStartPath = '';
  try {
    const token = String(process.env.ADMIN_TOKEN || 'ci');
    const s0 = await fetchJson(`${base}/heap/snapshot?token=${encodeURIComponent(token)}`);
    if (s0?.status === 200 && s0?.body?.file) snapStartPath = String(s0.body.file || '');
  } catch {}

  const latencies = [];
  const errors = { spikes: 0 };
  const end = Date.now() + durationMs;
  let sent = 0;
  let ok = 0;
  async function worker() {
    while (Date.now() < end) {
      sent++;
      const r = await fetchStatus(`${base}${pathTarget}`).catch(() => ({ status: 0, ms: 0 }));
      if (r.status > 0) {
        latencies.push(r.ms);
        ok++;
      } else {
        errors.spikes++;
      }
      // Pace loosely for approximate QPS
      if (targetQps > 0) {
        const perWorkerQps = targetQps / concurrent;
        const sleepMs = Math.max(0, Math.floor(1000 / Math.max(1, perWorkerQps)));
        if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));
      }
    }
  }
  await Promise.all(Array.from({ length: concurrent }, () => worker()));

  // Final metrics + health
  const hz1 = await fetchJson(`${base}/healthz`);
  const rssEndMb = Number(hz1?.body?.memory_mb || baselineMb);
  const metrics = await fetchJson(`${base}/metrics`).catch(() => ({ status: 0, body: { counters: [] } }));
  const counters = Array.isArray(metrics?.body?.counters) ? metrics.body.counters : [];
  const openCircuits = counters.filter((c) => c.name.includes('circuit') || c.labels?.reason === 'circuit_open').reduce((a, c) => a + Number(c.value || 0), 0);
  // Capture final heap snapshot if admin is enabled
  let snapEndPath = '';
  try {
    const token = String(process.env.ADMIN_TOKEN || 'ci');
    const s1 = await fetchJson(`${base}/heap/snapshot?token=${encodeURIComponent(token)}`);
    if (s1?.status === 200 && s1?.body?.file) snapEndPath = String(s1.body.file || '');
  } catch {}

  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.50)] || 0;
  const p90 = latencies[Math.floor(latencies.length * 0.90)] || 0;
  const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;
  // Optional approximate heap snapshot size diff (file size proxy)
  let heapStartBytes = 0, heapEndBytes = 0;
  try {
    if (snapStartPath) {
      const fs = await import('node:fs');
      heapStartBytes = fs.existsSync(snapStartPath) ? fs.statSync(snapStartPath).size : 0;
    }
    if (snapEndPath) {
      const fs = await import('node:fs');
      heapEndBytes = fs.existsSync(snapEndPath) ? fs.statSync(snapEndPath).size : 0;
    }
  } catch {}
  console.log(JSON.stringify({ durationMs, sent, ok, p50_ms: p50, p90_ms: p90, p99_ms: p99, baseline_mb: baselineMb, rss_end_mb: rssEndMb, open_circuits, error_spikes: errors.spikes, heap_start_bytes: heapStartBytes, heap_end_bytes: heapEndBytes }));

  // Budgets
  let fail = false; const reasons = [];
  if (p99 > p99TargetMs) { fail = true; reasons.push(`p99_ms>${p99TargetMs}`); }
  if (baselineP99Ms > 0) {
    const maxAllowed = baselineP99Ms * (1 + allowedRegressionPct / 100);
    if (p99 > maxAllowed) { fail = true; reasons.push(`p99_regression>${allowedRegressionPct}%`); }
  }
  const rssBudgetPct = Number(process.env.SOAK_RSS_BUDGET_PCT || 5);
  if (baselineMb > 0 && rssEndMb > Math.ceil(baselineMb * (1 + rssBudgetPct / 100))) { fail = true; reasons.push(`rss_growth>${rssBudgetPct}%`); }
  // Optional heap snapshot growth check via size proxy
  const retainedBudgetPct = Number(process.env.RETAINED_OBJECTS_BUDGET_PCT || rssBudgetPct);
  if (heapStartBytes > 0 && heapEndBytes > Math.ceil(heapStartBytes * (1 + retainedBudgetPct / 100))) { fail = true; reasons.push(`retained_objects_diff>${retainedBudgetPct}%`); }
  // Require no circuit openings
  if (openCircuits > 0) { fail = true; reasons.push('open_circuits>0'); }
  // require zero error spikes
  if (errors.spikes > 0) { fail = true; reasons.push('error_spikes>0'); }

  try { child?.kill?.('SIGTERM'); } catch {}
  if (fail) {
    console.error(`SOAK_BUDGET_FAIL: ${reasons.join(',')}`);
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error('soak_budget_gate_error', e && e.stack || e); process.exitCode = 1; });

