import path from 'node:path';
import { AsyncFS } from '../../monolith.js';

const BASE = path.join(process.cwd(), 'tmp', 'shadow');
await AsyncFS.mkdir(BASE, { recursive: true }).catch(() => {});

// ---------- Storage ----------
function fileFor(convId) {
  return path.join(BASE, encodeURIComponent(convId) + '.json');
}

async function loadShadow(convId) {
  try {
    return JSON.parse(String(await AsyncFS.readFile(fileFor(convId), 'utf8')));
  } catch {
    return { convId, turns: [], facts: [], lastTurn: -1, mismatches: [] };
  }
}
async function saveShadow(convId, data) {
  const fp = fileFor(convId);
  await AsyncFS.writeFileAtomic(fp, JSON.stringify(data), 'utf8');
}

// ---------- Utilities ----------
function norm(s) {
  return String(s || '').trim();
}
function tokCount(s) {
  return Math.ceil(String(s || '').length / 4);
} // rough
function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}
function nowMs() {
  return Date.now();
}

// ---------- Fact extraction (lightweight heuristics; no external deps) ----------
// Fact shape: { type, who, key, val, polarity=+1|-1, turn, ts }
// Types: name, trait, secret, promise, location, injury, fear, like, dislike, bond, relationship
const RX = {
  name: /\b(?:my|i am|i’m|call me)\s+([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})?)\b/,
  promise: /\b(?:i|we)\s+(?:won't|will not|will)\s+(.*?)\b/i,
  location: /\b(?:in|at|inside|near|by)\s+(the\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/,
  fear: /\b(?:afraid of|fear|terrified of)\s+([a-z][^.,;!?)]{1,40})/i,
  like: /\b(?:love|like|enjoy)\s+([a-z][^.,;!?)]{1,40})/i,
  dislike: /\b(?:hate|dislike|can’t stand)\s+([a-z][^.,;!?)]{1,40})/i,
  injury: /\b(?:scar|wound|broken)\s+([a-z][^.,;!?)]{1,40})/i,
  secret: /\b(?:our secret|keep this between us|never told anyone)\b/i,
};

export function extractFacts(text, { role = 'bot', turn = 0 } = {}) {
  const facts = [];
  const t = String(text || '');
  const add = (type, key, val, pol = +1) =>
    facts.push({ type, who: role, key, val: norm(val), polarity: pol, turn, ts: nowMs() });
  // name
  const mName = t.match(RX.name);
  if (mName) add('name', 'name', mName[1], +1);
  // promise (store verb phrase)
  const mPr = t.match(RX.promise);
  if (mPr) add('promise', 'promise', mPr[1], +1);
  // location (coarse; prefer Proper Nouns)
  const mLoc = t.match(RX.location);
  if (mLoc) add('location', 'location', mLoc[2], +1);
  // fear/like/dislike/injury/secret cues
  const mFear = t.match(RX.fear);
  if (mFear) add('fear', 'fear', mFear[1], +1);
  const mLike = t.match(RX.like);
  if (mLike) add('like', 'like', mLike[1], +1);
  const mDisl = t.match(RX.dislike);
  if (mDisl) add('dislike', 'dislike', mDisl[1], +1);
  const mInj = t.match(RX.injury);
  if (mInj) add('injury', 'injury', mInj[1], +1);
  const mSec = t.match(RX.secret);
  if (mSec) add('secret', 'secret', 'shared secret', +1);
  return facts;
}

// Dedup/merge fact list to compact shadow memory
function mergeFacts(oldFacts = [], newFacts = [], { maxFacts = 128 } = {}) {
  const keyOf = (f) =>
    `${f.who}|${f.type}|${(f.key || '').toLowerCase()}|${(f.val || '').toLowerCase()}`;
  const map = new Map();
  for (const f of oldFacts) map.set(keyOf(f), f);
  for (const f of newFacts) {
    const k = keyOf(f);
    const prev = map.get(k);
    if (!prev) map.set(k, f);
    else {
      // keep most recent turn/time; accumulate a light 'confidence'
      const conf = clamp01((prev.confidence || 0.6) * 0.7 + 0.3);
      map.set(k, { ...f, confidence: conf });
    }
  }
  // return bounded by recency & confidence
  const all = Array.from(map.values());
  all.sort((a, b) => b.turn - a.turn || b.ts - a.ts || (b.confidence || 0) - (a.confidence || 0));
  return all.slice(0, maxFacts);
}

