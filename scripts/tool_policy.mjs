// Tool policy loader and linting utilities
// Policy JSON schema (v1):
// {
//   "version": 1,
//   "tool": "name",
//   "idempotent_op_name": "mark", // optional
//   "fs": { "allow": ["/abs/path1", "/abs/path2"] },
//   "net": { "allow": ["host", "host:port"] },
//   "limits": { "memory_mb": 64, "timeout_ms": 2000 }
// }

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

export function lintToolPolicy(policy) {
  const errors = [];
  if (!policy || typeof policy !== 'object') {
    errors.push('policy_missing_or_not_object');
    return { ok: false, errors };
  }
  const v = policy.version;
  if (v !== 1) errors.push('version_invalid_or_missing');
  if (typeof policy.tool !== 'string' || policy.tool.length === 0) errors.push('tool_missing');
  if (policy.idempotent_op_name && typeof policy.idempotent_op_name !== 'string') errors.push('idempotent_op_name_must_be_string');
  const fsAllow = policy?.fs?.allow;
  if (!Array.isArray(fsAllow)) errors.push('fs.allow_missing_or_not_array');
  else if (fsAllow.some((p) => typeof p !== 'string' || p.length === 0)) errors.push('fs.allow_entries_must_be_strings');
  const netAllow = policy?.net?.allow;
  if (!Array.isArray(netAllow)) errors.push('net.allow_missing_or_not_array');
  else if (netAllow.some((h) => typeof h !== 'string' || h.length === 0)) errors.push('net.allow_entries_must_be_strings');
  const lim = policy?.limits || {};
  if (lim.memory_mb !== undefined && (!Number.isFinite(lim.memory_mb) || lim.memory_mb <= 0)) errors.push('limits.memory_mb_invalid');
  if (lim.timeout_ms !== undefined && (!Number.isFinite(lim.timeout_ms) || lim.timeout_ms < 1)) errors.push('limits.timeout_ms_invalid');
  return { ok: errors.length === 0, errors };
}

export async function loadToolPolicyFromEnv() {
  const name = String(process.env.TOOL_NAME || '').trim();
  const jsonStr = String(process.env.TOOL_POLICY_JSON || '').trim();
  const policyPath = String(process.env.TOOL_POLICY_PATH || '').trim();
  const policyDir = String(process.env.TOOL_POLICY_DIR || '').trim();
  let obj = null;
  if (jsonStr) {
    try { obj = JSON.parse(jsonStr); } catch {}
  }
  if (!obj && policyPath) {
    try {
      const p = path.resolve(policyPath);
      const raw = await fsp.readFile(p, 'utf8');
      obj = JSON.parse(raw);
    } catch {}
  }
  if (!obj && policyDir && name) {
    const candidates = [
      path.join(policyDir, `${name}.policy.json`),
      path.join(policyDir, `${name}.json`)
    ];
    for (const p of candidates) {
      try {
        const raw = await fsp.readFile(p, 'utf8');
        obj = JSON.parse(raw);
        break;
      } catch {}
    }
  }
  if (!obj) return { policy: null, lint: { ok: false, errors: ['policy_not_found'] } };
  const lint = lintToolPolicy(obj);
  return { policy: obj, lint };
}

