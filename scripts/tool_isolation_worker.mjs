// Isolated tool worker: enforces per-tool FS and network allowlists with fail-closed policy.
// This script is executed in a separate Node process with memory/time caps controlled by parent.

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { loadToolPolicyFromEnv, lintToolPolicy } from './tool_policy.mjs';
import { AsyncFS } from '../monolith.js';

function parseList(input) {
  if (!input) return [];
  try {
    const j = JSON.parse(input);
    if (Array.isArray(j)) return j.map(String);
  } catch {}
  return String(input).split(',').map(s => s.trim()).filter(Boolean);
}

let FS_ALLOW = parseList(process.env.TOOL_FS_ALLOWLIST || '');
let NET_ALLOW = parseList(process.env.TOOL_NET_ALLOWLIST || '');
const FAIL_CLOSED = String(process.env.TOOL_FAIL_CLOSED || '1').toLowerCase();
const FAIL_CLOSED_ENABLED = FAIL_CLOSED === '1' || FAIL_CLOSED === 'true';
const POLICY_REQUIRED = String(process.env.TOOL_POLICY_REQUIRED || '0').toLowerCase() === '1' || String(process.env.TOOL_POLICY_REQUIRED || '').toLowerCase() === 'true';
const NO_NETWORK_FLAG = process.argv.includes('--no-network') || String(process.env.TOOL_NO_NETWORK || '0').toLowerCase() === '1' || String(process.env.TOOL_NO_NETWORK || '').toLowerCase() === 'true';

let POLICY = null;

async function initPolicy() {
  try {
    const { policy, lint } = await loadToolPolicyFromEnv();
    if (!policy) {
      if (POLICY_REQUIRED) {
        const err = new Error('policy_missing');
        err.code = 'POLICY_MISSING';
        throw err;
      }
      // no policy loaded; keep env defaults
      return;
    }
    // If policy exists, honor it
    POLICY = policy;
    const fsList = Array.isArray(policy?.fs?.allow) ? policy.fs.allow : [];
    const netList = Array.isArray(policy?.net?.allow) ? policy.net.allow : [];
    FS_ALLOW = fsList.map(String);
    NET_ALLOW = netList.map(String);
    // Enforce no-network flag if policy net.allow is empty
    if (POLICY_REQUIRED && NET_ALLOW.length === 0 && !NO_NETWORK_FLAG) {
      const err = new Error('no_network_flag_required');
      err.code = 'NO_NETWORK_FLAG_REQUIRED';
      throw err;
    }
    // Apply timeout cap from policy if provided
    const timeoutMs = Number(policy?.limits?.timeout_ms || 0);
    const cap = Number(process.env.TOOL_TIMEOUT_MS || 0);
    const effectiveTimeout = Math.max(timeoutMs || 0, cap || 0);
    if (effectiveTimeout > 0) {
      const timer = setTimeout(() => {
        try { console.error(JSON.stringify({ ok: false, error: 'timeout_cap_exceeded' })); } catch {}
        process.exitCode = 124;
        try { process.exit(124); } catch {}
      }, effectiveTimeout);
      try { timer.unref(); } catch {}
    }
  } catch (e) {
    // Fail closed on policy init errors
    const out = { ok: false, error: String(e && e.message || e), code: e && e.code || undefined };
    try { console.log(JSON.stringify(out)); } catch {}
    process.exitCode = 1;
    throw e; // to stop further initialization
  }
}

function resolveAllowPaths(list) {
  return list.map(p => {
    try { return path.resolve(p); } catch { return p; }
  }).filter(Boolean);
}

let ALLOW_PATHS = resolveAllowPaths(FS_ALLOW);

function isPathAllowed(target) {
  try {
    const abs = path.resolve(target);
    for (const base of ALLOW_PATHS) {
      if (!base) continue;
      // Ensure base is absolute
      const b = path.resolve(base);
      // Windows note: normalize to handle separators consistently
      const normAbs = path.normalize(abs);
      const normBase = path.normalize(b);
      if (normAbs === normBase) return true;
      // Allow any descendant of base
      if (normAbs.startsWith(normBase + path.sep)) return true;
    }
  } catch {}
  return false;
}

