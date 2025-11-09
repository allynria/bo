import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';

function startService(env = {}) {
  const script = path.join(process.cwd(), 'scripts', 'service.js');
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d.toString(); });
  child.stderr.on('data', (d) => { logs += d.toString(); });
  return { child, getLogs: () => logs };
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (d) => { data += d.toString(); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(data || '{}') }); }
        catch (e) { resolve({ status: res.statusCode, headers: res.headers, body: data, error: String(e) }); }
      });
    }).on('error', reject);
  });
}

function fetchStatus(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    }).on('error', reject);
  });
}

async function main() {
  const port = 3450 + Math.floor(Math.random() * 100);
  const { child, getLogs } = startService({ NODE_ENV: 'production', LOG_JSON: '1', PORT: String(port), QUEUE_MAX: '1' });
  const base = `http://localhost:${port}`;
  let ready = false;
  for (let i = 0; i < 20 && !ready; i++) {
    try { const hz = await fetchJson(`${base}/healthz`); ready = (hz.status === 200); } catch {}
    if (!ready) await new Promise((r) => setTimeout(r, 50));
  }
  if (!ready) {
    console.error('not ready', getLogs());
    process.exit(1);
  }

  const N = 40;
  const deadline = Date.now() + 10_000;
  const clients = [];
  for (let i = 0; i < N; i++) {
    clients.push((async () => {
      while (Date.now() < deadline) {
        const r = await fetchStatus(`${base}/other`).catch(() => ({ status: 0, headers: {} }));
        if (r.status !== 503) return true;
        const ra = Number(r.headers?.['retry-after'] || r.headers?.['Retry-After'] || 1);
        const waitMs = Math.max(100, Math.min(3000, Math.ceil(ra * 1000)));
        await new Promise((res) => setTimeout(res, waitMs));
      }
      return false;
    })());
  }

  const results = await Promise.all(clients);
  const successes = results.filter(Boolean).length;
  const ratio = successes / N;
  console.log('retry_after_acceptance', { successes, N, ratio });

  try { child.kill('SIGTERM'); } catch {}
}

main().catch((e) => { console.error('dev_repro_retry_after_error', e && e.stack || e); process.exitCode = 1; });
