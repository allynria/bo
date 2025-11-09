import http from 'node:http';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

function startService(env = {}) {
  const script = path.join(process.cwd(), 'scripts', 'service.js');
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
  child.stdout.on('data', (d) => {
    process.stdout.write(d.toString());
  });
  child.stderr.on('data', (d) => {
    process.stderr.write(d.toString());
  });
  return child;
}

function waitForUp(base, { timeout = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const end = Date.now() + Math.max(1000, timeout);
    const tryOnce = () => {
      const u = new URL(base);
      const req = http.get({ hostname: u.hostname, port: u.port, path: '/healthz' }, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve(true);
        if (Date.now() < end) setTimeout(tryOnce, 100);
        else reject(new Error(String(res.statusCode)));
      });
      req.on('error', () => {
        if (Date.now() < end) setTimeout(tryOnce, 100);
        else reject(new Error('error'));
      });
    };
    tryOnce();
  });
}

function fetchNdjson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (c) => {
        body += c.toString();
      });
      res.on('end', () => {
        resolve({ status: res.statusCode, body, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const port = 3900 + Math.floor(Math.random() * 500);
  const token = 'admintoken';
  const child = startService({
    NODE_ENV: 'production',
    LOG_JSON: '1',
    PORT: String(port),
    ADMIN_TOKEN: token,
    USAGE_HMAC_SECRET: 'billing-secret',
    LLM_TEST_STUBS: '1',
    URGA_PROVIDER: 'stub-urga',
  });
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 3000 }).catch((e) => {
    console.error('waitForUp error:', e);
  });

  // Trigger a simple message alias to produce llm_cost metrics (stub provider)
  await new Promise((resolve, reject) => {
    const body = JSON.stringify({
      message: { role: 'user', content: 'hello' },
      ctx: { vars: { tenant: 'test-tenant' } },
    });
    const req = http.request(
      `${base}/message`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tenant': 'test-tenant' },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          raw += c;
        });
        res.on('end', () => {
          console.log('MESSAGE_ALIAS_STATUS:', res.statusCode);
          try {
            console.log('MESSAGE_ALIAS_BODY:', raw.slice(0, 160));
          } catch {}
          resolve();
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  // Hit billing export directly
  const ndj = await fetchNdjson(`${base}/billing/export`, {
    Authorization: `Bearer ${token}`,
  }).catch((e) => ({ status: 0, body: '', headers: {} }));
  console.log('BILLING_EXPORT_STATUS:', ndj.status);
  console.log('BILLING_EXPORT_HEADERS:', ndj.headers);
  const body = String(ndj.body || '');
  const lines = body.trim().split(/\n+/);
  console.log('BILLING_EXPORT_LINES_COUNT:', lines.filter(Boolean).length);
  console.log('BILLING_EXPORT_FIRST_LINE:', lines[0] || '');

  try {
    child.kill('SIGTERM');
  } catch {}
}

main().catch((e) => {
  console.error('debug error:', e);
  process.exit(1);
});