function isHostAllowed(urlStr) {
  try {
    const u = new URL(urlStr);
    const hostPort = u.port ? `${u.hostname}:${u.port}` : u.hostname;
    // Exact match on host or host:port
    if (NET_ALLOW.includes(hostPort)) return true;
    if (NET_ALLOW.includes(u.hostname)) return true;
  } catch {}
  return false;
}

// Safe FS wrappers to enforce allowlist (avoid mutating ESM namespace bindings)
const safeFs = {
  async readFile(p, enc) {
    if (FAIL_CLOSED_ENABLED && !isPathAllowed(p)) {
      const err = new Error(`policy_violation: fs.readFile denied for ${String(p)}`);
      err.code = 'POLICY_VIOLATION';
      throw err;
    }
    return await AsyncFS.readFile(p, enc);
  },
  async writeFile(p, data, enc) {
    if (FAIL_CLOSED_ENABLED && !isPathAllowed(p)) {
      const err = new Error(`policy_violation: fs.writeFile denied for ${String(p)}`);
      err.code = 'POLICY_VIOLATION';
      throw err;
    }
    return await AsyncFS.writeFileAtomic(p, data, enc);
  },
  async mkdir(p, opts) {
    if (FAIL_CLOSED_ENABLED && !isPathAllowed(p)) {
      const err = new Error(`policy_violation: fs.mkdir denied for ${String(p)}`);
      err.code = 'POLICY_VIOLATION';
      throw err;
    }
    return await AsyncFS.mkdir(p, opts);
  }
};

// Patch HTTP/HTTPS to enforce host allowlist
function guardNet() {
  const wrapRequest = (mod, modName) => {
    const origReq = mod.request.bind(mod);
    const origGet = mod.get.bind(mod);
    const check = (input) => {
      try {
        let urlStr = '';
        if (typeof input === 'string') urlStr = input;
        else if (typeof input === 'object' && input && input.href) urlStr = String(input.href);
        else if (typeof input === 'object') {
          const { protocol, hostname, port, path: pth } = input;
          urlStr = `${protocol || 'http:'}//${hostname}${port ? ':' + port : ''}${pth || '/'}`;
        }
        if (FAIL_CLOSED_ENABLED && !isHostAllowed(urlStr)) {
          const err = new Error(`policy_violation: ${modName} denied for ${urlStr}`);
          err.code = 'POLICY_VIOLATION';
          throw err;
        }
      } catch (e) {
        throw e;
      }
    };
    mod.request = function(options, cb) { check(options); return origReq(options, cb); };
    mod.get = function(options, cb) { check(options); return origGet(options, cb); };
  };
  try { wrapRequest(http, 'http.request'); wrapRequest(https, 'https.request'); } catch {}
  try {
    if (globalThis.fetch) {
      const origFetch = globalThis.fetch.bind(globalThis);
      globalThis.fetch = async function(resource, init) {
        const urlStr = typeof resource === 'string' ? resource : (resource?.url || '');
        if (FAIL_CLOSED_ENABLED && !isHostAllowed(urlStr)) {
          const err = new Error(`policy_violation: fetch denied for ${urlStr}`);
          err.code = 'POLICY_VIOLATION';
          throw err;
        }
        return await origFetch(resource, init);
      };
    }
  } catch {}
}

// Initialize policy before enabling network guards and FS allow paths
// If policy initialization fails (e.g., missing policy when required, or no-network flag required),
// exit immediately to ensure fail-closed behavior and correct exit code propagation in tests/CI.
try {
  await initPolicy();
} catch {
  try { process.exit(1); } catch {}
}
ALLOW_PATHS = resolveAllowPaths(FS_ALLOW);
guardNet();

