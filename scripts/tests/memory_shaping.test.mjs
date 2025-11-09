import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { waitForUp } from './helpers/wait_for_up.mjs';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

function startService(env = {}) {
  const script = path.join(process.cwd(), 'scripts', 'service.js');
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
  return child;
}

function sse(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { Accept: 'text/event-stream' } }, (res) => {
      resolve(res);
    });
    req.on('error', reject);
  });
}
async function collectUntil(res, event, timeoutMs = 4000) {
  res.setEncoding('utf8');
  let buf = '';
  return await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('SSE timeout')), timeoutMs);
    res.on('data', (chunk) => {
      buf += chunk;
      const frames = buf.split('\n\n');
      buf = frames.pop();
      for (const frame of frames) {
        const lines = frame.split('\n');
        let ev = 'message',
          data = '';
        for (const ln of lines) {
          if (ln.startsWith('event:')) ev = ln.slice(6).trim();
          else if (ln.startsWith('data:')) data += ln.slice(5).trim();
        }
        if (ev === event) {
          clearTimeout(to);
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({});
          }
        }
      }
    });
    res.on('error', reject);
  });
}

test('memory.shape emits and reinforces fact', async () => {
  const port = 4700 + Math.floor(Math.random() * 100);
  const env = {
    PORT: String(port),
    LLM_TEST_STUBS: '1',
    URGA_PROVIDER: 'stub-urga',
    TEST_MEMORY_API: '1',
    QUEUE_MAX: '0',
    LLM_TURN_BUDGET: '5',
  };
  const child = startService(env);
  const BASE = `http://127.0.0.1:${port}`;
  try {
    await waitForUp(BASE, { timeout: 3000 });

    const conv_id = 'c_shape';
    await fetch(`${BASE}/__test/clear`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conv_id }),
    });
    const f = await (
      await fetch(`${BASE}/__test/fact`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conv_id,
          text: 'He carries a silver locket',
          score: 0.4,
          salience: 0.4,
        }),
      })
    ).json();
    const fid = f.fact.id;

    // stream with text overlapping the fact
    const url = `${BASE}/conv/stream?engine=urga&conv_id=${conv_id}&turn=3&text=${encodeURIComponent('The silver locket catches the moonlight')}`;
    const res = await sse(url);
    const shape = await collectUntil(res, 'memory.shape', 5000);
    assert.ok(shape && typeof shape.reinforced === 'number', 'memory.shape event present');
    assert.ok(shape.reinforced >= 1, 'at least one fact reinforced');

    // verify fact score increased
    const facts = await (await fetch(`${BASE}/__test/facts?conv_id=${conv_id}`)).json();
    const after = facts.facts.find((x) => x.id === fid);
    assert.ok(after.score >= 0.4, 'score should be >= starting score');
  } finally {
    try {
      child.kill('SIGTERM');
    } catch {}
    await new Promise((r) => child.on('exit', r));
  }
});
