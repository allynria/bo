import { hashBytes, hashString, randomId } from './helpers/hash.mjs';

// Conversation message schema and deterministic prompt assembly
// Schema: {id, conv_id, turn, role, content[], tool_calls[], tool_results[], ts, meta{user_id, tenant, locale}}

export const RoleOrder = Object.freeze({
  system: 0,
  memory: 1,
  context: 2,
  user: 3,
  tool_result: 4,
  policy: 5,
  assistant: 6,
});

export function createMessage({
  role,
  content = [],
  conv_id = randomId('conv_'),
  turn = 0,
  id = randomId('msg_'),
  ts = Date.now(),
  meta = {},
  tool_calls = [],
  tool_results = [],
}) {
  const msg = {
    id: String(id),
    conv_id: String(conv_id),
    turn: Number(turn),
    role: String(role),
    content: Array.isArray(content) ? content : [String(content)],
    tool_calls: Array.isArray(tool_calls) ? tool_calls : [],
    tool_results: Array.isArray(tool_results) ? tool_results : [],
    ts: Number(ts),
    meta: typeof meta === 'object' && meta !== null ? meta : {},
  };
  return msg;
}

export function sortMessagesDeterministically(msgs) {
  return [...msgs].sort((a, b) => {
    const ro = RoleOrder[a.role] ?? 99;
    const rb = RoleOrder[b.role] ?? 99;
    if (ro !== rb) return ro - rb;
    if (a.turn !== b.turn) return a.turn - b.turn;
    if (a.ts !== b.ts) return a.ts - b.ts;
    return String(a.id).localeCompare(String(b.id));
  });
}

// Deterministic bytes: serialize only necessary fields in a stable order
export function assemblePromptBytes(messages, opts = {}) {
  const ordered = sortMessagesDeterministically(messages);
  const persona_v = String(opts.persona_v || 'v1');
  const prompt_v = String(opts.prompt_v || 'v1');
  const arr = ordered.map((m) => ({
    id: m.id,
    role: m.role,
    turn: m.turn,
    ts: m.ts,
    meta: m.meta,
    content: m.content,
    tool_calls: m.tool_calls,
    tool_results: m.tool_results,
  }));
  const body = { persona_v, prompt_v, messages: arr };
  const json = JSON.stringify(body);
  return Buffer.from(json, 'utf8');
}

export function hashPromptBytes(messages, opts = {}) {
  return hashBytes(assemblePromptBytes(messages, opts));
}

// Utility: ensure deterministic assembly order for system→memory→context→user→tool_results→policy→assistant
export function assembleForModel(messages, opts = {}) {
  const bytes = assemblePromptBytes(messages, opts);
  return { bytes, hash: hashBytes(bytes) };
}

