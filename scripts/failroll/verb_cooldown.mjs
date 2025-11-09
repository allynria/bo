const buckets = new Map(); // convId -> Map(verb -> ts)

export function markVerbUsage(convId, verb) {
  try {
    const cid = String(convId || '').trim();
    const v = String(verb || '')
      .toLowerCase()
      .trim();
    if (!cid || !v) return;
    let m = buckets.get(cid);
    if (!m) {
      m = new Map();
      buckets.set(cid, m);
    }
    m.set(v, Date.now());
  } catch {}
}

export function getVerbPenalty(convId, verb, now = Date.now()) {
  try {
    if (!Number(process.env.FAILROLL_VERB_COOLDOWN_ENABLED || '0')) return 0;
    const win = Number(process.env.FAILROLL_VERB_COOLDOWN_MS || '90000');
    const penalty = Number(process.env.FAILROLL_VERB_COOLDOWN_PENALTY || '0.06');
    const cid = String(convId || '').trim();
    const v = String(verb || '')
      .toLowerCase()
      .trim();
    if (!cid || !v) return 0;
    const m = buckets.get(cid);
    if (!m) return 0;
    const ts = m.get(v);
    if (!ts) return 0;
    return now - ts <= win ? penalty : 0;
  } catch {
    return 0;
  }
}
