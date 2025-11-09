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

async function main() {
  const port = Number(process.env.PORT || 3500);
  const durationMs = Number(process.env.DURATION_MS || 5000);
  const pathTarget = String(process.env.PATH_TARGET || '/healthz');
  const targetQps = Number(process.env.TARGET_QPS || 2000);
  const concurrent = Number(process.env.CONCURRENCY || 256);
  const child = startService({ NODE_ENV: 'production', LOG_JSON: '1', PORT: String(port), QUEUE_MAX: '0' });

  const base = `http://localhost:${port}`;
  // Wait a moment
  await new Promise((r) => setTimeout(r, 250));
  const latencies = [];
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

  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.50)] || 0;
  const p90 = latencies[Math.floor(latencies.length * 0.90)] || 0;
  const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;
  console.log(JSON.stringify({ durationMs, sent, ok, p50_ms: p50, p90_ms: p90, p99_ms: p99 }));

  try { child.kill('SIGTERM'); } catch {}
}

main().catch((e) => { console.error('perf_soak_error', e && e.stack || e); process.exitCode = 1; });

