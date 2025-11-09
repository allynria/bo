import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { waitForUp } from './helpers/wait_for_up.mjs';

function startService(env = {}) {
  const script = path.join(process.cwd(), 'scripts', 'service.js');
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d.toString(); });
  child.stderr.on('data', (d) => { logs += d.toString(); });
  return { child, getLogs: () => logs };
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const u = new URL(url);
    const req = http.request({ method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname, headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => {
      let out = '';
      res.on('data', (d) => { out += d.toString(); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(out || '{}') }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

test('Routing precedence and AB stickiness under concurrency', async () => {
  const port = 4200 + Math.floor(Math.random() * 200);
  const env = { PORT: String(port), QUEUE_MAX: '0', LLM_TURN_BUDGET: '5', LLM_TEST_STUBS: '1', URGA_PROVIDER: 'stub-urga', CONV_RATE_MAX: '1000', CONV_RATE_WINDOW: '2000', CONV_SOFT_MAX: '5000', CONV_SOFT_WINDOW_MS: '2000' };
  const { child } = startService(env);
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 5000 });

  // Precedence: explicit engine
  {
    const r = await postJson(`${base}/conv/message`, { text: 'plain text', conv_id: 'prec-explicit', turn: 0, engine: 'echo' });
    assert.equal(r.status, 200);
    assert.equal(r.json.model, 'echo');
    assert.equal(r.json.engine_source, 'explicit');
  }

  // Precedence: ctx.vars.engine when explicit absent
  {
    const r = await postJson(`${base}/conv/message`, { text: 'plain text', conv_id: 'prec-ctx', turn: 0, ctx: { vars: { engine: 'dreams' } } });
    assert.equal(r.status, 200);
    assert.equal(r.json.model, 'dreams');
    assert.equal(r.json.engine_source, 'ctx');
  }

  // Precedence: heuristic when neither explicit nor ctx present
  {
    const r = await postJson(`${base}/conv/message`, { text: 'Night and lucid dreaming', conv_id: 'prec-heur', turn: 0 });
    assert.equal(r.status, 200);
    assert.equal(r.json.model, 'dreams');
    assert.equal(r.json.engine_source, 'heuristic');
  }

  // AB stickiness: 10k mixed requests across conversations; variant must not flip per conv_id
  const N = 10000;
  const convCount = 100;
  const convs = Array.from({ length: convCount }, (_, i) => `stick-${i}`);
  const firstVariant = new Map();
  const tasks = [];
  for (let i = 0; i < N; i++) {
    const cid = convs[i % convs.length];
    const body = (i % 3 === 0)
      ? { text: 'plain text', conv_id: cid, turn: i % 4, engine: 'urga' }
      : (i % 3 === 1)
        ? { text: 'gods and pantheon echo', conv_id: cid, turn: i % 4 }
        : { text: 'ctx-based dreams', conv_id: cid, turn: i % 4, ctx: { vars: { engine: 'dreams' } } };
    tasks.push(postJson(`${base}/conv/message`, body).then((r) => {
      assert.equal(r.status, 200);
      const v = String(r.json.variant_v || '');
      const existing = firstVariant.get(cid);
      if (!existing) firstVariant.set(cid, v);
      else if (existing !== v) throw new Error(`Variant flip detected for ${cid}: ${existing} -> ${v}`);
      // Precedence safety check: engine_source must match selection path
      const src = r.json.engine_source;
      if (body.engine) assert.equal(src, 'explicit');
      else if (body?.ctx?.vars?.engine) assert.equal(src, 'ctx');
      else assert.ok(src === 'heuristic' || src === 'default');
    }));
  }
  await Promise.all(tasks);

  try { child.kill('SIGTERM'); } catch {}
  await new Promise((r) => child.on('exit', r));
});
