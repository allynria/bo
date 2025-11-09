/**
 * Beat → Cadence hints
 * Overridable via CADENCE_MAP_JSON, e.g.:
 *  {"climax":{"mean":15,"min":4,"max":26,"burstPct":0.35,"note":"let rhythm punch"}}
 *
 * Exposes:
 *  - getCadenceForBeat(state): { mean, min, max, burstPct, note }
 *  - buildCadenceHint(c): "(Cadence: aim ~12 words; vary lengths; 20–60% very short.)"
 */
const DEFAULT = {
  lull:    { mean: 8,  min: 4,  max: 14, burstPct: 0.15, note: "keep it clipped; concrete beats" },
  rising:  { mean: 12, min: 6,  max: 20, burstPct: 0.20, note: "add kinetic verbs; build pace" },
  climax:  { mean: 16, min: 4,  max: 26, burstPct: 0.30, note: "mix staccato and surges; visceral" },
  falling: { mean: 13, min: 8,  max: 22, burstPct: 0.10, note: "soften; reflective aftermath" },
};

let MAP = DEFAULT;
try {
  if (process.env.CADENCE_MAP_JSON) {
    const j = JSON.parse(process.env.CADENCE_MAP_JSON);
    const m = { ...DEFAULT };
    for (const k of Object.keys(j)) if (m[k]) m[k] = { ...m[k], ...j[k] };
    MAP = m;
  }
} catch { /* noop */ }

export function getCadenceForBeat(state) {
  const key = (state || 'lull').toLowerCase();
  return MAP[key] || MAP.lull;
}

export function buildCadenceHint(c) {
  const { mean, min, max, burstPct, note } = c || {};
  const burst = Math.round((burstPct || 0) * 100);
  // Keep it tight and “in character” as a parenthetical
  return `(Cadence: aim ~${mean} words; vary ${min}–${max}; ${burst}% very short; ${note}.)`;
}

