import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = process.env.PORT || '3329';
const BASE = `http://127.0.0.1:${PORT}`;

async function startService() {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT,
    LLM_TEST_STUBS: '1',
    URGA_PROVIDER: 'stub-urga', // deterministic short lines
    CONV_AUTH: 'test-token',
    CORS_ALLOWLIST: ' `http://ok.test` ',
    // phrase decay knobs: make it trigger quickly in test
    PHRASE_DECAY_ENABLED: '1',
    PHRASE_DECAY_NGRAM: '2',
    PHRASE_DECAY_MIN_LEN: '6',
    PHRASE_DECAY_THRESHOLD: '2',
    PHRASE_DECAY_DECAY_MS: '60000',
    PHRASE_DECAY_COOLDOWN_MS: '600000',
    PHRASE_DECAY_MAX: '3',
  };
  const child = spawn(process.execPath, ['scripts/service.js'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((r) => setTimeout(r, 700));
  return child;
}

function sseOnce(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}${path}`, { method: 'GET', headers }, (res) => {
      let buf = '';
      res.on('data', (d) => {
        buf += d.toString('utf8');
        const idx = buf.indexOf('event: loop.phrase.plan');
        if (idx >= 0) {
          const slice = buf.slice(idx);
          const endIdx = slice.indexOf('\n\n');
          if (endIdx >= 0 && slice.slice(0, endIdx).includes('data: ')) {
            resolve(buf);
          }
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

test('phrase decay plans a cooldown and emits hashed items', async () => {
  const svc = await startService();
  try {
    const common = encodeURIComponent('She smiles softly, watching the rain.');
    // Prime the conv with two similar outputs by calling stream twice
    const url1 = `/v1/conv/stream?conv_id=PDC1&turn=0&engine=urga&text=${common}&ts=${Date.now()}`;
    await sseOnce(url1, {
      origin: ' `http://ok.test` ',
      authorization: 'Bearer test-token',
      accept: 'text/event-stream',
    });
    const url2 = `/v1/conv/stream?conv_id=PDC1&turn=1&engine=urga&text=${common}&ts=${Date.now() + 1}`;
    const buf = await sseOnce(url2, {
      origin: ' `http://ok.test` ',
      authorization: 'Bearer test-token',
      accept: 'text/event-stream',
    });
    const hasPlan = buf.includes('event: loop.phrase.plan');
    assert.ok(hasPlan, 'expected loop.phrase.plan');
    // ensure hashes, not raw phrases
    const hasHash = /"hash":"[0-9a-f]{12}"/.test(buf);
    assert.ok(hasHash, 'expected hashed items in plan');
  } finally {
    svc.kill('SIGINT');
  }
});
