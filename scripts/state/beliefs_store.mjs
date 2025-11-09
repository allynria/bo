import path from 'path';
import crypto from 'crypto';
import { stateIO, safeFsp, createSharedRateLimiter } from '../../monolith.js';

const BASE = path.join(process.cwd(), 'tmp', 'urga_beliefs');
async function ensureBase() {
  try {
    await safeFsp.mkdir(BASE, { recursive: true });
  } catch {}
}

function keyOf(id) {
  // keep simple and safe
  const clean = String(id || 'default').replace(/[^a-z0-9_\-.]/gi, '_');
  return path.join(BASE, `${clean}.json`);
}

function hashText(t) {
  return crypto.createHash('sha256').update(t.trim().toLowerCase()).digest('hex').slice(0, 16);
}

function emptyProfile(id) {
  return {
    id,
    updatedAt: Date.now(),
    beliefs: [], // immutable truths (“magic cannot resurrect the dead”)
    disallowed_actions: [], // things character would never do
    logic_constraints: [], // world rules (“dead can’t talk”, “gravity exists”)
    refusal_style: 'firm', // firm|soft|sarcastic
  };
}

export async function loadBeliefs(id) {
  await ensureBase();
  const file = keyOf(id);
  const fallback = emptyProfile(id);
  try {
    const obj = await stateIO.readJson(file, fallback);
    // Ensure shape in case of partial/corrupted file
    const safe = { ...fallback, ...obj };
    if (!Array.isArray(safe.beliefs)) safe.beliefs = [];
    if (!Array.isArray(safe.disallowed_actions)) safe.disallowed_actions = [];
    if (!Array.isArray(safe.logic_constraints)) safe.logic_constraints = [];
    if (!['firm', 'soft', 'sarcastic'].includes(safe.refusal_style)) safe.refusal_style = 'firm';
    return safe;
  } catch {
    return fallback;
  }
}

export async function saveBeliefs(profile) {
  await ensureBase();
  const file = keyOf(profile.id);
  const data = { ...profile, updatedAt: Date.now() };
  const persistEnabled = String(process.env.BELIEFS_PERSIST ?? '1') === '1';
  if (!persistEnabled) return data;
  const RL = createSharedRateLimiter({
    limit: Number(process.env.BELIEFS_WRITES_PER_SECOND || 50),
    windowMs: Number(process.env.BELIEFS_WRITE_WINDOW_MS || 1000),
  });
  const key = `beliefs:${String(profile.id || 'default')}`;
  try {
    const allow = await RL.allow(key);
    if (allow?.ok) {
      await stateIO.writeJsonAtomic(file, data);
    } else {
      // Coalesce into a microtask to attempt one more write shortly without blocking
      queueMicrotask(async () => {
        try {
          const allow2 = await RL.allow(key);
          if (allow2?.ok) await stateIO.writeJsonAtomic(file, data);
        } catch {}
      });
    }
  } catch {}
  return data;
}

export async function listBeliefs(id) {
  const p = await loadBeliefs(id);
  return p;
}

function dedupeLines(lines = []) {
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const h = hashText(line);
    if (!seen.has(h)) {
      seen.add(h);
      out.push({ text: line.trim(), hash: h });
    }
  }
  return out;
}

// Merge/replace helpers (idempotent-ish)
export async function upsertBeliefs(id, patch = {}) {
  const cur = await loadBeliefs(id);
  const next = { ...cur, ...patch };

  // normalize + dedupe lists
  next.beliefs = dedupeLines(
    next.beliefs?.map((x) => (typeof x === 'string' ? x : x.text)) || []
  ).map((x) => x.text);
  next.disallowed_actions = dedupeLines(
    next.disallowed_actions?.map((x) => (typeof x === 'string' ? x : x.text)) || []
  ).map((x) => x.text);
  next.logic_constraints = dedupeLines(
    next.logic_constraints?.map((x) => (typeof x === 'string' ? x : x.text)) || []
  ).map((x) => x.text);

  // refusal_style sanity
  if (!['firm', 'soft', 'sarcastic'].includes(next.refusal_style)) next.refusal_style = 'firm';

  return saveBeliefs(next);
}

export async function addBeliefLine(id, kind, line) {
  const cur = await loadBeliefs(id);
  const key = kind; // 'beliefs' | 'disallowed_actions' | 'logic_constraints'
  if (!['beliefs', 'disallowed_actions', 'logic_constraints'].includes(key)) {
    throw new Error('invalid kind');
  }
  const arr = cur[key] || [];
  arr.push(line);
  cur[key] = dedupeLines(arr).map((x) => x.text);
  return saveBeliefs(cur);
}

export async function deleteBeliefLine(id, kind, hashOrText) {
  const cur = await loadBeliefs(id);
  const key = kind;
  const arr = cur[key] || [];
  const tgtHash = hashText(hashOrText);
  cur[key] = arr.filter((t) => hashText(t) !== tgtHash);
  return saveBeliefs(cur);
}

// Lightweight relevance: jaccard over tokens
export function jaccard(a, b) {
  const A = new Set(String(a).toLowerCase().split(/\W+/).filter(Boolean));
  const B = new Set(String(b).toLowerCase().split(/\W+/).filter(Boolean));
  const inter = [...A].filter((x) => B.has(x)).length;
  const uni = new Set([...A, ...B]).size || 1;
  return inter / uni;
}

export function pickRelevantBeliefs(profile, userText, { max = 3, minSim = 0.2 } = {}) {
  const pool = [
    ...profile.beliefs.map((t) => ({ kind: 'belief', text: t })),
    ...profile.logic_constraints.map((t) => ({ kind: 'constraint', text: t })),
  ];
  const scored = pool
    .map((x) => ({ ...x, sim: jaccard(x.text, userText) }))
    .filter((x) => x.sim >= minSim)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, max);
  return scored;
}

export function detectDisallowedAction(profile, userText, { minSim = 0.25 } = {}) {
  let best = null;
  for (const t of profile.disallowed_actions || []) {
    const sim = jaccard(t, userText);
    if (sim >= minSim && (!best || sim > best.sim)) best = { kind: 'disallowed', text: t, sim };
  }
  return best;
}
