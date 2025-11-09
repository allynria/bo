import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import http from 'node:http';

function onceServerReady(port) {
  return new Promise((resolve) => {
    const t = setInterval(() => {
      http
        .get({ host: '127.0.0.1', port, path: '/healthz' }, (res) => {
          if (res.statusCode === 200) {
            clearInterval(t);
            resolve();
          }
        })
        .on('error', () => {});
    }, 100);
  });
}

async function getJSON(port, path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path }, (res) => {
        let data = '';
        res.on('data', (d) => (data += String(d)));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

const PORT = 4719;

async function main() {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    LLM_TEST_STUBS: '1',
    URGA_PROVIDER: 'stub-urga',
    CONV_AUTH: 't',
    CORS_ALLOWLIST: '',
    MEMORY_ENABLED: '1',
    MEMORY_INJECT_BUDGET_TOKENS: '60',
  };
  const ps = spawn(process.execPath, ['scripts/service.js'], { env, stdio: 'inherit' });
  await onceServerReady(PORT);

  const q = (params) => '/memory/preview?' + new URLSearchParams(params).toString();

  // simulate: ensure inject_tokens <= budget
  const convId = 'conv-mem-budget';
  const j = await getJSON(
    PORT,
    q({
      conv_id: convId,
      text: 'We made a solemn promise on the bridge, under rain.',
      model: 'o200k_base',
      turn: '4',
      token: 't',
    })
  );
  assert.equal(j.ok, true);
  assert.ok(j.simulate.inject_tokens <= j.simulate.budget_tokens, 'injection exceeds budget');

  ps.kill('SIGINT');
  await delay(50);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
