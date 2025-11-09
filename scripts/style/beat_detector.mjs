// beat_detector.mjs — lightweight narrative beat detector + cadence/style planner
//
// Produces a beat state machine over a scalar tension signal inferred from text.
// States: rising -> peak -> falling -> lull (loops).
//
// Inputs per turn: { userText, botPrev, tensionHint? }
// Outputs per turn: { tension, beat, cadence, styleToken, notes[] }
//
const CFG = {
  ENABLED: String(process.env.BEATS_ENABLED ?? '1') === '1',
  // Heuristics
  RISING_THRESH: Number(process.env.BEATS_RISING_THRESHOLD ?? 0.35),
  PEAK_THRESH: Number(process.env.BEATS_PEAK_THRESHOLD ?? 0.72),
  FALLING_THRESH: Number(process.env.BEATS_FALLING_THRESHOLD ?? 0.28),
  // Smoothing & drift
  ALPHA: Number(process.env.BEATS_SMOOTH_ALPHA ?? 0.65), // exp. moving average
  DRIFT: Number(process.env.BEATS_DRIFT_PER_TURN ?? 0.02), // tiny decay toward baseline
  // Cadence presets
  STYLE_RISING: process.env.BEATS_STYLE_RISING || 'descriptive',
  STYLE_PEAK: process.env.BEATS_STYLE_PEAK || 'terse',
  STYLE_FALLING: process.env.BEATS_STYLE_FALLING || 'reflective',
  STYLE_LULL: process.env.BEATS_STYLE_LULL || 'poetic',
  // Cadence text nudges
  CADENCE_RISING:
    process.env.BEATS_CADENCE_RISING ||
    'Build momentum; vivid sensory detail, short-medium sentences.',
  CADENCE_PEAK:
    process.env.BEATS_CADENCE_PEAK || 'High tension; clipped, urgent lines; avoid filler.',
  CADENCE_FALLING:
    process.env.BEATS_CADENCE_FALLING ||
    'Let breath in; decompress the scene with controlled pacing.',
  CADENCE_LULL:
    process.env.BEATS_CADENCE_LULL || 'Slow, lyrical beats; interiority and atmosphere.',
};

// In-memory per conversation
// convId -> { tension: number[0..1], beat: 'rising'|'peak'|'falling'|'lull' }
const STATE = new Map();

const clamp01 = (x) => Math.max(0, Math.min(1, x));

function ensure(convId) {
  if (!STATE.has(convId)) STATE.set(convId, { tension: 0.25, beat: 'lull' });
  return STATE.get(convId);
}

function scoreTextTension(text = '') {
  // Ultra-fast lexical/emotive proxy (language-agnostic-ish).
  // Weighted counts of !, ?, ellipses, strong verbs/adjs, caps clusters.
  const t = String(text || '');
  if (!t) return 0.0;
  let s = 0;
  const ex = (t.match(/!/g) || []).length;
  const q = (t.match(/\?/g) || []).length;
  const dots = (t.match(/\.{3,}/g) || []).length;
  const caps = (t.match(/\b[A-Z\u00C0-\u017F]{2,}\b/g) || []).length;
  const strong = (
    t.match(
      /\b(bleed|shiver|gasp|scream|tremble|rush|pound|panic|surge|crack|snap|burn|clench)\b/gi
    ) || []
  ).length;
  s += ex * 0.08 + q * 0.05 + dots * 0.03 + caps * 0.05 + strong * 0.12;
  // Normalize with length so huge messages don't dominate
  const len = Math.max(40, t.length);
  return clamp01(s * (200 / len));
}

export function detectBeat(convId, { userText = '', botPrev = '', tensionHint = null } = {}) {
  if (!CFG.ENABLED) return { enabled: false };
  const st = ensure(convId);
  const lexical = Math.max(scoreTextTension(userText), scoreTextTension(botPrev));
  const target = tensionHint == null ? lexical : Math.max(lexical, clamp01(Number(tensionHint)));
  // EMA + tiny drift toward baseline 0.25
  const base = 0.25;
  const ema = CFG.ALPHA * target + (1 - CFG.ALPHA) * st.tension;
  let tension = ema + Math.sign(base - ema) * CFG.DRIFT;
  tension = clamp01(tension);

  // State machine
  let beat = st.beat;
  const R = CFG.RISING_THRESH,
    P = CFG.PEAK_THRESH,
    F = CFG.FALLING_THRESH;
  if (tension >= P) beat = 'peak';
  else if (tension >= R && st.beat !== 'peak') beat = 'rising';
  else if (tension <= F && st.beat !== 'lull') beat = 'falling';
  if (st.beat === 'falling' && tension <= base + 0.02) beat = 'lull';
  if (st.beat === 'lull' && tension >= R) beat = 'rising';

  st.tension = tension;
  st.beat = beat;
  STATE.set(convId, st);

  const styleToken =
    beat === 'peak'
      ? CFG.STYLE_PEAK
      : beat === 'rising'
        ? CFG.STYLE_RISING
        : beat === 'falling'
          ? CFG.STYLE_FALLING
          : CFG.STYLE_LULL;

  const cadence =
    beat === 'peak'
      ? CFG.CADENCE_PEAK
      : beat === 'rising'
        ? CFG.CADENCE_RISING
        : beat === 'falling'
          ? CFG.CADENCE_FALLING
          : CFG.CADENCE_LULL;

  return {
    enabled: true,
    tension,
    beat,
    styleToken,
    cadence,
    notes: [{ lexical, target }],
  };
}

export function buildCadenceBooster(plan) {
  if (!plan?.enabled) return null;
  const text = `(Cadence: ${plan.beat}. Style: ${plan.styleToken}. ${plan.cadence})`;
  const estTokens = Math.ceil(text.length / 4);
  return { text, estTokens };
}

export default { detectBeat, buildCadenceBooster };
