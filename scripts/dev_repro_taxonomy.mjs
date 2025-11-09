import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';

function startService(env = {}) {
  const script = path.join(process.cwd(), 'scripts', 'service.js');
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
  let logs = '';
  child.stdout.on('data', (d) => {
    logs += d.toString();
  });
  child.stderr.on('data', (d) => {
    logs += d.toString();
  });
  return { child, getLogs: () => logs };
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = '';
        res.on('data', (d) => {
          data += d.toString();
        });
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode,
              headers: res.headers,
              json: JSON.parse(data || '{}'),
            });
          } catch (e) {
            resolve({ status: res.statusCode, headers: res.headers, body: data, error: String(e) });
          }
        });
      })
      .on('error', reject);
  });
}

async function main() {
  const port = 3300 + Math.floor(Math.random() * 100);
  const env = {
    PORT: String(port),
    QUEUE_MAX: '0',
    POLICY_LIMIT: '2',
    POLICY_WINDOW_MS: '100',
    POLICY_INTERNAL_ERROR_ONCE: '0',
    LOG_JSON: '1',
  };
  const { child } = startService(env);
  await new Promise((r) => setTimeout(r, 250));
  const base = `http://localhost:${port}`;
  const r1 = await fetchJson(`${base}/other`);
  const r2 = await fetchJson(`${base}/other`);
  const r3 = await fetchJson(`${base}/other`);
  const r4 = await fetchJson(`${base}/other`);
  console.log('r1', r1.status, r1.headers['retry-after']);
  console.log('r2', r2.status, r2.headers['retry-after']);
  console.log('r3', r3.status, r3.headers['retry-after']);
  console.log('r4', r4.status, r4.headers['retry-after']);
  const m = await fetchJson(`${base}/metrics`);
  console.log('metrics', m.status, JSON.stringify(m.json));
  try {
    child.kill('SIGTERM');
  } catch {}

  // Case 2: Backpressure produces 503 under load with Retry-After
  const port2 = 3400 + Math.floor(Math.random() * 100);
  const env2 = {
    PORT: String(port2),
    QUEUE_MAX: '2',
    LOG_JSON: '1',
  };
  const { child: child2 } = startService(env2);
  await new Promise((r) => setTimeout(r, 250));
  const base2 = `http://localhost:${port2}`;
  const reqs = Array.from({ length: 6 }, () => fetchJson(`${base2}/other`));
  const results = await Promise.all(reqs);
  console.log(
    'backpressure_statuses',
    results.map((r) => r.status)
  );
  console.log(
    'backpressure_retry_after',
    results.map((r) => r.headers && r.headers['retry-after'])
  );
  const m2 = await fetchJson(`${base2}/metrics`);
  console.log('metrics2', m2.status, JSON.stringify(m2.json));
  try {
    child2.kill('SIGTERM');
  } catch {}
}

main().catch((e) => {
  console.error('taxonomy_repro_error', (e && e.stack) || e);
  process.exitCode = 1;
});
