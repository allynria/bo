// Booster recap store and generator.
// Creates compact narrative recaps from transcript windows and stages them
// for stealth injection on the next turn(s), without expanding base memory.
//
// ENV:
//   BOOSTER_MAX_CHARS        (default 900)
//   BOOSTER_TTL_TURNS        (default 2)
//   BOOSTER_MAX_SLOTS        (default 5)  // per conv
//   BOOSTER_SUMMARY_STYLE    (optional: "first-person"|"third-person")

import { getWindowAround } from './transcript.mjs';
import { SafeText } from '../../monolith.js';

const BOOSTERS = new Map(); // convId -> [{ id, anchor, range:[lo,hi], text, turnsLeft, ts, agent, source }]

function ensure(convId) {
  let v = BOOSTERS.get(convId);
  if (!v) { v = []; BOOSTERS.set(convId, v); }
  return v;
}

export function listBoosters(convId) {
  return ensure(convId).map(({ id, anchor, range, turnsLeft, ts, agent=null, source=null }) => ({ id, anchor, range, turnsLeft, ts, agent, source }));
}

export function deleteBooster(convId, id) {
  const arr = ensure(convId);
  const i = arr.findIndex(b => String(b.id) === String(id));
  if (i >= 0) { arr.splice(i,1); return true; }
  return false;
}

export function consumeOne(convId, { agent = null } = {}) {
  const arr = ensure(convId);
  if (!arr.length) return null;
  // Find first eligible: if booster has an agent, it must match; otherwise allow any
  const idx = arr.findIndex((b) => b && b.turnsLeft > 0 && (!b.agent || !agent || String(b.agent) === String(agent)));
  if (idx < 0) return null;
  const b = arr[idx];
  b.turnsLeft -= 1;
  if (b.turnsLeft <= 0) arr.splice(idx, 1);
  return b.text;
}

export function stageBooster({ convId, id, anchor, range, text, ttlTurns, agent = null, source = 'heur' }) {
  const arr = ensure(convId);
  const maxSlots = Number(process.env.BOOSTER_MAX_SLOTS || 5);
  // Evict oldest if needed
  while (arr.length >= maxSlots) arr.shift();
  arr.push({ id: String(id), anchor: Number(anchor), range, text: String(text), turnsLeft: Math.max(1, Number(ttlTurns)||1), ts: Date.now(), agent: agent ? String(agent) : null, source: String(source || 'heur') });
}

export function boostersSize(convId) {
  return ensure(convId).length;
}

export function makeBoosterId(anchor) {
  return `anchor:${anchor}`;
}

export function summarizeWindow({ convId, anchor, before=20, after=20, pov='she', maxChars = Number(process.env.BOOSTER_MAX_CHARS || 900) }) {
  const msgs = getWindowAround(convId, anchor, before, after);
  // Heuristic: keep role labels, compress content, keep salient cues.
  // We avoid LLM calls here to keep it cheap/fast; if you prefer, wire an LLM summarizer later.
  const lines = [];
  // Pull up to ~41 items; pick short & salient fragments
  for (const m of msgs) {
    const t = (m.text || '').trim();
    if (!t) continue;
    // Take first sentence or ~120 chars slice
    const cap = firstSentenceOr(t, 120);
    lines.push(`${m.role === 'user' ? 'You' : 'They'}: ${cap}`);
  }
  // Simple compression: prefer last 12 lines + first 4 as context
  const head = lines.slice(0,4);
  const tail = lines.slice(-12);
  let body = [...head, '—', ...tail].join(' ');
  body = body.replace(/\s+/g, ' ').trim();
  let recap = `${capitalize(pov)} recalled: ${body}`;
  // Sanitize and clamp via SafeText for durability and log safety
  recap = SafeText.stripDangerous(recap);
  recap = SafeText.clamp(recap, Math.max(1, maxChars));
  return recap;
}

function firstSentenceOr(s, n) {
  const m = String(s).match(/(.+?[.!?])(\s|$)/);
  if (m && m[1]) return m[1].trim();
  s = String(s);
  return s.length <= n ? s : s.slice(0, n-1).trimEnd() + '…';
}
function capitalize(s) { return s ? s[0].toUpperCase()+s.slice(1) : s; }
