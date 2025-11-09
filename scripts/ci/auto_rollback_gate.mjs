import http from 'node:http';
import { spawn } from 'node:child_process';

function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c.toString(); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(text) }); }
        catch (e) { resolve({ status: res.statusCode, json: null, text }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function countCounters(metrics, name, labels = {}) {
  if (!metrics || !Array.isArray(metrics.counters)) return 0;
  return metrics.counters
    .filter((c) => c.name === name)
    .filter((c) => {
      const l = c.labels || {};
      return Object.entries(labels).every(([k, v]) => String(l[k] || '') === String(v));
    })
    .reduce((acc, c) => acc + Number(c.count || 0), 0);
}

async function main() {
  const port = Number(process.env.PORT || 3000);
  const base = process.env.METRICS_URL || `http://localhost:${port}/metrics`;
  const token = process.env.METRICS_AUTH || '';
  const headers = token ? { authorization: `Bearer ${token}` } : {};

  const MAX_NON_JSON = Number(process.env.MAX_NON_JSON_LOGS || 0);
  const MAX_5XX = Number(process.env.MAX_5XX || 0);
  const MAX_BACKPRESSURE = Number(process.env.MAX_BACKPRESSURE || 0);
  const MAX_BUDGET_DENIALS = Number(process.env.MAX_BUDGET_DENIALS || 0);

  const r = await fetchJson(base, headers);
  if (r.status !== 200 || !r.json) {
    console.error('AUTO_ROLLBACK_TRIGGER: metrics unavailable', { status: r.status });
    process.exit(1);
    return;
  }
  const m = r.json;

  const nonJson = countCounters(m, 'non_json_log_total');
  const fivexx = countCounters(m, 'responses_total', { status: '500' });
  const backpressure = countCounters(m, 'rate_limited_total', { reason: 'backpressure' });
  const budgetDenied = countCounters(m, 'budget_prevented_total');

  const failures = [];
  if (nonJson > MAX_NON_JSON) failures.push(`non_json_log_total=${nonJson} > ${MAX_NON_JSON}`);
  if (fivexx > MAX_5XX) failures.push(`responses_total{status=500}=${fivexx} > ${MAX_5XX}`);
  if (backpressure > MAX_BACKPRESSURE) failures.push(`rate_limited_total{reason=backpressure}=${backpressure} > ${MAX_BACKPRESSURE}`);
  if (budgetDenied > MAX_BUDGET_DENIALS) failures.push(`budget_prevented_total=${budgetDenied} > ${MAX_BUDGET_DENIALS}`);

  // Optional soak/run gate for p99 regression
  if (process.env.RUN_SOAK === '1') {
    await new Promise((resolve) => {
      const child = spawn(process.execPath, ['scripts/soak_budget_gate.mjs'], { env: process.env, stdio: ['ignore', 'inherit', 'inherit'] });
      child.on('exit', (code) => {
        if (code !== 0) failures.push('soak_budget_gate failed');
        resolve();
      });
    });
  }

  if (failures.length > 0) {
    console.error('AUTO_ROLLBACK_TRIGGER:', failures.join('; '));
    process.exit(1);
    return;
  }

  console.log('AUTO_ROLLBACK_GATE_PASSED');
}

main().catch((e) => { console.error('AUTO_ROLLBACK_TRIGGER: script error', e); process.exit(1); });

