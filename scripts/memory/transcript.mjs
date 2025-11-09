// Lightweight transcript index with per-conversation rolling storage
// Provides: indexTurn, getWindowAround, getNextSeq, getSize, prune
// ENV:
//   TRANSCRIPT_MAX_TURNS : default 5000 (per conv)
//   TRANSCRIPT_PRUNE_TO  : default 4500 (per conv)
//   TRANSCRIPT_MAX_TEXT_CHARS : max chars per stored turn (default 4000)

import { SafeText, sampled } from '../../monolith.js';

const TRANSCRIPTS = new Map(); // convId -> { seq:number, list:Array<{seq,role,text,ts}> }

function ensure(convId) {
  let t = TRANSCRIPTS.get(convId);
  if (!t) {
    t = { seq: 0, list: [] };
    TRANSCRIPTS.set(convId, t);
  }
  return t;
}

export function getNextSeq(convId) {
  const t = ensure(convId);
  return t.seq + 1;
}

export function indexTurn({ convId, role, text, ts = Date.now() }) {
  const t = ensure(convId);
  const max = Number(process.env.TRANSCRIPT_MAX_TURNS || 5000);
  const keep = Number(process.env.TRANSCRIPT_PRUNE_TO || 4500);
  t.seq += 1;
  const base = String(text ?? '');
  const clean = SafeText.stripDangerous(base);
  const cap = Math.max(100, Math.min(20000, Number(process.env.TRANSCRIPT_MAX_TEXT_CHARS || 4000)));
  const txt = SafeText.clamp(clean, cap);
  if (txt.length < base.length)
    sampled('debug', 0.02, '[transcript] turn text truncated/sanitized');
  const rec = { seq: t.seq, role: role || 'unknown', text: txt, ts: Number(ts) };
  t.list.push(rec);
  if (t.list.length > max) {
    // prune from head to keep size bounded
    t.list.splice(0, Math.max(0, t.list.length - keep));
  }
  return rec;
}

export function getWindowAround(convId, anchorSeq, before = 20, after = 20) {
  const t = ensure(convId);
  const a = Number(anchorSeq);
  if (!Number.isFinite(a) || a <= 0) return [];
  const lo = Math.max(1, a - Math.max(0, Number(before) || 0));
  const hi = a + Math.max(0, Number(after) || 0);
  return t.list.filter((m) => m.seq >= lo && m.seq <= hi);
}

export function getSize(convId) {
  const t = ensure(convId);
  return t.list.length;
}

export function getAll(convId) {
  return ensure(convId).list.slice();
}

export function clear(convId) {
  TRANSCRIPTS.delete(convId);
}
