import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import http from 'node:http';
import { waitForUp } from '../tests/helpers/wait_for_up.mjs';

function startService(env = {}) {
  const script = path.join(process.cwd(), 'scripts', 'service.js');
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d.toString(); });
  child.stderr.on('data', (d) => { logs += d.toString(); });
  return { child, getLogs: () => logs };
}

function postJson(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const h = { 'Content-Type': 'application/json', ...headers };
    const req = http.request(url, { method: 'POST', headers: h }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

function getStream(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', headers }, (res) => {
      let buf = '';
      let final = null;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const lines = block.split(/\r?\n/);
          let evt = 'message';
          let data = '';
          for (const line of lines) {
            if (line.startsWith('event:')) evt = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (evt === 'end') {
            try { const j = JSON.parse(data); final = j?.final ?? j; } catch { final = data; }
          }
        }
      });
      res.on('end', () => resolve({ status: res.statusCode, final }));
    });
    req.on('error', reject);
    req.end();
  });
}

function hmac(secret, input) {
  return crypto.createHmac('sha256', secret).update(input).digest('hex');
}

function fail(msg) {
  process.stderr.write(String(msg) + '\n');
  process.exitCode = 1;
}

async function main() {
  const port = 48000 + Math.floor(Math.random() * 1000);
  const base = `http://localhost:${port}`;
  const secret = 'verify-secret';
  const token = 'verify-token';
  const env = {
    NODE_ENV: 'production',
    LOG_JSON: '1',
    PORT: String(port),
    LLM_TEST_STUBS: '1',
    URGA_PROVIDER: 'stub-urga',
    ECHO_PROVIDER: 'stub-echo',
    DREAMS_PROVIDER: 'stub-dreams',
    CONV_AUTH: token,
    CORS_ALLOWLIST: 'http://allowed.test',
    // Disable replay window so we can use ts=0 for stable hashing
    REPLAY_WINDOW_MS: '0',
    REPLAY_SKEW_TOLERANCE_MS: '2500'
  };
  const { child, getLogs } = startService(env);
  await waitForUp(base, { timeout: 8000 }).catch(async () => {
    try { child.kill('SIGTERM'); } catch {}
    fail('Service did not become ready. Logs:\n' + getLogs());
  });

  const goldenPath = path.join(process.cwd(), 'scripts', 'determinism', 'golden_snapshots.json');
  let golden;
  try { golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8')); } catch (e) {
    fail('Failed to read golden snapshots: ' + e.message);
    try { child.kill('SIGTERM'); } catch {}
    return;
  }
  const convs = Array.isArray(golden?.convs) ? golden.convs : [];
  if (convs.length === 0) {
    fail('No canonical conversations found in golden_snapshots.json');
    try { child.kill('SIGTERM'); } catch {}
    return;
  }

  for (const c of convs) {
    const { name, spec, compile: expCompile, message: expMessage, stream: expStream } = c;
    const { text, engine, persona_v, prompt_v } = spec || {};
    // Use stable timestamp to match frozen golden snapshots
    const ts = 0;
    const origin = 'http://allowed.test';

    // Compile
    const compReq = { messages: [{ role: 'user', content: [text], turn: 0 }], ...(persona_v ? { persona_v } : {}), ...(prompt_v ? { prompt_v } : {}) };
    const comp = await postJson(`${base}/conv/compile`, compReq, { origin, authorization: `Bearer ${token}` });
    if (comp.status !== 200) {
      fail(`[${name}] compile failed status=${comp.status} body=${comp.text}`);
      break;
    }
    if (comp.json?.hash !== expCompile?.hash) {
      fail(`[${name}] compile hash drift: expected=${expCompile?.hash} actual=${comp.json?.hash}`);
      break;
    }
    if (comp.json?.bytes_b64 !== expCompile?.bytes_b64) {
      fail(`[${name}] compile bytes drift`);
      break;
    }

    // Message
    // Match service-side hashing defaults: conv_id='conv', id='conv:0:user', ts=0
    // Use unique conv_id per case to avoid per-conversation soft rate limits; keep stable id/turn/ts
    const msgReq = { text, conv_id: `conv-${name}`, id: 'conv:0:user', turn: 0, ts, engine, ...(persona_v ? { persona_v } : {}), ...(prompt_v ? { prompt_v } : {}) };
    const msg = await postJson(`${base}/conv/message`, msgReq, { origin, authorization: `Bearer ${token}` });
    if (msg.status !== 200) {
      fail(`[${name}] message failed status=${msg.status} body=${msg.text}`);
      break;
    }
    if (msg.json?.hash !== expMessage?.hash) {
      fail(`[${name}] message hash drift on turn 0: expected=${expMessage?.hash} actual=${msg.json?.hash}`);
      break;
    }
    if (msg.json?.bytes_b64 && expMessage?.bytes_b64 && msg.json.bytes_b64 !== expMessage.bytes_b64) {
      fail(`[${name}] message bytes drift on turn 0`);
      break;
    }

    // Stream
    // Use a unique conv_id per case to avoid idempotent replay collisions
    const q = `text=${encodeURIComponent(text)}&conv_id=${encodeURIComponent(`conv-${name}`)}&turn=0&engine=${encodeURIComponent(engine)}&ts=${ts}`;
    const stream = await getStream(`${base}/conv/stream?${q}`, { origin, authorization: `Bearer ${token}` });
    if (stream.status !== 200) {
      fail(`[${name}] stream failed status=${stream.status}`);
      break;
    }
    if (stream.final !== expStream?.final) {
      fail(`[${name}] stream final drift on turn 0: expected=${expStream?.final} actual=${stream.final}`);
      break;
    }
  }

  try { child.kill('SIGTERM'); } catch {}
  await new Promise((r) => child.on('exit', r));

  if (process.exitCode && process.exitCode !== 0) {
    process.stderr.write('Determinism verification FAILED.\n');
    process.exit(process.exitCode);
    return;
  }
  process.stdout.write('Determinism verification PASSED for all golden transcripts.\n');
}

main().catch((e) => { fail(e?.stack || e?.message || String(e)); });
