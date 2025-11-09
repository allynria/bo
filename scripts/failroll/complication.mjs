// scripts/failroll/complication.mjs
export function isNearMiss({ roll, pFailPercent, band = 5 }) {
  // Fail threshold T in [1..100]; if roll is within band above threshold, it's a "barely success"
  const T = Math.round(pFailPercent);
  return roll > T && (roll - T) <= band;
}

export function buildComplicationBooster({ verb = 'attempt' }) {
  // Diegetic, short, variation-safe
  const table = [
    `(A soft clatter—something goes slightly wrong, consequences linger.)`,
    `(A telltale creak; it works, but a clue is left behind.)`,
    `(You push through—but a thread snags, a shoe scuffs: a small cost.)`,
    `(Close—too close. Success, shadowed by a minor setback.)`,
  ];
  return (
    table[Math.floor(Math.random() * table.length)] + ` (Complication after ${verb}.)`
  );
}

export function applyBeatTensionDelta({ beat = 'rising', outcome = 'success' }) {
  // Outcome ∈ success|fail; beat ∈ rising|climax|falling|steady
  const n = (v, d) => (Number.isFinite(v) ? v : Number(d));
  const env = (k, d) => n(Number(process.env[k]), d);

  let delta = 0;
  if (outcome === 'success') {
    if (beat === 'falling') delta = env('BEAT_DELTA_SUCCESS_FALLING', -0.07);
    else if (beat === 'rising') delta = env('BEAT_DELTA_SUCCESS_RISING', -0.02);
  } else {
    if (beat === 'rising') delta = env('BEAT_DELTA_FAIL_RISING', 0.08);
    else if (beat === 'climax') delta = env('BEAT_DELTA_FAIL_CLIMAX', 0.10);
    else if (beat === 'falling') delta = env('BEAT_DELTA_FAIL_FALLING', 0.04);
  }
  return delta;
}

// Classify fail-roll verbs into coarse style classes for metrics and boosters
// Returns one of: 'stealth' | 'social' | 'physical' | 'generic'
export function classifyVerbStyle(verb = '') {
  const v = String(verb || '').toLowerCase();
  // stealth-oriented intents
  if (/\b(sneak|pick|steal)\b/.test(v)) return 'stealth';
  // social manipulation intents
  if (/\b(lie|charm|intimidat|bluff)\b/.test(v)) return 'social';
  // physically exertive or combat-adjacent intents
  if (/\b(dodge|parry|climb|jump|run|dash|shoot|grapple|hack)\b/.test(v)) return 'physical';
  return 'generic';
}
