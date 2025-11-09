import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function runProbe(scriptPath) {
  return new Promise((resolveRun) => {
    const full = resolve(__dirname, '..', scriptPath);
    const child = spawn(process.execPath, [full], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => {
      resolveRun({ code, stdout, stderr });
    });
  });
}

function tryParseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    // try to locate last JSON-looking fragment
    const i = s.lastIndexOf('{');
    if (i >= 0) {
      const frag = s.slice(i);
      try {
        return JSON.parse(frag);
      } catch {
        /* ignore */
      }
    }
    return null;
  }
}

function printFailureOnly(tag, payload) {
  if (!payload) {
    console.error(`${tag}: failed but no JSON payload available`);
    return;
  }
  if (tag === 'env' || tag === 'env_ab') {
    const fails = Array.isArray(payload.results)
      ? payload.results.filter((r) => r && r.pass === false)
      : [];
    if (!fails.length) {
      console.error(`${tag}: failed without detailed cases`);
      return;
    }
    for (const r of fails) {
      console.error(
        JSON.stringify({
          case: r.case,
          provider: r.provider,
          expected_provider: r.expected_provider,
          model: r.model,
          expected_model: r.expected_model,
        })
      );
    }
  } else if (tag === 'stream') {
    const reason = payload.reason || 'streaming assertions failed';
    console.error(JSON.stringify({ reason, result: payload.result }));
  } else {
    console.error(JSON.stringify(payload));
  }
}

async function main() {
  const stream = await runProbe('scripts/dev_probe_dreams_stream.mjs');
  const env = await runProbe('scripts/dev_probe_provider_env.mjs');
  const envAb = await runProbe('scripts/dev_probe_provider_env_ab.mjs');

  const streamJson =
    stream.code === 0
      ? tryParseJson(stream.stdout)
      : tryParseJson(stream.stderr) || tryParseJson(stream.stdout);
  const envJson =
    env.code === 0
      ? tryParseJson(env.stdout)
      : tryParseJson(env.stderr) || tryParseJson(env.stdout);
  const envAbJson =
    envAb.code === 0
      ? tryParseJson(envAb.stdout)
      : tryParseJson(envAb.stderr) || tryParseJson(envAb.stdout);

  let failed = false;
  if (stream.code !== 0) {
    failed = true;
    printFailureOnly('stream', streamJson);
  }
  if (env.code !== 0) {
    failed = true;
    printFailureOnly('env', envJson);
  }
  if (envAb.code !== 0) {
    failed = true;
    printFailureOnly('env_ab', envAbJson);
  }

  if (failed) {
    process.exitCode = 1;
    return;
  }
  // concise pass output
  console.log(JSON.stringify({ ok: true, probes: { stream: true, env: true, env_ab: true } }));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
  process.exitCode = 1;
});
