// Lightweight failure-rolls helper: detects a risky action, computes chance,
// and returns an in-character booster hint for the model to narrate success/failure.
//
// Env knobs:
//   FAIL_ROLLS_ENABLED=1
//   FAIL_ROLLS_BASE=0.4
//   FAIL_ROLLS_TRUST_BONUS=0.4
//   FAIL_ROLLS_SUSP_PENALTY=0.3
//   FAIL_ROLLS_TENSION_BONUS=0.2
//   FAIL_ROLLS_MIN=0.05
//   FAIL_ROLLS_MAX=0.95
//   FAIL_ROLLS_STYLE=(terse|neutral|poetic)
//
// Export:
//   assessRiskyAction({ text, trust, suspicion, tension, style }): { action|null, chance, success, hint }

const DEFAULTS = {
  // Support both legacy FAIL_ROLLS_* and new FAILROLL_* envs
  base: num(process.env.FAIL_ROLLS_BASE ?? process.env.FAILROLL_BASE_CHANCE, 0.4),
  // trustBonus maps from FAILROLL_TRUST_WEIGHT (which affects failure prob).
  // Negative weight means trust reduces failure; for success chance this is a positive bonus.
  trustBonus: (() => {
    const legacy = num(process.env.FAIL_ROLLS_TRUST_BONUS, NaN);
    if (Number.isFinite(legacy)) return legacy;
    const w = num(process.env.FAILROLL_TRUST_WEIGHT, NaN);
    return Number.isFinite(w) ? -w : 0.4;
  })(),
  suspPenalty: (() => {
    const legacy = num(process.env.FAIL_ROLLS_SUSP_PENALTY, NaN);
    if (Number.isFinite(legacy)) return legacy;
    const w = num(process.env.FAILROLL_SUSPICION_WEIGHT, NaN);
    return Number.isFinite(w) ? w : 0.3;
  })(),
  tensionBonus: (() => {
    const legacy = num(process.env.FAIL_ROLLS_TENSION_BONUS, NaN);
    if (Number.isFinite(legacy)) return legacy;
    const w = num(process.env.FAILROLL_TENSION_WEIGHT, NaN);
    return Number.isFinite(w) ? w : 0.2;
  })(),
  min: num(process.env.FAIL_ROLLS_MIN ?? process.env.FAILROLL_MIN, 0.05),
  max: num(process.env.FAIL_ROLLS_MAX ?? process.env.FAILROLL_MAX, 0.95),
  style: (process.env.FAIL_ROLLS_STYLE || process.env.FAILROLL_STYLE || 'neutral').toLowerCase()
};

const RISKY = [
  ['sneak', /\b(sneak|sneaking|sneaks|sneaked|stealth|slip past)\b/i],
  ['pick_lock', /\b(pick(s|ing)?\s+the?\s*lock|lockpick|lock pick)\b/i],
  ['convince', /\b(convince|persuade|talk (?:them|her|him) into)\b/i],
  ['deceive', /\b(lie|deceive|bluff|fabricate|pretend)\b/i],
  ['intimidate', /\b(intimidate|threaten|coerce)\b/i],
  ['steal', /\b(steal|pickpocket|snatch|lift)\b/i],
  ['dodge', /\b(dodge|evade|sidestep)\b/i],
  ['parry', /\b(parry|deflect)\b/i],
  ['shoot', /\b(shoot|fire (?:an|the) arrow|take (?:the )?shot)\b/i],
  ['hack', /\b(hack|bypass (?:security|firewall)|override)\b/i],
  ['climb', /\b(climb|scale (?:the )?wall|ascend)\b/i],
  ['jump_gap', /\b(jump (?:the )?gap|leap across)\b/i],
];

export function assessRiskyAction({ text, trust = 0.5, suspicion = 0.0, tension = 0.5, style }) {
  if (!text || !processEnabled()) return { action: null, chance: 0, success: true, hint: '' };
  const action = detect(text);
  if (!action) return { action: null, chance: 0, success: true, hint: '' };

  const { base, trustBonus, suspPenalty, tensionBonus, min, max } = DEFAULTS;
  const chanceRaw =
    base
    + clamp01(trust) * trustBonus
    + clamp01(tension) * tensionBonus
    - clamp01(suspicion) * suspPenalty;

  const chance = clamp(min, max, chanceRaw);
  const success = Math.random() < chance;
  const hint = renderHint(action, chance, success, String(style || DEFAULTS.style || 'neutral').toLowerCase());
  return { action, chance, success, hint };
}

function detect(text) {
  for (const [name, rx] of RISKY) {
    if (rx.test(text)) return name;
  }
  return null;
}

function renderHint(action, chance, success, style) {
  const pct = Math.round(chance * 100);
  const tag = success ? 'success' : 'failed';
  if (style === 'terse') {
    return `(${title(action)}: ${pct}% — ${tag}.)`;
  }
  if (style === 'poetic') {
    return success
      ? `(Fortune leans their way—${title(action)} (${pct}%) succeeds.)`
      : `(Fortune turns her face—${title(action)} (${pct}%) fails.)`;
  }
  // neutral
  return success
    ? `(Attempt: ${title(action)} — chance ${pct}%. Outcome: success.)`
    : `(Attempt: ${title(action)} — chance ${pct}%. Outcome: failure.)`;
}

function title(s) {
  return String(s || '').replace(/_/g, ' ');
}

function clamp(lo, hi, v) {
  return Math.max(lo, Math.min(hi, v));
}
function clamp01(v) { return clamp(0, 1, Number(v || 0)); }
function num(x, d) { const n = Number(x); return Number.isFinite(n) ? n : d; }
function processEnabled() { return String(process.env.FAIL_ROLLS_ENABLED || process.env.FAILROLL_ENABLED || '') === '1'; }
