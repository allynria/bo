// phrase_decay.mjs — per-conversation phrase frequency with time-decay & cooldown planning
import crypto from 'node:crypto';

const ENABLED = String(process.env.PHRASE_DECAY_ENABLED ?? '1') === '1';
const NGRAM = Math.max(2, Math.min(5, Number(process.env.PHRASE_DECAY_NGRAM ?? 3)));
const MIN_LEN = Math.max(6, Number(process.env.PHRASE_DECAY_MIN_LEN ?? 8)); // characters, after normalize
const THRESH = Math.max(2, Number(process.env.PHRASE_DECAY_THRESHOLD ?? 3)); // min count (after decay) to cool down
const WINDOW_TURNS = Math.max(3, Number(process.env.PHRASE_DECAY_WINDOW_TURNS ?? 6)); // recent window to weigh heavier
const DECAY_MS = Math.max(10_000, Number(process.env.PHRASE_DECAY_DECAY_MS ?? 180_000)); // half-life tick-ish
const COOLDOWN_MS = Math.max(5_000, Number(process.env.PHRASE_DECAY_COOLDOWN_MS ?? 600_000)); // cool-down duration
const MAX_COOLDOWN = Math.max(1, Number(process.env.PHRASE_DECAY_MAX ?? 3)); // max phrases to steer away from

// In-memory: convId -> {
//   turns: [{ ts, text } ... capped ],
//   grams: Map(phrase -> { score, last, cooledUntil? }),
//   turn: number
// }
const STORE = new Map();
const MAX_TURNS = 200; // lightweight cap per conv

