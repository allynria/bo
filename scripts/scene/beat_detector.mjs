/**
 * Beat Detector v1 (rules-based)
 * - Maintains per-conversation rolling stats over last K bot turns.
 * - Derives a beat state: 'rising' | 'climax' | 'falling' | 'lull'.
 * - Exposes updateBeat/getBeat/resetBeat + a tension mapping used by cadence/drip.
 *
 * Signals used (cheap heuristics):
 *  - repetitiveness: unique-bigram ratio (lower -> more repetitive)
 *  - pace: char count proxy for output effort (higher -> more intense)
 *  - emotion: keyword hits (very rough)
 *  - novelty: Jaccard over content words vs last reply (lower -> more novel)
 *
 * State transitions (informal HMM-ish rules):
 *  - rising: growing pace or emotion with adequate novelty
 *  - climax: high pace + high emotion + low repetition
 *  - falling: decreasing pace/emotion after rising/climax
 *  - lull: low everything (or degraded novelty with repetition)
 */

const BEAT_WINDOW = Number(process.env.BEAT_WINDOW || 5);
const CLIMAX_MIN_PACE = Number(process.env.BEAT_CLIMAX_MIN_PACE || 380); // chars
const CLIMAX_MIN_EMO = Number(process.env.BEAT_CLIMAX_MIN_EMO || 2); // hits
const REPET_MAX_RATIO = Number(process.env.BEAT_REPET_MAX_RATIO || 0.35); // unique bigram ratio threshold
const RISING_DELTA = Number(process.env.BEAT_RISING_DELTA || 60); // pace increase vs avg
const LULL_MAX_PACE = Number(process.env.BEAT_LULL_MAX_PACE || 140);
const LULL_MIN_REPET = Number(process.env.BEAT_LULL_MIN_REPET || 0.55); // bigram ratio high = repetitive

const EMO_WORDS = (
  process.env.BEAT_EMO_WORDS || [
    'love',
    'hurt',
    'rage',
    'fear',
    'afraid',
    'tremble',
    'cry',
    'tears',
    'ache',
    'yearn',
    'jealous',
    'betray',
    'panic',
    'bleed',
    'pulse',
    'thrill',
    'shiver',
  ]
)
  .toString()
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const STORE = new Map(); // convId -> { turns:[{text,pace,emo,ratio,novel}], lastText, state, tension, ts }

function contentWords(t) {
  return (t || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);
}
function bigramRatio(words) {
  if (words.length < 2) return 1;
  const bigrams = [];
  for (let i = 1; i < words.length; i++) bigrams.push(words[i - 1] + ' ' + words[i]);
  const uniq = new Set(bigrams);
  return uniq.size / bigrams.length; // lower -> more repetitive
}
function emoScore(t) {
  const lw = (t || '').toLowerCase();
  let hits = 0;
  for (const w of EMO_WORDS) {
    if (lw.includes(w)) hits++;
  }
  return hits;
}
function jaccard(a, b) {
  if (!a || !b) return 0;
  const sa = new Set(a),
    sb = new Set(b);
  const inter = [...sa].filter((x) => sb.has(x)).length;
  const uni = new Set([...sa, ...sb]).size;
  return uni ? inter / uni : 0;
}
function noveltyScore(currWords, lastWords) {
  if (!lastWords || !lastWords.length) return 1; // first -> novel
  const j = jaccard(currWords, lastWords);
  return 1 - j; // higher = more novel
}

function decideState(stats) {
  const { avgPace, lastPace, lastEmo, lastRatio, lastNovel, prevAvgPace } = stats;
  const paceRise = lastPace - (prevAvgPace ?? avgPace);

  // CLIMAX: fast + emotional + not repetitive + at least moderate novelty
  if (
    lastPace >= CLIMAX_MIN_PACE &&
    lastEmo >= CLIMAX_MIN_EMO &&
    lastRatio <= REPET_MAX_RATIO &&
    lastNovel >= 0.35
  ) {
    return 'climax';
  }
  // RISING: noticeable pace increase, some emotion, novelty not collapsed
  if (paceRise >= RISING_DELTA && lastNovel >= 0.25 && lastRatio <= 0.6) {
    return 'rising';
  }
  // FALLING: pace/emotion drop after recent higher average
  if ((prevAvgPace ?? avgPace) > LULL_MAX_PACE && lastPace < (prevAvgPace ?? avgPace) - 40) {
    return 'falling';
  }
  // LULL: slow + repetitive or novelty low
  if (lastPace <= LULL_MAX_PACE || lastNovel < 0.15 || lastRatio >= LULL_MIN_REPET) {
    return 'lull';
  }
  return 'lull';
}

function stateToTension(state) {
  switch (state) {
    case 'climax':
      return 0.92;
    case 'rising':
      return 0.72;
    case 'falling':
      return 0.44;
    case 'lull':
      return 0.22;
    default:
      return 0.3;
  }
}

export function updateBeat(convId, { botText, userText }) {
  if (!convId) return null;
  const rec = STORE.get(convId) || { turns: [], lastWords: null, state: 'lull', tension: 0.22 };
  const text = (botText || '').trim();
  const pace = text.length;
  const words = contentWords(text);
  const ratio = bigramRatio(words);
  const emo = emoScore(text);
  const novelty = noveltyScore(words, rec.lastWords);

  const prevAvgPace = rec.turns.length
    ? rec.turns.reduce((a, t) => a + t.pace, 0) / rec.turns.length
    : 0;
  rec.turns.push({ text, pace, emo, ratio, novelty, ts: Date.now() });
  if (rec.turns.length > BEAT_WINDOW) rec.turns.shift();

  const avgPace = rec.turns.reduce((a, t) => a + t.pace, 0) / rec.turns.length;
  const state = decideState({
    avgPace,
    lastPace: pace,
    lastEmo: emo,
    lastRatio: ratio,
    lastNovel: novelty,
    prevAvgPace,
  });
  const tension = stateToTension(state);

  rec.lastWords = words;
  rec.state = state;
  rec.tension = tension;
  rec.ts = Date.now();
  STORE.set(convId, rec);

  return { state, tension, stats: { pace, emo, ratio, novelty, avgPace, prevAvgPace } };
}

export function getBeat(convId) {
  const r = STORE.get(convId);
  if (!r) return { state: 'lull', tension: 0.22, turns: [], ts: 0 };
  return { state: r.state, tension: r.tension, turns: r.turns.slice(-BEAT_WINDOW), ts: r.ts };
}
export function resetBeat(convId) {
  STORE.delete(convId);
  return true;
}

export function forceBeat(convId, state) {
  try {
    const allowed = ['rising', 'climax', 'falling', 'lull'];
    const s = String(state || '').trim();
    if (!allowed.includes(s)) throw new Error('invalid_state');
    const rec = STORE.get(convId) || {
      turns: [],
      lastWords: [],
      state: 'lull',
      tension: 0.22,
      ts: 0,
    };
    const tension = stateToTension(s);
    rec.state = s;
    rec.tension = tension;
    rec.ts = Date.now();
    STORE.set(convId, rec);
    return { state: s, tension };
  } catch {
    return { state: 'lull', tension: 0.22 };
  }
}
