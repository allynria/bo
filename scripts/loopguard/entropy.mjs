/**
 * Tiny, fast Shannon-entropy scorer over characters + word stems.
 * Goal: flag low-diversity, templated phrasing without logits.
 *
 * Env flags (read by getEntropyCfgFromEnv):
 * - LOOP_ENTROPY_ENABLED=1
 * - LOOP_ENTROPY_MIN=2.1
 * - LOOP_ENTROPY_MIN_LEN=30
 */
const PUNCT_RE = /[^\p{L}\p{N}\s]/gu;

function norm(text) {
  return String(text || '')
    .toLowerCase()
    .replace(PUNCT_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function charEntropy(s) {
  if (!s) return 0;
  const m = new Map();
  for (let i=0;i<s.length;i++) m.set(s[i], (m.get(s[i])||0)+1);
  const n = s.length;
  let H = 0;
  for (const c of m.values()) {
    const p = c / n;
    H -= p * Math.log2(p);
  }
  return H; // bits per symbol
}

function stem(word) {
  // ultra-tiny stemmer: drop common suffixes
  return word.replace(/(ing|ed|ly|es|s)$/,'');
}

function wordEntropy(s) {
  const toks = s.split(' ').filter(Boolean).map(stem);
  if (!toks.length) return 0;
  const m = new Map();
  for (const t of toks) m.set(t, (m.get(t)||0)+1);
  const n = toks.length;
  let H = 0;
  for (const c of m.values()) {
    const p = c / n;
    H -= p * Math.log2(p);
  }
  return H;
}

export function getEntropyCfgFromEnv() {
  return {
    enabled: process.env.LOOP_ENTROPY_ENABLED === '1',
    min: Number(process.env.LOOP_ENTROPY_MIN || 2.1),
    minLen: Number(process.env.LOOP_ENTROPY_MIN_LEN || 30),
  };
}

/**
 * Returns { charH, wordH, score } where score is a blended index.
 */
export function entropyScore(text) {
  const t = norm(text);
  const ch = charEntropy(t);
  const wh = wordEntropy(t);
  // Blend favors word entropy but keeps char entropy as floor
  const score = 0.65 * wh + 0.35 * ch;
  return { charH: ch, wordH: wh, score };
}

