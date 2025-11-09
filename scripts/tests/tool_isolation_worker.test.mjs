import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { spawn } from 'node:child_process';

function runWorkerEnv(env, opts = {}) {
  const script = path.join(process.cwd(), 'scripts', 'tool_isolation_worker.mjs');
  const memMb = Number(opts.memoryMb || 64);
  const child = spawn(process.execPath, [`--max-old-space-size=${memMb}`, script], {
    env: { ...process.env, ...env },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    stdout += d.toString();
  });
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });
  return new Promise((resolve) => {
    const to = setTimeout(
      () => {
        try {
          child.kill('SIGKILL');
        } catch {}
        resolve({ code: -1, stdout, stderr, timeout: true });
      },
      Math.max(500, Number(env.TOOL_TIMEOUT_MS || 2000))
    );
    child.on('exit', (code) => {
      clearTimeout(to);
      resolve({ code, stdout, stderr });
    });
  });
}

function tmpBase() {
  return path.join(
    os.tmpdir(),
    `trae_tool_iso_${process.pid}_${Math.floor(Math.random() * 10000)}`
  );
}

function toolDonePath(dir, id) {
  const encoded = encodeURIComponent(String(id));
  return path.join(dir, `${encoded}.done`);
}

test('Tool isolation worker: allows FS writes only within allowlist', async () => {
  const base = tmpBase();
  const dir = path.join(base, 'urga_tool');
  const id = 'iso-allow-1';
  const env = {
    TOOL_OP: 'mark',
    TOOL_ID: id,
    TOOL_DIR: dir,
    TOOL_FS_ALLOWLIST: JSON.stringify([dir]),
    TOOL_FAIL_CLOSED: '1',
  };
  const r = await runWorkerEnv(env);
  assert.equal(r.code, 0, `worker exited OK: ${r.stderr}`);
  const p = toolDonePath(dir, id);
  const st = fs.statSync(p);
  assert.ok(st.isFile());
});

test('Tool isolation worker: denies FS writes outside allowlist (fail-closed)', async () => {
  const base = tmpBase();
  const dir = path.join(base, 'urga_tool');
  const id = 'iso-deny-1';
  const env = {
    TOOL_OP: 'mark',
    TOOL_ID: id,
    TOOL_DIR: dir,
    TOOL_FS_ALLOWLIST: JSON.stringify([path.join(base, 'other_dir')]),
    TOOL_FAIL_CLOSED: '1',
  };
  const r = await runWorkerEnv(env);
  assert.notEqual(r.code, 0, 'worker should fail-closed');
  const p = toolDonePath(dir, id);
  assert.equal(fs.existsSync(p), false, 'marker file not created outside allowlist');
});

test('Tool isolation worker: denies network access when host not allowlisted', async () => {
  const env = {
    TOOL_OP: 'net_probe',
    TOOL_NET_PROBE: 'http://example.com/',
    TOOL_NET_ALLOWLIST: '',
    TOOL_FAIL_CLOSED: '1',
  };
  const r = await runWorkerEnv(env);
  assert.notEqual(r.code, 0, 'network denied without allowlist');
});
