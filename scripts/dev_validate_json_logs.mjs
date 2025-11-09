import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';

function startService(env = {}) {
  const script = path.join(process.cwd(), 'scripts', 'service.js');
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d.toString(); });
  child.stderr.on('data', (d) => { logs += d.toString(); });
  return { child, getLogs: () => logs };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const port = 33010 + Math.floor(Math.random() * 1000);
  const { child, getLogs } = startService({ NODE_ENV: 'production', LOG_JSON: '1', PORT: String(port), QUEUE_MAX: '3' });
  await sleep(300);
  const lines = getLogs().trim().split(/\r?\n/).filter(Boolean);
  let ok = true;
  for (const line of lines) {
    try {
      JSON.parse(line);
      process.stdout.write(`[OK] ${line}\n`);
    } catch (e) {
      ok = false;
      process.stdout.write(`[BAD] ${line}\n`);
    }
  }
  try { child.kill('SIGTERM'); } catch {}
  await new Promise((r) => child.on('exit', r));
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => { console.error('diagnostic_error', e && e.stack || e); process.exitCode = 1; });

