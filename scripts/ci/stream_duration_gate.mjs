import http from 'node:http';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

function startService(env = {}) {
  const script = path.join(process.cwd(), 'scripts', 'service.js');
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  return child;
}

function waitForUp(base, { timeout = 5000 } = {}) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const tick = () => {
      http.get(`${base}/healthz`, (res) => {
        if (res.statusCode === 200) { res.resume(); resolve(true); }
        else { res.resume(); if (Date.now() < deadline) setTimeout(tick, 100); else reject(new Error('timeout')); }
      }).on('error', () => { if (Date.now() < deadline) setTimeout(tick, 100); else reject(new Error('timeout')); });
    };
    tick();
  });
}

function fetchSSEUntilEnd(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search }, (res) => {
      let resolved = false;
      const status = res.statusCode || 0;
      if (status !== 200) {
        // Non-SSE response (likely rate-limit or auth), bail early
        res.resume();
        resolve({ ok: false, status });
        return;
      }
      res.on('data', (d) => {
        if (resolved) return;
        const s = d.toString();
        const lines = s.split(/\r?\n/).filter(Boolean);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.startsWith('event: ')) {
            const evt = line.slice(7).trim();
            if (evt === 'end' && !resolved) { resolved = true; resolve({ ok: true, status }); }
          }
        }
      });
      res.on('end', () => { if (!resolved) resolve({ ok: false, status }); });
    });
    req.on('error', (e) => reject(e));
  });
}

function fetchJson(url, headers = {}) {
  return new Promise((resolve) => {
    const req = http.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch { resolve({ status: res.statusCode, json: null }); }
      });
    });
    req.on('error', () => resolve({ status: 0, json: null }));
  });
}

async function main() {
  const port = Number(process.env.PORT || 3951);
  const base = `http://localhost:${port}`;
  const engine = String(process.env.STREAM_ENGINE || 'urga');
  // Load per-engine config if available, env variables override config
  let cfg = {};
  try {
    const cfgPath = path.join(process.cwd(), 'scripts', 'ci', 'engines.json');
    if (fs.existsSync(cfgPath)) {
      cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) || {};
    }
  } catch {}
  const ecfg = cfg && typeof cfg === 'object' ? (cfg[engine] || {}) : {};
  const N = Math.max(1, Number(process.env.STREAM_REQUESTS || ecfg.stream_requests || 24));
  const thresholdMs = Math.max(1, Number(process.env.STREAM_DURATION_THRESHOLD_MS || ecfg.stream_duration_threshold_ms || 5000));
  const minPctUnder = Math.max(0, Math.min(100, Number(process.env.STREAM_DURATION_MIN_PCT_UNDER || ecfg.stream_duration_min_pct_under || 90)));
  const concurrency = Math.max(1, Number(process.env.CONCURRENCY || ecfg.concurrency || 4));
  const spawnService = String(process.env.SPAWN_SERVICE || '1') === '1';
  const metricsAuth = String(process.env.METRICS_AUTH || '').trim();
  const convAuth = String(process.env.CONV_AUTH || 'test-token');

  const child = spawnService ? startService({ NODE_ENV: 'production', LOG_JSON: '1', PORT: String(port), QUEUE_MAX: '0', PREWARM_MODELS: String(process.env.PREWARM_MODELS || '') || undefined, LLM_TEST_STUBS: String(process.env.LLM_TEST_STUBS || '1'), URGA_PROVIDER: String(process.env.URGA_PROVIDER || 'stub-urga'), LLM_TURN_BUDGET: String(process.env.LLM_TURN_BUDGET || '5'), CONV_RATE_MAX: String(process.env.CONV_RATE_MAX || '1000'), CONV_RATE_WINDOW: String(process.env.CONV_RATE_WINDOW || '2000'), CONV_SOFT_MAX: String(process.env.CONV_SOFT_MAX || '5000'), CONV_SOFT_WINDOW_MS: String(process.env.CONV_SOFT_WINDOW_MS || '2000'), CONV_AUTH: convAuth, CORS_ALLOWLIST: '', METRICS_AUTH: '' }) : null;
  if (spawnService) await waitForUp(base, { timeout: 8000 });

  // Trigger N streams and wait until each reaches end, so duration metrics are emitted
  let i = 0;
  let endsSeen = 0;
  const statusHist = Object.create(null);
  const auth = convAuth;
  while (i < N) {
    const batch = [];
    for (let k = 0; k < concurrency && i < N; k++, i++) {
      const text = `duration-gate-${i}-${Math.random().toString(36).slice(2, 8)}`;
      const u = `${base}/conv/stream?conv_id=sd-${i}&turn=0&engine=${encodeURIComponent(engine)}&text=${encodeURIComponent(text)}${auth ? `&auth=${encodeURIComponent(auth)}` : ''}`;
      batch.push(fetchSSEUntilEnd(u).then((res) => {
        const st = Number(res?.status || 0);
        statusHist[st] = (statusHist[st] || 0) + 1;
        if (res?.ok) endsSeen++;
        return res?.ok || false;
      }).catch(() => { statusHist[0] = (statusHist[0] || 0) + 1; return false; }));
    }
    await Promise.allSettled(batch);
  }

  // Read metrics and compute stream duration distribution
  const hdrs = metricsAuth ? { authorization: `Bearer ${metricsAuth}` } : {};
  const m = await fetchJson(`${base}/metrics`, hdrs);
  if (m.status !== 200 || !m.json) {
    console.error('STREAM_DURATION_GATE_FAIL: metrics unavailable', { status: m.status });
    try { child?.kill?.('SIGTERM'); } catch {}
    process.exit(1);
    return;
  }
  const counters = Array.isArray(m.json?.counters) ? m.json.counters : [];
  const sd = counters.filter((c) => c.name === 'stream_duration_ms_bucket');
  const total = sd.reduce((acc, c) => acc + Number(c.value || 0), 0);
  const under = sd
    .filter((c) => {
      const leStr = String(c.labels?.le || '');
      const le = Number(leStr);
      return Number.isFinite(le) && le <= thresholdMs;
    })
    .reduce((acc, c) => acc + Number(c.value || 0), 0);
  const pctUnder = total > 0 ? (under * 100) / total : 0;
  const ok = pctUnder >= minPctUnder;
  const debug = String(process.env.DEBUG_METRICS || '1').toLowerCase();
  const out = { gate: 'stream_duration_distribution', engine, threshold_ms: thresholdMs, min_pct_under: minPctUnder, total, under, pct_under: Math.round(pctUnder), ends_seen: endsSeen, requests: N, concurrency, status_hist: statusHist };
  // Always include bucket counters for diagnostics
  out.counters = sd.map((c) => ({ le: c.labels?.le, value: c.value }));
  if (debug === '1' || debug === 'true') {
    const names = new Set(['responses_total','auth_failed_total','auth_blocked_total','rate_limited_total']);
    out.extra = counters.filter((c) => names.has(String(c.name || '')));
  }
  console.log(JSON.stringify(out));
  try { child?.kill?.('SIGTERM'); } catch {}
  if (!ok) process.exit(1);
}

main().catch((e) => { console.error('stream_duration_gate_error', e && e.stack || e); process.exit(1); });
