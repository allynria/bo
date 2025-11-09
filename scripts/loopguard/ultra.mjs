/**
 * Ultra Mode: default-on per conversation unless explicitly disabled by the user.
 * Features covered: styleHedge, entropy, cadence. (Phrase decay stays env-only.)
 */
const STORE = new Map(); // convId -> { enabled:boolean, ts:number }

export function ultraDefaultOn(){
  // default ON unless explicitly disabled. Support both ULTRA_DEFAULT_ON and legacy ULTRA_DEFAULT.
  const raw = String(process.env.ULTRA_DEFAULT_ON ?? process.env.ULTRA_DEFAULT ?? '1');
  const v = raw.trim().toLowerCase();
  // Treat '1' or 'true' as ON; '0' or 'false' as OFF
  if (v === '0' || v === 'false') return false;
  return true;
}

export function getUltraState(convId){
  const key = String(convId || '');
  const cur = STORE.get(key);
  if (!cur) return { enabled: ultraDefaultOn(), ts: 0 };
  return cur;
}

export function setUltraState(convId, enabled){
  const key = String(convId || '');
  const state = { enabled: !!enabled, ts: Date.now() };
  STORE.set(key, state);
  return state;
}

export function toggleUltra(convId){
  const cur = getUltraState(convId).enabled;
  return setUltraState(convId, !cur);
}

/** Resolve effective feature enablement with Ultra as master on-switch. */
export function ultraFeatureEnabled(convId, featureEnvEnabled){
  const u = getUltraState(convId).enabled;
  // Ultra ON forces feature ON; Ultra OFF falls back to env flag.
  return u ? true : !!featureEnvEnabled;
}

/** Snapshot for admin/debug */
export function ultraSnapshot(){
  const out = [];
  for (const [convId, v] of STORE.entries()){
    out.push({ conv_id: convId, enabled: v.enabled, ts: v.ts });
  }
  return { default_on: ultraDefaultOn(), entries: out };
}
