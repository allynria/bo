import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';

const monolith = await import('../../monolith.js');
const { AsyncFS } = monolith;

function tmpdir(name = 'fs-preserve') {
  const dir = path.join(os.tmpdir(), `${name}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('writeFileAtomic: preserves existing file mode when supported', async () => {
  const dir = tmpdir('preserve-mode');
  const p = path.join(dir, 'f.txt');
  await fsp.writeFile(p, 'orig', 'utf8');
  try {
    await fsp.chmod(p, 0o640);
  } catch {}
  const before = await fsp.stat(p);
  const supportsPosixModes = (before.mode & 0o777) === 0o640;

  await AsyncFS.writeFileAtomic(p, 'new', 'utf8');
  const after = await fsp.stat(p);
  const content = await fsp.readFile(p, 'utf8');

  if (supportsPosixModes) {
    assert.equal(after.mode & 0o777, 0o640, 'mode should be preserved');
  }
  assert.equal(String(content), 'new');
});

test('writeFileAtomic: accepts stream input and writes contents', async () => {
  const dir = tmpdir('stream');
  const src = path.join(dir, 'src.txt');
  const dst = path.join(dir, 'dst.txt');
  const expected = 'stream-content-xyz';
  await fsp.writeFile(src, expected, 'utf8');
  const rs = fs.createReadStream(src);
  await AsyncFS.writeFileAtomic(dst, rs);
  const got = await fsp.readFile(dst, 'utf8');
  assert.equal(String(got), expected);
});

async function runProbe(level) {
  return await new Promise((resolve, reject) => {
    const cp = spawn(process.execPath, ['scripts/tests/helpers/log_probe.mjs'], {
      env: { ...process.env, LOG_LEVEL: level },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    cp.stdout.on('data', (d) => {
      out += d;
    });
    cp.on('error', reject);
    cp.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`probe exited ${code}`));
      try {
        resolve(JSON.parse(out.trim()));
      } catch (e) {
        reject(e);
      }
    });
  });
}

test('logAt gating: DEBUG emits all levels', async () => {
  const res = await runProbe('DEBUG');
  assert.equal(res.debug > 0, true);
  assert.equal(res.info > 0, true);
  assert.equal(res.warn > 0, true);
  assert.equal(res.error > 0, true);
});

test('logAt gating: INFO suppresses DEBUG only', async () => {
  const res = await runProbe('INFO');
  assert.equal(res.debug, 0);
  assert.equal(res.info > 0, true);
  assert.equal(res.warn > 0, true);
  assert.equal(res.error > 0, true);
});

test('logAt gating: WARN emits warn and error', async () => {
  const res = await runProbe('WARN');
  assert.equal(res.debug, 0);
  assert.equal(res.info, 0);
  assert.equal(res.warn > 0, true);
  assert.equal(res.error > 0, true);
});

test('logAt gating: ERROR emits only error', async () => {
  const res = await runProbe('ERROR');
  assert.equal(res.debug, 0);
  assert.equal(res.info, 0);
  assert.equal(res.warn, 0);
  assert.equal(res.error > 0, true);
});
