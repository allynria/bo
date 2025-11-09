// scripts/state/refusal_templates.mjs
export const REFUSAL_TEMPLATES = {
  firm: ["No. That won't happen. You know why.", 'Absolutely not. That crosses a line.'],
  soft: ["I'm sorry, but I can't do that.", "I won't—there are things I won't betray."],
  sarcastic: ['What do you think I am, immortal?', 'Try again. Preferably with physics intact.'],
  guarded: ['Not with how things are between us.', 'Trust me first. Then ask again.'],
};

export function pickRefusal({ style = 'firm', mood = 'neutral', suspicion = 0.1 }) {
  // blend mood into style a bit
  if (mood === 'annoyed' || mood === 'hostile') style = style === 'soft' ? 'firm' : style;
  if (suspicion > 0.6 && style === 'soft') style = 'guarded';
  const bank = REFUSAL_TEMPLATES[style] || REFUSAL_TEMPLATES.firm;
  const rng = () => (globalThis.__RNG__ ? globalThis.__RNG__() : Math.random());
  return bank[Math.floor(rng() * bank.length)];
}

// Build a short booster that gently (or strongly) guides refusal
export function buildRefusalBooster({
  character = 'She',
  reason,
  style = 'firm',
  mood = 'neutral',
}) {
  const line = pickRefusal({ style, mood });
  const r = reason ? ` Reason: ${reason}.` : '';
  return `(${character} refuses: ${line}${r})`;
}
