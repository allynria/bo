import http from 'node:http';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

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

function waitForUp(base, { timeout = 5000 } = {}) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const tick = () => {
      http
        .get(`${base}/healthz`, (res) => {
          if (res.statusCode === 200) {
            res.resume();
            resolve(true);
          } else {
            res.resume();
            if (Date.now() < deadline) setTimeout(tick, 100);
            else reject(new Error('timeout'));
          }
        })
        .on('error', () => {
          if (Date.now() < deadline) setTimeout(tick, 100);
          else reject(new Error('timeout'));
        });
    };
    tick();
  });
}

function postRaw(url, raw, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(raw || '');
    const u = new URL(url);
    const req = http.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + (u.search || ''),
        headers: { 'Content-Length': data.length, ...headers },
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
          } catch {
            resolve({ status: res.statusCode, headers: res.headers, text: out });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function postJson(url, body, headers = {}) {
  return postRaw(url, JSON.stringify(body || {}), {
    'Content-Type': 'application/json',
    ...headers,
  });
}
function getRaw(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        method: 'GET',
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + (u.search || ''),
        headers,
      },
      (res) => {
        let out = '';
        res.on('data', (d) => {
          out += d.toString();
        });
        res.on('end', () => {
          const ct = String(res.headers['content-type'] || '');
          if (/application\/json/i.test(ct)) {
            try {
              resolve({
                status: res.statusCode,
                headers: res.headers,
                json: JSON.parse(out || '{}'),
              });
            } catch {
              resolve({ status: res.statusCode, headers: res.headers, text: out });
            }
          } else {
            resolve({ status: res.statusCode, headers: res.headers, text: out });
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const port = 4750 + Math.floor(Math.random() * 200);
  const env = {
    PORT: String(port),
    NODE_ENV: 'production',
    LOG_JSON: '1',
    QUEUE_MAX: '0',
    CORS_ALLOWLIST: 'http://ok.test',
    REPLAY_WINDOW_MS: '2000',
    CONV_SOFT_MAX: '2',
    CONV_SOFT_WINDOW_MS: '5000',
    LLM_TEST_STUBS: '1',
    URGA_PROVIDER: 'stub-urga',
    CONV_AUTH: 'test-token',
  };
  const { child, getLogs } = startService(env);
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 5000 }).catch(async () => {
    try {
      child.kill('SIGTERM');
    } catch {}
    throw new Error('service did not become ready: ' + getLogs());
  });

  const log = (label, r) => {
    const j = r.json || {};
    console.log(`${label}: status=${r.status} error=${j.error || ''} reason=${j.reason || ''}`);
  };

  const r401_ts = await postJson(
    `${base}/conv/message`,
    { text: 'hi', conv_id: 'c401a', turn: 0, engine: 'urga' },
    { origin: 'http://ok.test' }
  );
  log('401-ts', r401_ts);

  const nowTs = Date.now();
  const r401_auth = await getRaw(`${base}/conv/stream?text=hi&conv_id=s401&turn=0&ts=${nowTs}`, {
    origin: 'http://ok.test',
  });
  log('401-auth', r401_auth);

  const r403 = await postJson(
    `${base}/conv/message`,
    { text: 'hi', conv_id: 'c403', turn: 0, engine: 'urga' },
    { origin: 'http://evil.test', authorization: 'Bearer test-token' }
  );
  log('403-cors', r403);

  const bodyRL = { text: 'hit rl', conv_id: 'c429', turn: 0, engine: 'urga', ts: Date.now() };
  const a1 = await postJson(`${base}/conv/message`, bodyRL, {
    origin: 'http://ok.test',
    authorization: 'Bearer test-token',
  });
  log('429-pre1', a1);
  const a2 = await postJson(
    `${base}/conv/message`,
    { ...bodyRL, ts: Date.now() },
    { origin: 'http://ok.test', authorization: 'Bearer test-token' }
  );
  log('429-pre2', a2);
  const a3 = await postJson(
    `${base}/conv/message`,
    { ...bodyRL, ts: Date.now() },
    { origin: 'http://ok.test', authorization: 'Bearer test-token' }
  );
  log('429-hit', a3);

  const url409 = `${base}/conv/message`;
  const idemKey = 'dup409-key';
  const headers409 = {
    origin: 'http://ok.test',
    authorization: 'Bearer test-token',
    'Idempotency-Key': idemKey,
  };
  const body409 = { text: 'dup-stream', conv_id: 'c409m', turn: 0, engine: 'urga', ts: Date.now() };
  const [dm1, dm2] = await Promise.all([
    postJson(url409, body409, headers409),
    postJson(url409, body409, headers409),
  ]);
  log('409-dm1', dm1);
  log('409-dm2', dm2);

  const s3 = await getRaw(
    `${base}/conv/stream?conv_id=c409x&turn=0&engine=urga&replay=true&ts=${Date.now()}`,
    { origin: 'http://ok.test', authorization: 'Bearer test-token' }
  );
  log('409-replay', s3);

  const d1 = await postJson(
    `${base}/drain/start?ms=200`,
    {},
    { authorization: 'Bearer test-token' }
  );
  log('drain-start', d1);
  const r503 = await postJson(
    `${base}/conv/message`,
    { text: 'during drain', conv_id: 'c503', turn: 0, engine: 'urga', ts: Date.now() },
    { origin: 'http://ok.test', authorization: 'Bearer test-token' }
  );
  log('503-draining', r503);

  try {
    child.kill('SIGTERM');
  } catch {}
  await new Promise((r) => child.on('exit', r));
}

main().catch((e) => {
  console.error('debug failed:', e);
  process.exit(1);
});
