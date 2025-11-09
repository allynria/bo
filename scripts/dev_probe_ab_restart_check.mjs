import http from 'node:http';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
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

function waitForUp(base, { timeout = 5000 } = {}) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const tick = () => {
      http
        .get(`${base}/readyz`, (res) => {
          res.resume();
          if (res.statusCode === 200) resolve();
          else if (Date.now() > deadline) reject(new Error(`readyz timeout (${res.statusCode})`));
          else setTimeout(tick, 100);
        })
        .on('error', () => {
          if (Date.now() > deadline) reject(new Error('readyz timeout'));
          else setTimeout(tick, 100);
        });
    };
    tick();
  });
}

function postJson(url, body) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + (u.search || ''),
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        let buf = '';
        res.on('data', (d) => {
          buf += d.toString();
        });
        res.on('end', () => {
          let json = {};
          try {
            json = JSON.parse(buf || '{}');
          } catch {}
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('error', () => resolve({ status: 0, json: {} }));
    req.write(JSON.stringify(body || {}));
    req.end();
  });
}

function fetchSSE(url, headers = {}) {
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
        let buf = '';
        let startEvent = null;
        let endEvent = null;
        res.on('data', (d) => {
          buf += d.toString();
          const chunks = buf.split(/\r?\n\r?\n/);
          buf = chunks.pop();
          for (const chunk of chunks) {
            const lines = chunk.split(/\r?\n/);
            const typeLine = lines.find((l) => l.startsWith('event:')) || '';
            const dataLine = lines.find((l) => l.startsWith('data:')) || '';
            const evt = typeLine.replace(/^event:\s*/, '').trim();
            const dataStr = dataLine.replace(/^data:\s*/, '').trim();
            if (evt === 'start') {
              try {
                startEvent = JSON.parse(dataStr);
              } catch {}
            } else if (evt === 'end') {
              try {
                endEvent = JSON.parse(dataStr);
              } catch {}
            }
          }
        });
        res.on('end', () => resolve({ status: res.statusCode, startEvent, endEvent }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const port = 4820;
  const tmpRoot = path.join(process.cwd(), '.tmp_ab_restart');
  try {
    fs.mkdirSync(tmpRoot, { recursive: true });
  } catch {}
  const env = {
    PORT: String(port),
    LLM_TURN_BUDGET: '5',
    LLM_TEST_STUBS: '1',
    URGA_PROVIDER: 'stub-urga',
    TMPDIR: tmpRoot,
    TEMP: tmpRoot,
    CONV_RATE_MAX: '1000',
    CONV_RATE_WINDOW: '2000',
    CONV_SOFT_MAX: '5000',
    CONV_SOFT_WINDOW_MS: '2000',
  };

  // First boot
  const { child: child1, getLogs: getLogs1 } = startService(env);
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 5000 });

  const cid = 'persist-probe-1';
  const r1 = await postJson(`${base}/conv/message`, {
    text: 'hello',
    conv_id: cid,
    turn: 0,
    engine: 'urga',
  });
  if (r1.status !== 200) throw new Error(`first message non-200: ${r1.status}`);
  const v1 = String(r1.json.variant_v || '');
  if (!(v1 === 'A' || v1 === 'B')) {
    // Print helpful diagnostics before failing
    console.error(
      JSON.stringify({
        ok: false,
        where: 'first_message',
        status: r1.status,
        json: r1.json,
        logs: getLogs1(),
      })
    );
    throw new Error(`invalid variant '${v1}'`);
  }

  const s1 = await fetchSSE(
    `${base}/conv/stream?conv_id=${encodeURIComponent(cid)}&turn=0&engine=urga&text=${encodeURIComponent('hello')}`
  );
  if (s1.status !== 200) throw new Error(`first stream non-200: ${s1.status}`);
  if (!s1.startEvent || !s1.startEvent.variant_v) throw new Error('missing startEvent.variant_v');

  try {
    child1.kill('SIGTERM');
  } catch {}
  await new Promise((r) => child1.on('exit', r));

  // Second boot
  const { child: child2, getLogs: getLogs2 } = startService(env);
  await waitForUp(base, { timeout: 5000 });

  const s2 = await fetchSSE(
    `${base}/conv/stream?conv_id=${encodeURIComponent(cid)}&turn=1&text=${encodeURIComponent('after restart')}`
  );
  if (s2.status !== 200) {
    console.error(
      JSON.stringify({ ok: false, where: 'second_stream', status: s2.status, logs: getLogs2() })
    );
    throw new Error(`second stream non-200: ${s2.status}`);
  }
  const v2 = String((s2.startEvent && s2.startEvent.variant_v) || '');
  if (v2 !== v1) throw new Error(`variant changed across restart: ${v1} -> ${v2}`);

  console.log(JSON.stringify({ ok: true, variant: v1, after_restart: v2 }));

  try {
    child2.kill('SIGTERM');
  } catch {}
  await new Promise((r) => child2.on('exit', r));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
  process.exitCode = 1;
});
