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

function waitForUp(base, { timeout = 5000 } = {}) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const tick = () => {
      http
        .get(`${base}/healthz`, (res) => {
          if (res.statusCode === 200) resolve();
          else if (Date.now() > deadline) reject(new Error('timeout'));
        })
        .on('error', () => {
          if (Date.now() > deadline) reject(new Error('timeout'));
          else setTimeout(tick, 100);
        });
    };
    tick();
  });
}

function connectSSEAbortAfter(url, headers = {}, abortAfterDeltaCount = 2) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers },
      (res) => {
        let deltas = [];
        let buf = '';
        const flush = () => {
          const parts = buf.split(/\r?\n\r?\n/);
          buf = parts.pop();
          for (const part of parts) {
            const lines = part.split(/\r?\n/);
            let evt = null;
            let dataStr = '';
            for (const line of lines) {
              if (line.startsWith('event:')) evt = line.slice(6).trim();
              else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
            }
            if (evt === 'delta') {
              try {
                const p = JSON.parse(dataStr);
                if (typeof p?.text === 'string') deltas.push(p.text);
              } catch {}
              if (deltas.length >= abortAfterDeltaCount) {
                try {
                  req.destroy();
                } catch {}
                resolve({ deltas });
              }
            }
          }
        };
        res.on('data', (d) => {
          buf += d.toString();
          flush();
        });
        res.on('end', () => {
          flush();
          resolve({ deltas });
        });
      }
    );
    req.on('error', () => resolve({ deltas: [] }));
    req.end();
  });
}

function fetchSSE(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers },
      (res) => {
        let startPayload = null;
        let finalPayload = null;
        let buf = '';
        const flush = () => {
          const parts = buf.split(/\r?\n\r?\n/);
          buf = parts.pop();
          for (const part of parts) {
            const lines = part.split(/\r?\n/);
            let evt = null;
            let dataStr = '';
            for (const line of lines) {
              if (line.startsWith('event:')) evt = line.slice(6).trim();
              else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
            }
            if (evt === 'start') {
              try {
                startPayload = JSON.parse(dataStr);
              } catch {}
            } else if (evt === 'end') {
              try {
                finalPayload = JSON.parse(dataStr);
              } catch {}
            }
          }
        };
        res.on('data', (d) => {
          buf += d.toString();
          flush();
        });
        res.on('end', () => {
          flush();
          resolve({ start: startPayload, end: finalPayload });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function fetchMetrics(base) {
  return new Promise((resolve, reject) => {
    http
      .get(`${base}/metrics`, (res) => {
        let body = '';
        res.on('data', (d) => {
          body += d.toString();
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

function getRaw(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers },
      (res) => {
        let body = '';
        res.on('data', (d) => {
          body += d.toString();
        });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const port = 4900 + Math.floor(Math.random() * 200);
  const env = {
    PORT: String(port),
    QUEUE_MAX: '0',
    LLM_TURN_BUDGET: '5',
    LLM_TEST_STUBS: '1',
    URGA_PROVIDER: 'stub-urga',
    SSE_HEARTBEAT_MS: '1000',
    IDEMPOTENCY_TTL_MS: '1500',
  };
  const { child, getLogs } = startService(env);
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 5000 });
  const conv_id = process.env.CONV || 'disconnect-replay-debug';
  const idem = process.env.IDEM || 'idem-debug-1';
  const u = `${base}/conv/stream?conv_id=${encodeURIComponent(conv_id)}&turn=0&engine=urga&text=${encodeURIComponent('plain text')}`;
  const { deltas } = await connectSSEAbortAfter(u, { 'Idempotency-Key': idem }, 3);
  const agg = Array.isArray(deltas) ? deltas.join('') : '';
  // Optionally run a full stream to capture server behavior without abort
  let full = null;
  if ((process.env.FULL_ONCE || '0') === '1') {
    const uFull = `${base}/conv/stream?conv_id=${encodeURIComponent(conv_id)}&turn=0&engine=urga&text=${encodeURIComponent('plain text')}&ts=${Date.now()}`;
    full = await fetchSSE(uFull, { 'Idempotency-Key': idem });
  }
  const replayUrl = `${base}/conv/stream?conv_id=${encodeURIComponent(conv_id)}&turn=0&engine=urga&replay=1`;
  const replay = await fetchSSE(replayUrl, { 'Idempotency-Key': idem });
  // Also fetch raw once more to see HTTP status/body if different from SSE
  const replayRaw = await getRaw(replayUrl, { 'Idempotency-Key': idem });
  const metrics = await fetchMetrics(base);
  const activeGauge = (Array.isArray(metrics?.counters) ? metrics.counters : []).find(
    (c) => c.name === 'active_streams_current'
  );
  console.log(
    JSON.stringify(
      {
        agg,
        fullStart: full.start,
        fullEnd: full.end,
        replayStart: replay.start,
        replayEnd: replay.end,
        replayStatus: replayRaw.status,
        replayBody: replayRaw.body,
        activeStreamsGauge: activeGauge,
      },
      null,
      2
    )
  );
  try {
    console.log('LOGS:\n' + getLogs());
  } catch {}
  try {
    child.kill('SIGTERM');
  } catch {}
}

main().catch((e) => {
  console.error('debug_error', e);
  process.exitCode = 1;
});
