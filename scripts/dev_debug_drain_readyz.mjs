import http from 'node:http';
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

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (d) => { data += d.toString(); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(data || '{}') }); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function main() {
  const port = 4288 + Math.floor(Math.random() * 10);
  const env = { NODE_ENV: 'production', LOG_JSON: '1', PORT: String(port), QUEUE_MAX: '3' };
  const { child, getLogs } = startService(env);
  const base = `http://localhost:${port}`;

  // Wait for readiness
  let ready = false;
  for (let i = 0; i < 20 && !ready; i++) {
    try { const hz = await fetchJson(`${base}/healthz`); ready = (hz.status === 200); } catch {}
    if (!ready) await new Promise((r) => setTimeout(r, 60));
  }
  console.log('READY:', ready);
  if (!ready) {
    console.log('LOGS_BEFORE:', getLogs());
    try { child.kill('SIGTERM'); } catch {}
    await new Promise((r) => child.on('exit', r));
    process.exit(1);
  }

  // Hold multiple connections
  const N = 6;
  const waiters = [];
  for (let i = 0; i < N; i++) waiters.push(fetchJson(`${base}/wait?ms=500`).catch(() => ({ status: 0 })));
  await new Promise((r) => setTimeout(r, 200));

  // Verify ready before drain
  const rz1 = await fetchJson(`${base}/readyz`);
  console.log('READYZ_BEFORE:', rz1.status, rz1.json);

  // Start drain and observe readyz
  const d = await fetchJson(`${base}/drain/start?ms=300`).catch((e) => ({ status: 0, json: { error: String(e) } }));
  console.log('DRAIN_START:', d.status, d.json);
  await new Promise((r) => setTimeout(r, 20));

  let rz2 = await fetchJson(`${base}/readyz`).catch(() => ({ status: 0, json: {} }));
  if (rz2.status === 0) {
    await new Promise((r) => setTimeout(r, 30));
    rz2 = await fetchJson(`${base}/readyz`).catch(() => ({ status: 0, json: {} }));
  }
  console.log('READYZ_DURING:', rz2.status, rz2.json);

  // Accelerate shutdown
  try { child.kill('SIGTERM'); } catch {}
  try { await Promise.allSettled(waiters); } catch {}
  await new Promise((r) => child.on('exit', r));

  const lines = getLogs().trim().split(/\r?\n/).filter(Boolean);
  console.log('LOG_COUNT:', lines.length);
  console.log('LOG_LAST_5:\n' + lines.slice(-5).join('\n'));
}

main().catch((e) => {
  console.error('DEBUG_SCRIPT_ERROR:', e && (e.stack || e));
  process.exit(1);
});

