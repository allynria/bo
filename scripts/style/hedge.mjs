// style/hedge.mjs — choose an alternate preset/tokens for hedge backup
import StylePrefs from './prefs.mjs';
import Booster from './booster.mjs';
import { ultraFeatureEnabled } from '../loopguard/ultra.mjs';
import { getEntropyCfgFromEnv } from '../loopguard/entropy.mjs';

const { listPresets } = StylePrefs;
const { buildStyleBooster } = Booster;

const STYLE_HEDGE_ENABLED = String(process.env.STYLE_HEDGE_ENABLED || '1') === '1';
const STYLE_HEDGE_SECOND_PRESET = process.env.STYLE_HEDGE_SECOND_PRESET || ''; // if empty, we auto-rotate

export function pickAltPreset(primaryPreset) {
  if (STYLE_HEDGE_SECOND_PRESET) return String(STYLE_HEDGE_SECOND_PRESET).toLowerCase();
  // very simple rotation that contrasts the common presets
  const ring = ['terse','poetic','noir','dreamy','snappy'];
  const i = Math.max(0, ring.indexOf(String(primaryPreset || '').toLowerCase()));
  return ring[(i + 1) % ring.length];
}

export function planStyleHedge(ctx, convId, primaryPreset) {
  try {
    // Respect Ultra as master switch; env is fallback when Ultra OFF
    const id = String(convId || ctx?.vars?.conv_id || '');
    const hedgeOn = ultraFeatureEnabled(id, STYLE_HEDGE_ENABLED);
    if (!hedgeOn) return null;
    const altPreset = pickAltPreset(primaryPreset);
    // Resolve tokens for the alternate preset from preset registry
    let tokens = [];
    try {
      const pres = listPresets();
      const found = pres.find(p => String(p.key || '').toLowerCase() === String(altPreset || '').toLowerCase());
      tokens = Array.isArray(found?.tokens) ? found.tokens : [];
    } catch {}
    if (!Array.isArray(tokens) || tokens.length === 0) return null;
    const fakeCtx = { vars: { style: { preset: altPreset, tokens }, __selected_model: ctx?.vars?.__selected_model, model: ctx?.vars?.model } };
    const booster = buildStyleBooster(fakeCtx);
    if (!booster?.text) return null;
    return { altPreset, tokens, booster };
  } catch {
    return null;
  }
}

export function resolveUltraMode(ctx, convId) {
  const id = String(convId || ctx?.vars?.conv_id || '');
  const hedgeOn = ultraFeatureEnabled(id, STYLE_HEDGE_ENABLED);
  const ent = getEntropyCfgFromEnv();
  const entropyOn = ultraFeatureEnabled(id, !!ent.enabled);
  return { hedgeOn, entropyOn, entropyMin: Number(ent.min || 0), entropyMinLen: Number(ent.minLen || 0) };
}

export function applyUltraMode(ctx, convId) {
  const res = resolveUltraMode(ctx, convId);
  try {
    const v = (ctx.vars ||= {});
    v.__feature_style_hedge = !!res.hedgeOn;
    v.__feature_entropy = !!res.entropyOn;
    v.__entropy_min = res.entropyMin;
    v.__entropy_min_len = res.entropyMinLen;
  } catch {}
  return res;
}

export default { planStyleHedge, pickAltPreset, resolveUltraMode, applyUltraMode };
