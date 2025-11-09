// Style preference registry (per conv) with showcase presets.
// Exposes: listPresets(), getStylePref(convId), setStylePref(convId, { preset, overrides })
// and resolveStyleTokens(convId) → array of lightweight "style tokens".

const DEFAULT_PRESET = (process.env.STYLE_DEFAULT_PRESET || 'dreamy').toLowerCase();

const PRESETS = Object.freeze({
  noir: {
    label: 'Noir',
    tokens: [
      'STYLE:noir',
      'CADENCE:staccato',
      'TONE:world-weary',
      'DICTION:hardboiled',
      'IMAGERY:shadow,neon,rain',
    ],
    hint: 'Write like a neon-soaked detective tale—short, punchy sentences; gritty metaphors; keep it lean.'
  },
  dreamy: {
    label: 'Dreamy',
    tokens: [
      'STYLE:dreamy',
      'CADENCE:lilting',
      'TONE:intimate',
      'DICTION:soft',
      'IMAGERY:rain,breath,skin,light',
    ],
    hint: 'A soft, cinematic flow; intimate sensory details; gentle metaphors; avoid harsh verbs.'
  },
  snappy: {
    label: 'Snappy',
    tokens: [
      'STYLE:snappy',
      'CADENCE:quick',
      'TONE:wry',
      'DICTION:plain',
      'STRUCTURE:dialogue-forward',
    ],
    hint: 'Fast beats; cut filler; prefer dialogue and action; avoid long descriptions.'
  },
  poetic: {
    label: 'Poetic',
    tokens: [
      'STYLE:poetic',
      'CADENCE:flowing',
      'TONE:lyrical',
      'DEVICES:alliteration,internal-rhyme',
    ],
    hint: 'Lyrical phrasing and subtle musicality; vivid images; keep coherence.'
  },
  terse: {
    label: 'Terse',
    tokens: [
      'STYLE:terse',
      'CADENCE:clipped',
      'TONE:cool',
      'ADJECTIVES:minimal',
    ],
    hint: 'Minimal adjectives. Short lines. Let subtext carry the scene.'
  },
});

const store = new Map(); // convId -> { preset, overrides, updatedAt }

export function listPresets() {
  // Public shape for UI
  return Object.entries(PRESETS).map(([key, v]) => ({
    key, label: v.label, tokens: v.tokens, hint: v.hint
  }));
}

export function getStylePref(convId) {
  const pref = store.get(convId);
  if (pref) return pref;
  // lazy default (don’t save until set)
  return { preset: DEFAULT_PRESET, overrides: {}, updatedAt: 0 };
}

export function setStylePref(convId, { preset, overrides } = {}) {
  const key = (preset || DEFAULT_PRESET).toLowerCase();
  const base = PRESETS[key] ? key : DEFAULT_PRESET;
  const prev = store.get(convId);
  const merged = {
    preset: base,
    overrides: { ...(prev?.overrides || {}), ...(overrides || {}) },
    updatedAt: Date.now(),
  };
  store.set(convId, merged);
  return merged;
}

export function resolveStyleTokens(convId) {
  const { preset, overrides } = getStylePref(convId);
  const base = PRESETS[preset] || PRESETS[DEFAULT_PRESET];
  // apply simple overrides: { add: string[], remove: string[] }
  const add = Array.isArray(overrides?.add) ? overrides.add : [];
  const remove = new Set(Array.isArray(overrides?.remove) ? overrides.remove : []);
  const dedup = new Set();
  for (const t of base.tokens) if (!remove.has(t)) dedup.add(t);
  for (const t of add) dedup.add(t);
  return Array.from(dedup);
}

export function getPresetHint(presetKey) {
  const p = PRESETS[presetKey];
  return p?.hint || '';
}

export default {
  listPresets, getStylePref, setStylePref, resolveStyleTokens, getPresetHint
};

