// Lightweight in-memory audit ring buffer for memory/guard/continuity instrumentation
// Not persisted; intended for short-lived introspection and tests.

const MAX = Math.max(50, Math.min(5000, Number(process.env.MEMORY_AUDIT_BUFFER || 300)));
const BUF = [];
let SEQ = 0;

export function pushAudit(entry = {}) {
  try {
    const now = Date.now();
    const rec = {
      id: ++SEQ,
      ts: now,
      path: entry.path || 'message',
      conv_id: entry.conv_id || entry.convId || '',
      turn: Number(entry.turn || entry.seq || 0),
      model: entry.model || '',
      booster_text: entry.booster_text || null,
      dream_text: entry.dream_text || null,
      guard_hint: entry.guard_hint || null,
      memory_inject_text: entry.memory_inject_text || '',
      memory_inject_tokens: Number(entry.memory_inject_tokens || 0),
      continuity_overall: typeof entry.continuity_overall === 'number' ? entry.continuity_overall : null,
      continuity_axes: entry.continuity_axes || null,
      shadow_nudge: entry.shadow_nudge || null,
      meta: entry.meta || null,
    };
    BUF.push(rec);
    if (BUF.length > MAX) BUF.shift();
    return rec.id;
  } catch {
    return 0;
  }
}

export function getAudit({ convId = '', limit = 100 } = {}) {
  const lim = Math.max(1, Math.min(1000, Number(limit || 100)));
  const list = convId ? BUF.filter(x => String(x.conv_id || '') === String(convId)) : BUF;
  return list.slice(Math.max(0, list.length - lim));
}