// ---------- Contradiction / drift detector ----------
// naive contradiction table for show-off demos
const CONTRA = {
  fear_vs_like: (facts, text) => {
    const fears = facts.filter((f) => f.type === 'fear').map((f) => f.val.toLowerCase());
    const likes = facts.filter((f) => f.type === 'like').map((f) => f.val.toLowerCase());
    const claimsLike = likes.filter((x) =>
      new RegExp(`\\b${escapeRegExp(x)}\\b`).test(text.toLowerCase())
    );
    const claimsNoFear = fears.filter((x) =>
      new RegExp(`\\b(?:not afraid of|no fear of)\\s+${escapeRegExp(x)}\\b`).test(
        text.toLowerCase()
      )
    );
    const hits = [
      ...claimsLike.map((x) => ({ kind: 'fear_like_conflict', what: x })),
      ...claimsNoFear.map((x) => ({ kind: 'fear_denial', what: x })),
    ];
    return hits.map((h) => ({ type: h.kind, score: 0.75, detail: h.what }));
  },
  name_flip: (facts, text) => {
    const names = facts.filter((f) => f.type === 'name');
    const m = text.match(RX.name);
    if (m && names.length) {
      const last = names[0].val.toLowerCase();
      if (m[1].toLowerCase() !== last)
        return [{ type: 'name_conflict', score: 0.9, detail: `was "${last}", now "${m[1]}"` }];
    }
    return [];
  },
  broken_promise: (facts, text) => {
    const ps = facts.filter((f) => f.type === 'promise');
    if (!ps.length) return [];
    // crude: if reply contains "break"/"ignore" plus promise verb phrase tokens
    const lower = text.toLowerCase();
    const hits = [];
    for (const p of ps) {
      const token = String(p.val || '')
        .toLowerCase()
        .split(/\s+/)
        .slice(0, 3)
        .join(' ');
      if (!token) continue;
      if (lower.includes('break') && lower.includes(token))
        hits.push({ type: 'promise_conflict', score: 0.8, detail: token });
      if (lower.includes('ignore') && lower.includes(token))
        hits.push({ type: 'promise_conflict', score: 0.75, detail: token });
    }
    return hits;
  },
};
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function detectMismatches(facts = [], replyText = '') {
  const out = [];
  for (const [k, fn] of Object.entries(CONTRA)) {
    try {
      out.push(...fn(facts, replyText));
    } catch {}
  }
  // dedupe by type+detail; keep highest score
  const best = new Map();
  for (const m of out) {
    const key = `${m.type}|${m.detail || ''}`;
    const prev = best.get(key);
    if (!prev || (m.score || 0) > (prev.score || 0)) best.set(key, m);
  }
  return Array.from(best.values()).sort((a, b) => b.score - a.score);
}

// ---------- Nudge synthesis ----------
export function buildNudge(mismatch, facts = [], { pov = 'they' } = {}) {
  const detail = mismatch.detail ? String(mismatch.detail) : '';
  switch (mismatch.type) {
    case 'fear_like_conflict':
      return `(${pov} caught themself—no, ${detail} still tied their stomach in knots.)`;
    case 'fear_denial':
      return `(${pov} exhaled; pretending bravery didn't erase the fear of ${detail}.)`;
    case 'name_conflict':
      return `(${pov} paused. The name they'd given before still held: ${detail.split('"')[1] || '—'}.)`;
    case 'promise_conflict':
      return `(${pov} remembered the vow—${detail}. Promises had weight.)`;
    default:
      return `(${pov} remembered what mattered.)`;
  }
}

// ---------- Public API ----------
export async function shadowIngest({
  convId,
  turn,
  role,
  text,
  maxTimeline = 400,
  maxFacts = 128,
}) {
  const s = await loadShadow(convId);
  s.turns.push({ turn, role, text, ts: nowMs() });
  if (s.turns.length > maxTimeline) s.turns = s.turns.slice(-maxTimeline);
  const factsNew = extractFacts(text, { role, turn });
  s.facts = mergeFacts(s.facts, factsNew, { maxFacts });
  s.lastTurn = Math.max(s.lastTurn, Number(turn || 0));
  await saveShadow(convId, s);
  return { factsNew, snapshot: s };
}

export async function shadowDetect({ convId, replyText }) {
  const s = await loadShadow(convId);
  const mismatches = detectMismatches(s.facts, replyText);
  s.mismatches = mismatches;
  await saveShadow(convId, s);
  return { mismatches, snapshot: s };
}

export async function shadowNudgeFor({ convId, pov = 'they', limit = 2 }) {
  const s = await loadShadow(convId);
  const out = [];
  for (const m of s.mismatches.slice(0, limit)) out.push(buildNudge(m, s.facts, { pov }));
  return out;
}

export async function shadowStashNudges({ convId, nudges = [] }) {
  const s = await loadShadow(convId);
  try {
    s.__last_nudges = Array.isArray(nudges) ? nudges : [String(nudges || '')];
  } catch {
    s.__last_nudges = [];
  }
  await saveShadow(convId, s);
  return { snapshot: s };
}

export async function shadowSnapshot(convId) {
  return loadShadow(convId);
}
export async function shadowRebuild({ convId, full = false }) {
  // Optionally rebuild facts from timeline
  const s = await loadShadow(convId);
  if (!full) return s;
  const rebuilt = { convId, turns: s.turns, facts: [], mismatches: [], lastTurn: s.lastTurn };
  for (const t of s.turns)
    rebuilt.facts = mergeFacts(
      rebuilt.facts,
      extractFacts(t.text, { role: t.role, turn: t.turn }),
      { maxFacts: 256 }
    );
  await saveShadow(convId, rebuilt);
  return rebuilt;
}
