import http from 'node:http';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

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

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const u = new URL(url);
    const req = http.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
      },
      (res) => {
        let out = '';
        res.on('data', (d) => {
          out += d.toString();
        });
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode,
              headers: res.headers,
              json: JSON.parse(out || '{}'),
            });
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function waitForUp(base, { timeout = 5000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const u = new URL(base);
      const ok = await new Promise((resolve) => {
        const req = http.request(
          { method: 'GET', hostname: u.hostname, port: u.port, path: '/healthz' },
          (res) => {
            resolve(res.statusCode === 200);
          }
        );
        req.on('error', () => resolve(false));
        req.end();
      });
      if (ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 80));
  }
  return false;
}

async function main() {
  const port = 4300 + Math.floor(Math.random() * 200);
  const env = {
    PORT: String(port),
    QUEUE_MAX: '0',
    LLM_TURN_BUDGET: '5',
    LLM_TEST_STUBS: '1',
    URGA_PROVIDER: 'stub-urga',
    CONV_RATE_MAX: '1000',
    CONV_RATE_WINDOW: '2000',
  };
  const { child } = startService(env);
  const base = `http://localhost:${port}`;
  const ready = await waitForUp(base, { timeout: 5000 });
  if (!ready) {
    console.error(JSON.stringify({ ok: false, error: 'service_not_ready' }));
    try {
      child.kill('SIGTERM');
    } catch {}
    return;
  }

  // AB stickiness probe: reduced N for interactive run
  const N = 1200;
  const convCount = 60;
  const convs = Array.from({ length: convCount }, (_, i) => `stick-${i}`);
  const firstVariant = new Map();
  const variantFlips = [];
  const non200 = [];
  const badSource = [];

  const tasks = [];
  for (let i = 0; i < N; i++) {
    const cid = convs[i % convs.length];
    const body =
      i % 3 === 0
        ? { text: 'plain text', conv_id: cid, turn: i % 4, engine: 'urga' }
        : i % 3 === 1
          ? { text: 'gods and pantheon echo', conv_id: cid, turn: i % 4 }
          : {
              text: 'ctx-based dreams',
              conv_id: cid,
              turn: i % 4,
              ctx: { vars: { engine: 'dreams' } },
            };
    tasks.push(
      postJson(`${base}/conv/message`, body).then((r) => {
        if (r.status !== 200) {
          non200.push({ status: r.status, cid, body });
          return;
        }
        const v = String(r.json.variant_v || '');
        const existing = firstVariant.get(cid);
        if (!existing) firstVariant.set(cid, v);
        else if (existing !== v) variantFlips.push({ cid, from: existing, to: v });
        const src = r.json.engine_source;
        if (body.engine && src !== 'explicit') badSource.push({ cid, src, expected: 'explicit' });
        else if (body?.ctx?.vars?.engine && src !== 'ctx')
          badSource.push({ cid, src, expected: 'ctx' });
        else if (
          !body.engine &&
          !body?.ctx?.vars?.engine &&
          !(src === 'heuristic' || src === 'default')
        )
          badSource.push({ cid, src, expected: 'heuristic|default' });
      })
    );
  }
  await Promise.all(tasks);

  try {
    child.kill('SIGTERM');
  } catch {}
  await new Promise((r) => child.on('exit', r));

  const ok = variantFlips.length === 0 && non200.length === 0 && badSource.length === 0;
  const summary = {
    ok,
    flips: variantFlips.length,
    non200: non200.length,
    badSource: badSource.length,
    sample: {
      variantFlip: variantFlips[0] || null,
      non200: non200[0] || null,
      badSource: badSource[0] || null,
    },
  };
  console.log(JSON.stringify(summary));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
  process.exitCode = 1;
});
