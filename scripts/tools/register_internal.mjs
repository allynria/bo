import * as path from 'node:path';
import { ToolRegistry, SafeText } from '../../monolith.js';

let __registered = false;

function shouldRegister() {
  const flag = String(process.env.TOOLING_INTERNAL_REGISTER || '').toLowerCase();
  return flag === '1' || flag === 'true';
}

function getFsRoot() {
  const root = String(process.env.TOOLS_FS_ALLOW_ROOT || '').trim();
  return root || path.join(process.cwd(), 'tmp', 'tools_allow');
}

function hostLabelsFor(urlStr) {
  try {
    const u = new URL(urlStr);
    const hp = u.port ? `${u.hostname}:${u.port}` : u.hostname;
    return [hp, u.hostname];
  } catch {
    return [];
  }
}

export function registerInternalTools() {
  if (__registered) return;
  if (!shouldRegister()) return;
  __registered = true;

  const budgetMs = Math.max(500, Number(process.env.TOOLS_BUDGET_MS || 3000));
  const fsRoot = getFsRoot();

  // GET URL
  ToolRegistry.register({
    name: 'get_url',
    description: 'GET a URL with fail-closed allowlist',
    sandbox: true,
    budget_ms: budgetMs,
    input_json_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    handler: (input) => {
      const url = SafeText.stripDangerous(String(input?.url || ''));
      return {
        op: 'fetch_url',
        args: { url },
        netAllowlist: hostLabelsFor(url),
        netTimeoutMs: Math.max(500, Number(process.env.TOOL_NET_TIMEOUT_MS || 3000)),
        failClosed: true
      };
    }
  });

  // POST JSON
  ToolRegistry.register({
    name: 'post_json',
    description: 'POST JSON body to a URL under allowlist',
    sandbox: true,
    budget_ms: budgetMs,
    input_json_schema: { type: 'object', properties: { url: { type: 'string' }, body: { type: 'object' } }, required: ['url','body'] },
    handler: (input) => {
      const url = SafeText.stripDangerous(String(input?.url || ''));
      const bodyJson = JSON.stringify(input?.body || {});
      return {
        op: 'post_json',
        args: { url, body_json: bodyJson },
        netAllowlist: hostLabelsFor(url),
        netTimeoutMs: Math.max(500, Number(process.env.TOOL_NET_TIMEOUT_MS || 3000)),
        failClosed: true
      };
    }
  });

  // READ JSON file (fail-closed to fsRoot)
  ToolRegistry.register({
    name: 'read_json_file',
    description: 'Read and parse a JSON file under an allowlisted directory',
    sandbox: true,
    budget_ms: budgetMs,
    input_json_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    handler: (input) => {
      const p = SafeText.stripDangerous(String(input?.path || ''));
      return {
        op: 'read_json',
        args: { path: p },
        fsAllowlist: [fsRoot],
        failClosed: true
      };
    }
  });

  // WRITE file (base64 content) under fsRoot
  ToolRegistry.register({
    name: 'write_file_b64',
    description: 'Write a file under an allowlisted directory from base64 content',
    sandbox: true,
    budget_ms: budgetMs,
    input_json_schema: { type: 'object', properties: { path: { type: 'string' }, content_b64: { type: 'string' } }, required: ['path','content_b64'] },
    handler: (input) => {
      const p = SafeText.stripDangerous(String(input?.path || ''));
      const content_b64 = String(input?.content_b64 || '');
      return {
        op: 'write_file',
        args: { path: p, content_b64 },
        fsAllowlist: [fsRoot],
        failClosed: true
      };
    }
  });

  // Network probe (HEAD)
  ToolRegistry.register({
    name: 'net_probe',
    description: 'HEAD probe to a URL to check reachability',
    sandbox: true,
    budget_ms: budgetMs,
    input_json_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    handler: (input) => {
      const url = SafeText.stripDangerous(String(input?.url || ''));
      return {
        op: 'net_probe',
        args: { url },
        netAllowlist: hostLabelsFor(url),
        netTimeoutMs: Math.max(500, Number(process.env.TOOL_NET_TIMEOUT_MS || 3000)),
        failClosed: true
      };
    }
  });

  // Idempotent marker (write .done file) under provided directory
  ToolRegistry.register({
    name: 'mark_tool',
    description: 'Create an idempotent .done marker file under allowlisted directory',
    sandbox: true,
    budget_ms: budgetMs,
    input_json_schema: { type: 'object', properties: { id: { type: 'string' }, dir: { type: 'string' } }, required: ['id','dir'] },
    handler: (input) => {
      const id = SafeText.stripDangerous(String(input?.id || ''));
      const dir = SafeText.stripDangerous(String(input?.dir || ''));
      return {
        op: 'mark',
        args: { id, dir },
        fsAllowlist: [dir],
        failClosed: true
      };
    }
  });
}

