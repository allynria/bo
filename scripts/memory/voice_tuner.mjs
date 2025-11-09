// Lightweight “voice tuner” for the micro-summarizer boosters.
// Chooses a compact style hint based on env or ctx (genre/world).
// ENV:
//   BOOSTER_TONE=romance|horror|noir|fantasy|scifi|slice|drama|custom
//   BOOSTER_TONE_CUSTOM="comma separated micro hints"
//   BOOSTER_TONE_WEIGHT=1..3 (how strongly to insist in the system prompt)

const PRESETS = {
  romance:  ["tender", "sensory", "intimate", "yearning"],
  horror:   ["unease", "ominous", "tension", "subtle dread"],
  noir:     ["wry", "tight", "streetwise", "shadowed"],
  fantasy:  ["mythic", "lush", "arcane", "windswept"],
  scifi:    ["crisp", "futuristic", "clinical emotion", "clean imagery"],
  slice:    ["casual", "grounded", "everyday", "warm"],
  drama:    ["charged", "poised", "layered feeling", "measured"],
};

export function getVoiceHints(ctx) {
  const tone = (process.env.BOOSTER_TONE || '').toLowerCase();
  const weight = Math.max(1, Math.min(3, Number(process.env.BOOSTER_TONE_WEIGHT || 2)));
  let hints = [];
  if (tone && PRESETS[tone]) hints = PRESETS[tone];
  if (tone === 'custom' && process.env.BOOSTER_TONE_CUSTOM) {
    hints = String(process.env.BOOSTER_TONE_CUSTOM)
      .split(',').map(s => s.trim()).filter(Boolean).slice(0, 6);
  }
  // Optional contextual nudge:
  const world = ctx?.vars?.world || ctx?.vars?.setting || '';
  if (world && hints.length < 6) hints.push(world);
  // System hint string
  const insist = "!" .repeat(weight); // e.g., !! to emphasize
  const hintLine = hints.length ? `Style${insist}: ${hints.join(', ')}.` : '';
  return hintLine;
}

