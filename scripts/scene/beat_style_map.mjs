/**
 * Beat → Style hints
 * Default mapping (overridable via BEAT_STYLE_MAP_JSON):
 *   lull    → terse (short, clipped, concrete)
 *   rising  → descriptive (sensory detail, momentum)
 *   climax  → poetic (figurative, rhythmic, vivid)
 *   falling → reflective (introspective, quieter)
 *
 * Exposes:
 *  - getStyleForBeat(state): { token, desc }
 *  - buildStyleBooster(style): "(Style: terse — keep sentences short, concrete. Avoid filler.)"
 */
const DEFAULT_MAP = {
  lull: { token: 'terse', desc: 'short, clipped, concrete; avoid filler; keep momentum low' },
  rising: { token: 'descriptive', desc: 'sensory detail; kinetic verbs; build momentum' },
  climax: { token: 'poetic', desc: 'vivid images; compressed metaphors; rhythm and heat' },
  falling: {
    token: 'reflective',
    desc: 'introspective; softer cadence; aftermath; inner thoughts',
  },
};

let STYLE_MAP = DEFAULT_MAP;

try {
  if (process.env.BEAT_STYLE_MAP_JSON) {
    const j = JSON.parse(process.env.BEAT_STYLE_MAP_JSON);
    const merged = { ...DEFAULT_MAP };
    for (const k of Object.keys(j)) {
      if (merged[k]) merged[k] = { ...merged[k], ...j[k] };
    }
    STYLE_MAP = merged;
  }
} catch (e) {
  // fall back silently
}

export function getStyleForBeat(state) {
  const key = (state || 'lull').toLowerCase();
  return STYLE_MAP[key] || STYLE_MAP.lull;
}

export function buildStyleBooster(style) {
  const { token, desc } = style || {};
  // Parenthetical "in-character" hint; compact to ~1 line.
  return `(Style: ${token} — ${desc}.)`;
}
