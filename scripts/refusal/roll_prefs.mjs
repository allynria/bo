// Failure-roll style preference registry (per conv), similar to refusal prefs
// Exposes:
// - listRollStyles()
// - getRollPref(convId)
// - setRollPref(convId, { style })
// - getRollStyle(convId)
// - getRollHint(style) — simple preview string for UI/tests

const DEFAULT_STYLE = String(
  process.env.FAIL_ROLLS_DEFAULT_STYLE
  || process.env.FAIL_ROLLS_STYLE
  || process.env.FAILROLL_DEFAULT_STYLE
  || process.env.FAILROLL_STYLE
  || 'neutral'
).toLowerCase();

const allowed = new Set(['neutral', 'terse', 'poetic']);

function normalize(style) {
  const s = String(style || DEFAULT_STYLE).toLowerCase();
  return allowed.has(s) ? s : 'neutral';
}

const store = new Map(); // convId -> { style, overrides, updatedAt }

export function listRollStyles() {
  return [
    { key: 'neutral', label: 'Neutral', hint: getRollHint('neutral') },
    { key: 'terse', label: 'Terse', hint: getRollHint('terse') },
    { key: 'poetic', label: 'Poetic', hint: getRollHint('poetic') },
  ];
}

export function getRollPref(convId) {
  const pref = store.get(convId);
  if (pref) return pref;
  return { style: normalize(DEFAULT_STYLE), overrides: {}, updatedAt: 0 };
}

export function getRollStyle(convId) {
  const pref = store.get(convId);
  return normalize(pref?.style || DEFAULT_STYLE);
}

export function setRollPref(convId, { style, overrides } = {}) {
  const prev = store.get(convId);
  const merged = {
    style: normalize(style || prev?.style || DEFAULT_STYLE),
    overrides: { ...(prev?.overrides || {}), ...(overrides || {}) },
    updatedAt: Date.now(),
  };
  store.set(convId, merged);
  return merged;
}

export function getRollHint(style) {
  const s = normalize(style);
  const action = 'pick lock';
  const pct = 45;
  const success = true;
  if (s === 'terse') return `(${action}: ${pct}% — ${success ? 'success' : 'failed'}.)`;
  if (s === 'poetic') return success
    ? `(Fortune leans their way—${action} (${pct}%) succeeds.)`
    : `(Fortune turns her face—${action} (${pct}%) fails.)`;
  // neutral
  return success
    ? `(Attempt: ${action} — chance ${pct}%. Outcome: success.)`
    : `(Attempt: ${action} — chance ${pct}%. Outcome: failure.)`;
}

export default {
  listRollStyles,
  getRollPref,
  setRollPref,
  getRollStyle,
  getRollHint,
};
