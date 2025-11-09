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
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function main() {
  const port = 3200 + Math.floor(Math.random() * 100);
  const { child, getLogs } = startService({ NODE_ENV: 'production', LOG_JSON: '1', PORT: String(port), QUEUE_MAX: '3' });
  await new Promise((r) => setTimeout(r, 250));
  const lines = getLogs().trim().split(/\r?\n/).filter(Boolean);
  console.log('lines_count', lines.length);
  for (const line of lines) {
    try { JSON.parse(line); } catch { console.log('bad_line', line); }
  }
  const base = `http://localhost:${port}`;
  const hz1 = await fetchJson(`${base}/healthz`);
  console.log('hz1.status', hz1.status);
  console.log('hz1.json', hz1.json);
  const N = 8;
  const waiters = [];
  for (let i = 0; i < N; i++) waiters.push(fetchJson(`${base}/wait?ms=400`).catch((e) => ({ status: 0, error: String(e) })));
  await new Promise((r) => setTimeout(r, 120));
  const hz2 = await fetchJson(`${base}/healthz`);
  console.log('hz2.status', hz2.status);
  console.log('hz2.json', hz2.json);
  const other = await fetchJson(`${base}/other`).catch((e) => ({ status: 0, err: String(e) }));
  console.log('other.status', other.status);
  console.log('other.headers', other.headers);
  console.log('other.json', other.json);
  const rzBefore = await fetchJson(`${base}/readyz`).catch(() => ({ status: 0 }));
  console.log('rzBefore.status', rzBefore.status);
  console.log('rzBefore.json', rzBefore.json);
  try { child.kill('SIGTERM'); } catch {}
  try { await Promise.allSettled(waiters); } catch {}
  await new Promise((r) => child.on('exit', r));
  const finalLines = getLogs().trim().split(/\r?\n/).filter(Boolean);
  console.log('final_lines_count', finalLines.length);
  for (const line of finalLines) {
    try { JSON.parse(line); } catch { console.log('bad_final_line', line); }
  }
}

main().catch((e) => { console.error('repro_error', e && e.stack || e); process.exitCode = 1; });

