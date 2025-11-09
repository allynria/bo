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

function waitForUp(base, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const end = Date.now() + Math.max(1000, timeoutMs);
    const tryOnce = () => {
      const u = new URL(base);
      const req = http.get({ hostname: u.hostname, port: u.port, path: '/healthz' }, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve(true);
        if (Date.now() < end) setTimeout(tryOnce, 100);
        else resolve(false);
      });
      req.on('error', () => { if (Date.now() < end) setTimeout(tryOnce, 100); else resolve(false); });
    };
    tryOnce();
  });
}

function fetchSSEFirstToken(url, headers = {}) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const u = new URL(url);
    const req = http.request({ method: 'GET', hostname: u.hostname, port: u.port, path: u.pathname + (u.search || ''), headers }, (res) => {
      let buf = '';
      let firstMs = -1;
      let hedgeSwitched = false;
      let startPayload = null;
      res.on('data', (d) => {
        buf += d.toString();
        const chunks = buf.split('\n\n');
        buf = chunks.pop();
        for (const chunk of chunks) {
          const lines = chunk.split('\n');
          const typeLine = lines.find((l) => l.startsWith('event: ')) || '';
          const dataLine = lines.find((l) => l.startsWith('data: ')) || '';
          const evt = typeLine.replace('event: ', '').trim();
          const dataStr = dataLine.replace('data: ', '').trim();
          if (evt === 'start') {
            try { startPayload = JSON.parse(dataStr); } catch {}
          } else if (evt === 'delta') {
            if (firstMs < 0) {
              const t1 = process.hrtime.bigint();
              firstMs = Number(t1 - t0) / 1e6;
            }
          } else if (evt === 'hedge.switch') {
            hedgeSwitched = true;
          } else if (evt === 'end') {
            const ok = res.statusCode === 200 && firstMs >= 0;
            return resolve({ status: res.statusCode, ok, first_ms: firstMs, start: startPayload, hedge_switched: hedgeSwitched });
          }
        }
      });
      res.on('end', () => {
        const ok = res.statusCode === 200 && firstMs >= 0;
        resolve({ status: res.statusCode, ok, first_ms: firstMs, start: startPayload, hedge_switched: hedgeSwitched });
      });
    });
    req.on('error', () => resolve({ status: 0, ok: false, first_ms: -1, start: null, hedge_switched: false }));
    req.end();
  });
}

async function main() {
  const port = Number(process.env.PORT || 3600);
  const durationMin = Number(process.env.DURATION_MIN || 30);
  const durationMs = Math.max(60_000, Math.floor(durationMin * 60_000));
  const base = String(process.env.BASE_URL || `http://localhost:${port}`);
  const targetQps = Number(process.env.TARGET_QPS || 200);
  const concurrent = Number(process.env.CONCURRENCY || 64);
  const p99TargetMs = Number(process.env.FIRST_TOKEN_P99_TARGET_MS || 700);
  const allowServiceSpawn = String(process.env.SPAWN_SERVICE || '1') === '1';
  const hedgeMs = Math.max(100, Number(process.env.LLM_HEDGE_FIRST_TOKEN_MS || 500));
  const stallMs = Math.max(200, Number(process.env.FLAKY_STALL_MS || 1500));

  const child = allowServiceSpawn ? startService({
    NODE_ENV: 'production', LOG_JSON: '1', PORT: String(port), QUEUE_MAX: '0', LLM_TEST_STUBS: '1',
    DREAMS_PROVIDER: 'stub-flaky', URGA_PROVIDER: 'stub-dreams', ECHO_PROVIDER: 'stub-dreams',
    LLM_HEDGE_FIRST_TOKEN_MS: String(hedgeMs), FLAKY_STALL_MS: String(stallMs),
    NODE_OPTIONS: String(process.env.NODE_OPTIONS || '--max-old-space-size=256')
  }) : null;
  await waitForUp(base, { timeoutMs: 5000 });

  const latencies = [];
  let hedgeSwitches = 0;
  let sent = 0;
  let ok = 0;
  const endAt = Date.now() + durationMs;

  async function worker(id) {
    while (Date.now() < endAt) {
      const convId = `soak-${id}-${Date.now()}`;
      const url = `${base}/conv/stream?engine=dreams&text=${encodeURIComponent('lucid visions')}&&conv_id=${encodeURIComponent(convId)}&turn=1`;
      const r = await fetchSSEFirstToken(url).catch(() => ({ status: 0, ok: false, first_ms: -1, hedge_switched: false }));
      sent++;
      if (r.ok && r.first_ms >= 0) {
        latencies.push(r.first_ms);
        ok++;
        if (r.hedge_switched || (r.start && r.start.hedge_triggered)) hedgeSwitches++;
      }
      if (targetQps > 0) {
        const perWorkerQps = targetQps / concurrent;
        const sleepMs = Math.max(0, Math.floor(1000 / Math.max(1, perWorkerQps)));
        if (sleepMs > 0) await new Promise((r2) => setTimeout(r2, sleepMs));
      }
    }
  }

  await Promise.all(Array.from({ length: concurrent }, (_, i) => worker(i)));

  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.50)] || 0;
  const p90 = latencies[Math.floor(latencies.length * 0.90)] || 0;
  const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;
  const hedgeRate = ok > 0 ? (hedgeSwitches / ok) : 0;

  console.log(JSON.stringify({ duration_ms: durationMs, sent, ok, p50_first_ms: p50, p90_first_ms: p90, p99_first_ms: p99, hedge_switches: hedgeSwitches, hedge_rate: Number(hedgeRate.toFixed(4)), hedge_ms: hedgeMs, stall_ms: stallMs }));

  let fail = false; const reasons = [];
  if (p99 > p99TargetMs) { fail = true; reasons.push(`p99_first_ms>${p99TargetMs}`); }
  if (hedgeRate < 0.8) { fail = true; reasons.push('hedge_rate<0.8'); }

  try { child?.kill?.('SIGTERM'); } catch {}
  if (fail) {
    console.error(`SOAK_FAILOVER_HEDGE_FAIL: ${reasons.join(',')}`);
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error('soak_failover_hedge_error', e && e.stack || e); process.exitCode = 1; });

