import { spawn } from 'node:child_process';
import http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';

function startService(env = {}) {
  const script = path.join(process.cwd(), 'scripts', 'service.js');
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d.toString(); });
  child.stderr.on('data', (d) => { logs += d.toString(); });
  return { child, getLogs: () => logs };
}

function waitForUp(baseUrl, { timeout = 5000 } = {}) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const u = new URL(baseUrl);
      const req = http.request({ method: 'GET', hostname: u.hostname, port: u.port, path: '/' }, (res) => {
        try { res.resume(); } catch {}
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) resolve();
        else if (Date.now() < deadline) setTimeout(tryOnce, 100);
        else reject(new Error('service_up_timeout'));
      });
      req.on('error', () => { if (Date.now() < deadline) setTimeout(tryOnce, 100); else reject(new Error('service_up_error')); });
      req.end();
    };
    tryOnce();
  });
}

function postJson(url, body) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const u = new URL(url);
    const req = http.request({ method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname, headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => {
      let out = '';
      res.on('data', (d) => { out += d.toString(); });
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(out || '{}'); } catch {}
        resolve({ status: res.statusCode || 0, json });
      });
    });
    req.on('error', () => resolve({ status: 0, json: {} }));
    req.write(data);
    req.end();
  });
}

function fetchSSE(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request({ method: 'GET', hostname: u.hostname, port: u.port, path: u.pathname + u.search }, (res) => {
      let startEvent = null;
      let endEvent = null;
      res.on('data', (d) => {
        const s = d.toString();
        const lines = s.split(/\r?\n/);
        let event = '';
        let data = '';
        for (const line of lines) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          if (line.startsWith('data:')) data = line.slice(5).trim();
          if (line === '') {
            try {
              const j = JSON.parse(data || '{}');
              if (event === 'start') startEvent = j;
              if (event === 'end') endEvent = j;
            } catch {}
            event = '';
            data = '';
          }
        }
      });
      res.on('end', () => resolve({ status: res.statusCode || 0, startEvent, endEvent }));
    });
    req.on('error', () => resolve({ status: 0 }));
    req.end();
  });
}

async function main() {
  const port = 4800 + Math.floor(Math.random() * 100);
  const tmpRoot = path.join(process.cwd(), `.tmp_ab_restart_probe_${Date.now()}`);
  try { fs.mkdirSync(tmpRoot, { recursive: true }); } catch {}
  const env = { PORT: String(port), QUEUE_MAX: '0', LLM_TURN_BUDGET: '5', LLM_TEST_STUBS: '1', URGA_PROVIDER: 'stub-urga', TMPDIR: tmpRoot, TEMP: tmpRoot, CONV_RATE_MAX: '2000', CONV_RATE_WINDOW: '3000', CONV_SOFT_MAX: '5000', CONV_SOFT_WINDOW_MS: '2000' };

  const { child: child1 } = startService(env);
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 5000 });

  const convs = Array.from({ length: 30 }, (_, i) => `persist-${i}`);
  const firstVariant = new Map();

  // Drive initial messages
  for (let i = 0; i < 300; i++) {
    const cid = convs[i % convs.length];
    const body = (i % 3 === 0)
      ? { text: 'plain text', conv_id: cid, turn: i % 4, engine: 'urga' }
      : (i % 3 === 1)
        ? { text: 'gods and pantheon echo', conv_id: cid, turn: i % 4 }
        : { text: 'ctx dreams', conv_id: cid, turn: i % 4, ctx: { vars: { engine: 'dreams' } } };
    const r = await postJson(`${base}/conv/message`, body);
    if (r.status !== 200) { console.log(JSON.stringify({ ok: false, stage: 'first_boot_message', status: r.status })); process.exit(1); }
    const v = String(r.json.variant_v || '');
    if (!firstVariant.has(cid)) firstVariant.set(cid, v);
  }

  // Stream once per conv
  for (let i = 0; i < convs.length; i++) {
    const cid = convs[i];
    const u = `${base}/conv/stream?conv_id=${encodeURIComponent(cid)}&turn=0&engine=urga&text=${encodeURIComponent('hello')}`;
    const s = await fetchSSE(u);
    if (s.status !== 200) { console.log(JSON.stringify({ ok: false, stage: 'first_boot_stream', status: s.status })); process.exit(1); }
  }

  try { child1.kill('SIGTERM'); } catch {}
  await new Promise((r) => child1.on('exit', r));

  const { child: child2 } = startService(env);
  await waitForUp(base, { timeout: 5000 });

  const mismatches = [];
  for (let i = 0; i < 300; i++) {
    const cid = convs[i % convs.length];
    const body = (i % 2 === 0)
      ? { text: 'after restart dreams', conv_id: cid, turn: i % 4, ctx: { vars: { engine: 'dreams' } } }
      : { text: 'after restart echo pantheon', conv_id: cid, turn: i % 4 };
    const r = await postJson(`${base}/conv/message`, body);
    if (r.status !== 200) { mismatches.push({ cid, type: 'status', status: r.status }); continue; }
    const v = String(r.json.variant_v || '');
    const expected = firstVariant.get(cid);
    if (v !== expected) mismatches.push({ cid, type: 'variant', expected, got: v });
  }

  // Stream validation
  const streamMismatches = [];
  for (let i = 0; i < convs.length; i++) {
    const cid = convs[i];
    const u = `${base}/conv/stream?conv_id=${encodeURIComponent(cid)}&turn=1&text=${encodeURIComponent('after restart')}`;
    const s = await fetchSSE(u);
    if (s.status !== 200) { streamMismatches.push({ cid, type: 'status', status: s.status }); continue; }
    const got = String(s.startEvent?.variant_v || '');
    const expected = firstVariant.get(cid);
    if (got !== expected) streamMismatches.push({ cid, type: 'variant', expected, got });
  }

  try { child2.kill('SIGTERM'); } catch {}
  await new Promise((r) => child2.on('exit', r));

  const summary = { ok: mismatches.length === 0 && streamMismatches.length === 0, mismatches, streamMismatches, sample: { message: mismatches[0] || null, stream: streamMismatches[0] || null } };
  console.log(JSON.stringify(summary));
}

main().catch((e) => { console.log(JSON.stringify({ ok: false, error: String(e && e.message || e) })); process.exit(1); });

