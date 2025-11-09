import { setTimeout as sleep } from 'node:timers/promises';
import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';

async function probeRecovery({ url, timeoutMin = 5, backoffMs = 1000, authToken = '' }) {
  if (!url) throw new Error('RECOVERY_URL is required');
  const deadline = Date.now() + Math.max(60_000, timeoutMin * 60_000);
  const client = url.startsWith('https:') ? https : http;
  let lastErr = null;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts++;
    const ok = await new Promise((resolve) => {
      const u = new URL(url);
      const req = client.request(
        {
          method: 'GET',
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname + (u.search || ''),
          headers: authToken ? { authorization: `Bearer ${authToken}` } : {},
        },
        (res) => {
          // Accept 200 as healthy; optionally allow 503 to transition
          const healthy = res.statusCode === 200;
          res.resume();
          resolve(healthy);
        }
      );
      req.on('error', () => resolve(false));
      req.end();
    });
    if (ok) {
      const elapsed = Date.now() + backoffMs - (deadline - Math.max(60_000, timeoutMin * 60_000));
      console.log(`RECOVERY_OK in ~${elapsed}ms after ${attempts} attempts`);
      return true;
    }
    await sleep(backoffMs);
  }
  console.error('RECOVERY_FAIL: service did not return to healthy state within timeout');
  if (lastErr) console.error(lastErr);
  return false;
}

async function triggerRollback() {
  const mode = String(process.env.ROLLBACK_MODE || '').toLowerCase();
  if (String(process.env.DRY_RUN || 'false').toLowerCase() === 'true') {
    console.log('ROLLBACK_DRY_RUN: simulating rollback');
    await sleep(2000);
    return true;
  }
  if (mode === 'webhook') {
    const url = String(process.env.ORCH_WEBHOOK_URL || '');
    if (!url) throw new Error('ORCH_WEBHOOK_URL required for webhook rollback');
    const token = String(process.env.ORCH_WEBHOOK_TOKEN || '');
    const payload = String(process.env.ORCH_WEBHOOK_PAYLOAD || '{}');
    await new Promise((resolve, reject) => {
      const u = new URL(url);
      const client = u.protocol === 'https:' ? https : http;
      const req = client.request(
        {
          method: 'POST',
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname + (u.search || ''),
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
        },
        (res) => {
          res.resume();
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve();
          else reject(new Error(`webhook rollback failed with status ${res.statusCode}`));
        }
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
    return true;
  }
  if (mode === 'k8s') {
    const ns = String(process.env.ORCH_K8S_NAMESPACE || 'default');
    const deploy = String(process.env.ORCH_K8S_DEPLOYMENT || 'service');
    const args = ['rollout', 'undo', `deployment/${deploy}`, '-n', ns];
    const ok = await new Promise((resolve) => {
      const child = spawn('kubectl', args, { stdio: ['ignore', 'inherit', 'inherit'] });
      child.on('exit', (code) => resolve(code === 0));
    });
    if (!ok) throw new Error('kubectl rollout undo failed');
    return true;
  }
  if (mode === 'argo') {
    const app = String(process.env.ORCH_ARGO_APP || 'service');
    const rev = String(process.env.ORCH_ARGO_REVISION || '').trim();
    let args = rev ? ['app', 'rollback', app, rev] : ['app', 'sync', app];
    const ok = await new Promise((resolve) => {
      const child = spawn('argocd', args, { stdio: ['ignore', 'inherit', 'inherit'] });
      child.on('exit', (code) => resolve(code === 0));
    });
    if (!ok) throw new Error('argocd rollback/sync failed');
    return true;
  }
  if (mode === 'cmd') {
    const cmd = String(process.env.ORCH_ROLLBACK_CMD || '').trim();
    if (!cmd) throw new Error('ORCH_ROLLBACK_CMD required for cmd mode');
    const ok = await new Promise((resolve) => {
      const child = spawn(cmd, { shell: true, stdio: ['ignore', 'inherit', 'inherit'] });
      child.on('exit', (code) => resolve(code === 0));
    });
    if (!ok) throw new Error('rollback command failed');
    return true;
  }
  throw new Error('ROLLBACK_MODE must be one of: webhook|k8s|argo|cmd, or set DRY_RUN=true');
}

async function main() {
  const ok = await triggerRollback().catch((e) => {
    console.error('ROLLBACK_TRIGGER_ERROR', (e && e.stack) || e);
    return false;
  });
  if (!ok) process.exit(2);
  const url = String(process.env.RECOVERY_URL || '');
  const timeoutMin = Number(process.env.RECOVERY_TIMEOUT_MINUTES || 5);
  const backoffMs = Number(process.env.RECOVERY_BACKOFF_MS || 1000);
  const authToken = String(process.env.RECOVERY_AUTH_TOKEN || '');
  const recovered = await probeRecovery({ url, timeoutMin, backoffMs, authToken }).catch((e) => {
    console.error('RECOVERY_PROBE_ERROR', (e && e.stack) || e);
    return false;
  });
  if (!recovered) process.exit(1);
}

main().catch((e) => {
  console.error('ROLLBACK_ERROR', e);
  process.exit(1);
});
