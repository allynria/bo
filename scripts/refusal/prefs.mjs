// Refusal style preference registry (per conv), mirroring style/prefs.mjs
// Exposes:
// - listRefusalStyles()
// - getRefusalPref(convId)
// - setRefusalPref(convId, { style })
// - getRefusalHint(style)

import { defaultStyles, normalizeStyle, renderRefusal } from './refusal_templates.mjs';

const DEFAULT_STYLE = (process.env.REFUSAL_DEFAULT_STYLE || 'firm').toLowerCase();

const store = new Map(); // convId -> { style, overrides, updatedAt }

export function listRefusalStyles() {
  // Provide UI-friendly listing of available refusal styles
  return Object.keys(defaultStyles).map((key) => ({
    key,
    label: key.charAt(0).toUpperCase() + key.slice(1),
    hint: getRefusalHint(key),
  }));
}

export function getRefusalPref(convId) {
  const pref = store.get(convId);
  if (pref) return pref;
  // Lazy default (don’t save until explicitly set)
  return { style: DEFAULT_STYLE, overrides: {}, updatedAt: 0 };
}

export function setRefusalPref(convId, { style, overrides } = {}) {
  const key = normalizeStyle(style || DEFAULT_STYLE);
  const prev = store.get(convId);
  const merged = {
    style: key,
    overrides: { ...(prev?.overrides || {}), ...(overrides || {}) },
    updatedAt: Date.now(),
  };
  store.set(convId, merged);
  return merged;
}

export function getRefusalHint(style) {
  const s = normalizeStyle(style || DEFAULT_STYLE);
  // Minimal refusal line rendered for preview and memory hinting
  return renderRefusal({ style: s });
}

export default {
  listRefusalStyles,
  getRefusalPref,
  setRefusalPref,
  getRefusalHint,
};