async function markTool(id, dir, extra = {}) {
  const encoded = encodeURIComponent(String(id));
  const p = path.join(dir, `${encoded}.done`);
  const tenant = String(extra?.tenant || process.env.TOOL_TENANT || '');
  const tool = String(extra?.tool || process.env.TOOL_NAME || '');
  const payloadObj = { ts: Date.now(), id: String(id || ''), tenant, tool };
  const payload = JSON.stringify(payloadObj);
  // Enforce idempotent op name when policy requires it
  if (POLICY && POLICY.idempotent_op_name && POLICY.idempotent_op_name !== 'mark') {
    const err = new Error('idempotent_op_mismatch');
    err.code = 'IDEMPOTENT_OP_MISMATCH';
    throw err;
  }
  await safeFs.mkdir(dir, { recursive: true }).catch(() => {});
  await safeFs.writeFile(p, payload, 'utf8');
  return { ok: true, path: p };
}

async function netProbe(urlStr) {
  // Simple HEAD request using http/https module
  return await new Promise((resolve, reject) => {
    try {
      const u = new URL(urlStr);
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request({ method: 'HEAD', hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname || '/', protocol: u.protocol }, (res) => {
        try { res.resume(); } catch {}
        resolve({ ok: true, statusCode: res.statusCode });
      });
      req.on('error', (e) => {
        const retryable = ['ETIMEDOUT','EAI_AGAIN','ECONNRESET'].includes(String(e?.code || ''));
        reject(Object.assign(new Error(String(e?.message || e)), { code: e?.code, retryable }));
      });
      req.setTimeout(Math.max(1000, Number(process.env.TOOL_NET_TIMEOUT_MS || 3000)), () => {
        try { req.destroy(new Error('timeout')); } catch {}
      });
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

// Fetch URL (GET) and report statusCode and bytes received; obey network allowlist via patched http/https
async function fetchUrl(urlStr) {
  return await new Promise((resolve, reject) => {
    try {
      const u = new URL(urlStr);
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request({ method: 'GET', hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname || '/', protocol: u.protocol }, (res) => {
        let bytes = 0;
        try {
          res.on('data', (chunk) => { bytes += (chunk?.length || 0); });
          res.on('end', () => { resolve({ ok: true, statusCode: res.statusCode, bytes }); });
        } catch (e) {
          resolve({ ok: true, statusCode: res.statusCode, bytes });
        }
      });
      req.on('error', (e) => {
        const retryable = ['ETIMEDOUT','EAI_AGAIN','ECONNRESET'].includes(String(e?.code || ''));
        reject(Object.assign(new Error(String(e?.message || e)), { code: e?.code, retryable }));
      });
      req.setTimeout(Math.max(1000, Number(process.env.TOOL_NET_TIMEOUT_MS || 3000)), () => {
        try { req.destroy(new Error('timeout')); } catch {}
      });
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

// POST JSON to URL and report statusCode and bytes
async function postJson(urlStr, bodyStr) {
  return await new Promise((resolve, reject) => {
    try {
      const u = new URL(urlStr);
      const mod = u.protocol === 'https:' ? https : http;
      const data = Buffer.from(String(bodyStr || ''), 'utf8');
      const req = mod.request({
        method: 'POST',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname || '/',
        protocol: u.protocol,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length
        }
      }, (res) => {
        let bytes = 0;
        try {
          res.on('data', (chunk) => { bytes += (chunk?.length || 0); });
          res.on('end', () => { resolve({ ok: true, statusCode: res.statusCode, bytes }); });
        } catch (e) {
          resolve({ ok: true, statusCode: res.statusCode, bytes });
        }
      });
      req.on('error', (e) => {
        const retryable = ['ETIMEDOUT','EAI_AGAIN','ECONNRESET'].includes(String(e?.code || ''));
        reject(Object.assign(new Error(String(e?.message || e)), { code: e?.code, retryable }));
      });
      req.setTimeout(Math.max(1000, Number(process.env.TOOL_NET_TIMEOUT_MS || 3000)), () => {
        try { req.destroy(new Error('timeout')); } catch {}
      });
      req.write(data);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

// Read file and return base64 content
async function readFileB64(p) {
  const buf = await safeFs.readFile(p);
  return { ok: true, bytes: buf.length, content_b64: buf.toString('base64') };
}

// Write file from base64 content
async function writeFileB64(p, b64) {
  const buf = Buffer.from(String(b64 || ''), 'base64');
  await safeFs.mkdir(path.dirname(p), { recursive: true }).catch(() => {});
  await safeFs.writeFile(p, buf);
  return { ok: true, bytes: buf.length };
}

// Read JSON file and parse
async function readJson(p) {
  const buf = await safeFs.readFile(p, 'utf8');
  try {
    const obj = JSON.parse(buf);
    return { ok: true, bytes: Buffer.byteLength(buf, 'utf8'), data: obj };
  } catch (e) {
    const err = new Error('json_parse_error');
    err.code = 'JSON_PARSE';
    throw err;
  }
}

async function main() {
  const op = String(process.env.TOOL_OP || 'mark');
  try {
    if (op === 'mark') {
      const id = String(process.env.TOOL_ID || '');
      const dir = String(process.env.TOOL_DIR || '');
      const tenant = String(process.env.TOOL_TENANT || '');
      const tool = String(process.env.TOOL_NAME || '');
      if (!id || !dir) throw new Error('missing TOOL_ID or TOOL_DIR');
      const result = await markTool(id, dir, { tenant, tool });
      console.log(JSON.stringify(result));
      process.exitCode = 0;
      return;
    }
    if (op === 'net_probe') {
      const urlStr = String(process.env.TOOL_NET_PROBE || '');
      if (!urlStr) throw new Error('missing TOOL_NET_PROBE');
      const result = await netProbe(urlStr).catch((e) => { throw e; });
      console.log(JSON.stringify(result));
      process.exitCode = 0;
      return;
    }
    if (op === 'fetch_url') {
      const urlStr = String(process.env.TOOL_FETCH_URL || '');
      if (!urlStr) throw new Error('missing TOOL_FETCH_URL');
      const result = await fetchUrl(urlStr).catch((e) => { throw e; });
      console.log(JSON.stringify(result));
      process.exitCode = 0;
      return;
    }
    if (op === 'post_json') {
      const urlStr = String(process.env.TOOL_POST_URL || '');
      const bodyStr = String(process.env.TOOL_POST_BODY_JSON || '');
      if (!urlStr) throw new Error('missing TOOL_POST_URL');
      const result = await postJson(urlStr, bodyStr).catch((e) => { throw e; });
      console.log(JSON.stringify(result));
      process.exitCode = 0;
      return;
    }
    if (op === 'read_file') {
      const p = String(process.env.TOOL_READ_PATH || '');
      if (!p) throw new Error('missing TOOL_READ_PATH');
      const result = await readFileB64(p).catch((e) => { throw e; });
      console.log(JSON.stringify(result));
      process.exitCode = 0;
      return;
    }
    if (op === 'write_file') {
      const p = String(process.env.TOOL_WRITE_PATH || '');
      const b64 = String(process.env.TOOL_WRITE_CONTENT_B64 || '');
      if (!p) throw new Error('missing TOOL_WRITE_PATH');
      const result = await writeFileB64(p, b64).catch((e) => { throw e; });
      console.log(JSON.stringify(result));
      process.exitCode = 0;
      return;
    }
    if (op === 'read_json') {
      const p = String(process.env.TOOL_READ_JSON_PATH || '');
      if (!p) throw new Error('missing TOOL_READ_JSON_PATH');
      const result = await readJson(p).catch((e) => { throw e; });
      console.log(JSON.stringify(result));
      process.exitCode = 0;
      return;
    }
    throw new Error(`unknown TOOL_OP: ${op}`);
  } catch (e) {
    const out = { ok: false, error: String(e && e.message || e), code: e && e.code || undefined, retryable: Boolean(e && e.retryable) };
    try { console.log(JSON.stringify(out)); } catch {}
    process.exitCode = 1;
  }
}

main();
