// Lightweight tension & beat modeling (no LLM).
// Computes a 0..10 tension score and {rising|high|falling|lull} beat
// from simple textual + temporal features, then smooths over a small window.
// Intended to run per turn (message or stream).
// Env tuning: TENSION_ENABLED, TENSION_WINDOW_TURNS, TENSION_SMOOTHING, TENSION_WEIGHTS (JSON)

const DEFAULT_WINDOW = Number(process.env.TENSION_WINDOW_TURNS || 5);
const SMOOTH = Number(process.env.TENSION_SMOOTHING || 0.4); // [0..1]
const ENABLED = !!Number(process.env.TENSION_ENABLED || 1);
const WEIGHTS = (() => {
  try {
    return JSON.parse(process.env.TENSION_WEIGHTS || '{}');
  } catch {
    return {};
  }
})();

const W = {
  exclaim: WEIGHTS.exclaim ?? 1.2,
  question: WEIGHTS.question ?? 0.5,
  conflict: WEIGHTS.conflict ?? 1.0,
  negemo: WEIGHTS.negemo ?? 0.8,
  posemo: WEIGHTS.posemo ?? 0.6,
  longRun: WEIGHTS.longRun ?? 0.6, // longer line than recent median
  shortRun: WEIGHTS.shortRun ?? 0.2, // very short can also be punchy
  pause: WEIGHTS.pause ?? 0.7, // long gap since last user msg
};

const CONFLICT_WORDS = new Set([
  'argue',
  'fight',
  'shout',
  'scream',
  'threaten',
  'attack',
  'bleed',
  'break',
  'slam',
  'ruin',
  'kill',
  'die',
  'betray',
  'panic',
  'fear',
  'hurt',
  'hit',
  'stab',
  'gun',
  'blood',
  'choke',
  'burn',
  'drown',
  'wound',
]);
const NEG = new Set([
  'no',
  'not',
  'never',
  'can’t',
  'wont',
  'won’t',
  'stop',
  'don’t',
  'without',
  'afraid',
  'alone',
]);
const POS = new Set([
  'love',
  'promise',
  'safe',
  'warm',
  'gentle',
  'hope',
  'trust',
  'together',
  'okay',
  'calm',
]);

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const clamp10 = (x) => (x < 0 ? 0 : x > 10 ? 10 : x);

function features(text, dtMs, lenMedian) {
  const t = (text || '').toLowerCase();
  const exclaim = (t.match(/!/g) || []).length;
  const question = (t.match(/\?/g) || []).length;
  // rough word lists (cheap):
  let conflict = 0,
    negemo = 0,
    posemo = 0;
  for (const w of t.split(/\W+/)) {
    if (!w) continue;
    if (CONFLICT_WORDS.has(w)) conflict++;
    if (NEG.has(w)) negemo++;
    if (POS.has(w)) posemo++;
  }
  const len = t.length;
  const longRun = lenMedian > 0 ? (len > lenMedian * 1.25 ? 1 : 0) : 0;
  const shortRun = lenMedian > 0 ? (len < lenMedian * 0.5 ? 1 : 0) : 0;
  const pause = dtMs >= 2000 ? Math.min(1, dtMs / 15000) : 0; // 0..1
  return { exclaim, question, conflict, negemo, posemo, longRun, shortRun, pause, len };
}

function scoreFrom(feat) {
  // Normalize counts lightly and weight; convert to 0..10
  const base =
    clamp01(feat.exclaim / 3) * W.exclaim +
    clamp01(feat.question / 3) * W.question +
    clamp01(feat.conflict / 3) * W.conflict +
    clamp01(feat.negemo / 4) * W.negemo +
    clamp01(feat.posemo / 4) * W.posemo +
    feat.longRun * W.longRun +
    feat.shortRun * W.shortRun +
    feat.pause * W.pause;
  return clamp10(base * 2.0); // scale into 0..10
}

function beatFrom(prev, curr) {
  if (curr >= 7.5) return 'high';
  if (curr <= 2.0) return 'lull';
  // rising/falling depends on delta
  const delta = curr - (prev ?? curr);
  if (delta > 0.7) return 'rising';
  if (delta < -0.7) return 'falling';
  // stay in prior beat if meaningful, else neutral bias:
  return curr >= 5 ? 'rising' : 'falling';
}

const state = new Map(); // convId -> { turns: [], lastUserTs, lenWindow: [], smoothed, last }

export function tensionEnabled() {
  return ENABLED;
}

export function updateTension(convId, userText, nowMs = Date.now()) {
  if (!ENABLED) return { tension: 0, beat: 'lull', raw: 0 };
  let st = state.get(convId);
  if (!st) {
    st = { turns: [], lastUserTs: 0, lenWindow: [], smoothed: 0, last: 0 };
    state.set(convId, st);
  }

  const dtMs = st.lastUserTs ? nowMs - st.lastUserTs : 0;
  const lenMedian = median(st.lenWindow);
  const f = features(userText, dtMs, lenMedian);
  const raw = scoreFrom(f);
  const smoothed = clamp10(SMOOTH * raw + (1 - SMOOTH) * (st.smoothed || raw));
  const beat = beatFrom(st.smoothed, smoothed);

  // keep short windows
  st.turns.push({ ts: nowMs, raw, smoothed, beat, len: f.len });
  if (st.turns.length > DEFAULT_WINDOW) st.turns.shift();
  st.lenWindow.push(f.len);
  if (st.lenWindow.length > Math.max(DEFAULT_WINDOW * 2, 12)) st.lenWindow.shift();
  st.lastUserTs = nowMs;
  st.smoothed = smoothed;
  st.last = raw;

  return { tension: smoothed, beat, raw };
}

export function getTensionSnapshot(convId) {
  const st = state.get(convId);
  if (!st) return { tension: 0, beat: 'lull', turns: [] };
  return {
    tension: st.smoothed || 0,
    beat: st.turns.at(-1)?.beat || 'lull',
    turns: st.turns.slice(-DEFAULT_WINDOW),
  };
}

function median(a) {
  if (!a || !a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export default { tensionEnabled, updateTension, getTensionSnapshot };
