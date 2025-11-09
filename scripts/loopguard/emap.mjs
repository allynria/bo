/**
 * EMAP: ultra-fast local "embeddings" via character 3-grams.
 * - No external calls
 * - Cosine similarity on normalized n-gram vectors
 * - Per-conversation rolling store
 */

const PUNCT_RE = /[^\p{L}\p{N}\s]/gu;

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(PUNCT_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function charNgrams(text, n = 3) {
  const t = ` ${text} `; // pad to catch edges
  const out = [];
  for (let i = 0; i + n <= t.length; i++) out.push(t.slice(i, i + n));
  return out;
}

function vectorize(text, n = 3) {
  const grams = charNgrams(normalize(text), n);
  const counts = new Map();
  for (const g of grams) counts.set(g, (counts.get(g) || 0) + 1);
  // L2 norm
  let sum = 0;
  for (const v of counts.values()) sum += v * v;
  const norm = Math.sqrt(sum) || 1;
  // normalize in-place
  for (const [k, v] of counts) counts.set(k, v / norm);
  return counts;
}

function cosine(a, b) {
  // iterate over smaller
  const small = a.size <= b.size ? a : b;
  const large = a.size <= b.size ? b : a;
  let dot = 0;
  for (const [k, v] of small) {
    const u = large.get(k);
    if (u) dot += v * u;
  }
  // vectors are pre-normalized → dot is cosine in [0,1]
  return dot;
}

// --- Rolling store per conversation
const EMAP = new Map(); // convId -> { vecs: Array<{v:Map, len:number, text:string}> }

function getStore(convId) {
  const k = String(convId || '');
  if (!EMAP.has(k)) EMAP.set(k, { vecs: [] });
  return EMAP.get(k);
}

export function getEMAPConfigFromEnv() {
  return {
    enabled: process.env.LOOP_EMBED_ENABLED === '1',
    historyN: Number(process.env.LOOP_EMBED_HISTORY_N || process.env.LOOP_HISTORY_N || 5),
    simMax: Number(process.env.LOOP_EMBED_SIM_MAX || 0.91),
    minLen: Number(process.env.LOOP_EMBED_MIN_LEN || 30), // skip tiny replies
    ngramN: Number(process.env.LOOP_EMBED_NGRAM_N || 3),
  };
}

/**
 * Compute max cosine similarity vs last N entries for a conversation.
 * Skips tiny candidate replies (< minLen) unless forced.
 */
export function emapMaxSim({ convId, candidate, cfg }) {
  const text = String(candidate || '');
  if (!cfg.enabled) return { maxSim: 0, compared: 0 };
  if (text.length < cfg.minLen) return { maxSim: 0, compared: 0 };

  const store = getStore(convId);
  const hist = store.vecs.slice(-cfg.historyN);
  if (hist.length === 0) return { maxSim: 0, compared: 0 };

  const v = vectorize(text, cfg.ngramN);
  let maxSim = 0;
  for (const h of hist) {
    const c = cosine(v, h.v);
    if (c > maxSim) maxSim = c;
  }
  return { maxSim, compared: hist.length };
}

export function emapRecord({ convId, text, cfg }) {
  if (!cfg.enabled) return;
  const store = getStore(convId);
  const v = vectorize(String(text || ''), cfg.ngramN);
  store.vecs.push({ v, len: String(text || '').length, text: String(text || '') });
  const cap = Math.max(cfg.historyN * 2, 20); // modest cap
  if (store.vecs.length > cap) store.vecs.splice(0, store.vecs.length - cap);
}