function now() {
  return Date.now();
}
function sha1(s) {
  return crypto.createHash('sha1').update(s, 'utf8').digest('hex');
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[“”„"]/g, '"')
    .replace(/[’‘']/g, "'")
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[^\p{L}\p{N}\s'"-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function ngrams(s, n = NGRAM) {
  const words = s.split(' ').filter(Boolean);
  const out = [];
  for (let i = 0; i <= words.length - n; i++) {
    const g = words.slice(i, i + n).join(' ');
    if (g.length >= MIN_LEN) out.push(g);
  }
  return out;
}

function ensureConv(convId) {
  if (!STORE.has(convId)) {
    STORE.set(convId, { turns: [], grams: new Map(), turn: 0 });
  }
  return STORE.get(convId);
}

function decayScore(entry, t = now()) {
  if (!entry?.last) return entry?.score ?? 0;
  const dt = Math.max(0, t - entry.last);
  // Simple exponential-like decay: score *= 0.5^(dt/DECAY_MS)
  const factor = Math.pow(0.5, dt / DECAY_MS);
  entry.score = entry.score * factor;
  entry.last = t;
  return entry.score;
}

export function recordFinal(convId, text) {
  if (!ENABLED) return;
  const conv = ensureConv(convId);
  conv.turn++;
  const ts = now();
  const clean = norm(text);
  conv.turns.push({ ts, text: clean });
  if (conv.turns.length > MAX_TURNS) conv.turns.shift();

  // Heavier weighting for recent WINDOW_TURNS
  const bonus = 1 + Math.min(1, WINDOW_TURNS / Math.max(1, conv.turn)); // early turns: small bias
  const grams = ngrams(clean);
  for (const g of grams) {
    let e = conv.grams.get(g);
    if (!e) e = { score: 0, last: ts, cooledUntil: 0 };
    // decay then add
    decayScore(e, ts);
    e.score += 1.0 * bonus;
    e.last = ts;
    conv.grams.set(g, e);
  }
}

export function planCooldown(convId) {
  if (!ENABLED) return { enabled: false, cooldown: [] };
  const conv = ensureConv(convId);
  const t = now();
  const arr = [];
  for (const [phrase, e] of conv.grams.entries()) {
    const s = decayScore(e, t);
    const cooled = e.cooledUntil && e.cooledUntil > t;
    if (s >= THRESH || cooled) {
      arr.push({ phrase, score: s, cooledUntil: Math.max(e.cooledUntil || 0, 0) });
    }
  }
  // prioritize actively cooled, then by score
  arr.sort((a, b) => {
    const ac = a.cooledUntil > t ? 1 : 0;
    const bc = b.cooledUntil > t ? 1 : 0;
    if (ac !== bc) return bc - ac;
    return b.score - a.score;
  });
  const pick = arr.slice(0, MAX_COOLDOWN);
  // set / extend cooldown window
  for (const p of pick) {
    const e = conv.grams.get(p.phrase);
    if (e) e.cooledUntil = Math.max(e.cooledUntil || 0, t + COOLDOWN_MS);
  }
  return {
    enabled: true,
    cooldown: pick.map((p) => ({
      phrase: p.phrase,
      hash: sha1(p.phrase).slice(0, 12),
      until: Math.max(p.cooledUntil || now() + COOLDOWN_MS, 0),
      score: Math.round(p.score * 100) / 100,
    })),
  };
}

export function buildAvoidanceBooster(plan) {
  if (!ENABLED || !plan?.cooldown?.length) return null;
  const phrases = plan.cooldown.map((p) => p.phrase);
  // VERY tiny, model-visible nudge; keep neutral tone, avoid meta.
  const text =
    `(Avoid reusing these exact phrasings this turn; vary wording and imagery: ` +
    phrases.map((p) => `"${p}"`).join(', ') +
    `.)`;
  const estTokens = Math.ceil(text.length / 4);
  return { text, estTokens };
}

// --- Explicit cooldown API (used by near-miss synergy) ---
export function coolPhrases(convId, phrases, ttlMs = COOLDOWN_MS) {
  if (!Array.isArray(phrases) || phrases.length === 0) return;
  const conv = ensureConv(convId);
  const t = now();
  for (const raw of phrases) {
    const p = norm(String(raw || ''));
    if (!p) continue;
    const e = conv.grams.get(p) || { score: 0, last: t, cooledUntil: 0 };
    e.last = t;
    e.cooledUntil = Math.max(
      Number(e.cooledUntil || 0),
      t + Math.max(1, Number(ttlMs || COOLDOWN_MS))
    );
    conv.grams.set(p, e);
  }
}

export function isCooled(convId, text) {
  const conv = ensureConv(convId);
  const t = now();
  const normText = norm(String(text || ''));
  for (const [phrase, e] of conv.grams.entries()) {
    if (e.cooledUntil && e.cooledUntil > t) {
      if (normText.includes(phrase)) return true;
    }
  }
  return false;
}

// ---
// Pattern-based phrase tracking with time-based decay (LOOP_* env aliases)
// Provides a simpler API alongside the n-gram system above.
// Env (aliases):
//   LOOP_PHRASE_DECAY_ENABLED=1
//   LOOP_PHRASE_DECAY_MS=600000
//   LOOP_PHRASE_MAX_COUNT=3
//   LOOP_PHRASE_WINDOW=50
//   LOOP_PHRASE_PATTERNS="she smiles softly|you notice|a moment of silence|..."

const LOOP_ENABLED = String(process.env.LOOP_PHRASE_DECAY_ENABLED ?? '1') === '1';
const LOOP_DECAY_MS = Number(process.env.LOOP_PHRASE_DECAY_MS ?? 10 * 60 * 1000);
const LOOP_MAX_COUNT = Number(process.env.LOOP_PHRASE_MAX_COUNT ?? 3);
const LOOP_WINDOW = Number(process.env.LOOP_PHRASE_WINDOW ?? 50);
const LOOP_DEFAULT_PATTERNS = (
  process.env.LOOP_PHRASE_PATTERNS ??
  'she smiles softly|you notice|a moment of silence|her gaze|he sighs|tilts her head|soft chuckle|eyes widen|voice trails off'
)
  .split('|')
  .map((s) => s.trim())
  .filter(Boolean);

// In-memory store for the LOOP_* API: convId -> { key -> {count, lastTs, hits: number[]} }
const P_STORE = new Map();

const pNorm = (s) => String(s ?? '').toLowerCase();

export function enabled() {
  return LOOP_ENABLED;
}

export function matchPhrases(text, patterns = LOOP_DEFAULT_PATTERNS) {
  const t = pNorm(text);
  const hits = [];
  for (const p of patterns) {
    if (!p) continue;
    const idx = t.indexOf(pNorm(p));
    if (idx !== -1) hits.push(p);
  }
  return hits;
}

export function update(convId, botText, now = Date.now()) {
  if (!LOOP_ENABLED) return { hot: [] };
  const phrases = matchPhrases(botText);
  if (!phrases.length) return { hot: [] };
  const entry = P_STORE.get(convId) ?? {};
  P_STORE.set(convId, entry);
  for (const key of phrases) {
    const cur = entry[key] ?? { count: 0, lastTs: now, hits: [] };
    cur.count += 1;
    cur.lastTs = now;
    cur.hits.push(now);
    if (cur.hits.length > LOOP_WINDOW) cur.hits.splice(0, cur.hits.length - LOOP_WINDOW);
    entry[key] = cur;
  }
  return getHot(convId, now);
}

export function decay(convId, now = Date.now()) {
  if (!LOOP_ENABLED) return;
  const entry = P_STORE.get(convId);
  if (!entry) return;
  for (const [k, v] of Object.entries(entry)) {
    const dt = now - v.lastTs;
    if (dt > LOOP_DECAY_MS) {
      // simple decay: halve count per LOOP_DECAY_MS step
      const steps = Math.floor(dt / LOOP_DECAY_MS);
      v.count = Math.max(0, Math.floor(v.count / Math.pow(2, steps)));
      v.lastTs = now - (dt % LOOP_DECAY_MS);
      if (v.count === 0) delete entry[k];
      else entry[k] = v;
    }
  }
  if (!Object.keys(entry).length) P_STORE.delete(convId);
}

export function getHot(convId, now = Date.now()) {
  decay(convId, now);
  const entry = P_STORE.get(convId) ?? {};
  const hot = Object.entries(entry)
    .filter(([, v]) => v.count >= LOOP_MAX_COUNT)
    .map(([k, v]) => ({ phrase: k, count: v.count }));
  return { hot };
}

export function snapshot(convId) {
  const entry = P_STORE.get(convId) ?? {};
  return Object.fromEntries(
    Object.entries(entry).map(([k, v]) => [k, { count: v.count, lastTs: v.lastTs }])
  );
}

export default {
  recordFinal,
  planCooldown,
  buildAvoidanceBooster,
  enabled,
  update,
  getHot,
  snapshot,
  matchPhrases,
  decay,
  coolPhrases,
  isCooled,
};
