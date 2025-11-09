const ARCS = new Map(); // conv_id -> { current: string, at: number }

export function setArc(convId, arcName) {
  const name = String(arcName || '').trim();
  if (!name) return { ok: false, error: 'arc_name_required' };
  ARCS.set(convId, { current: name, at: Date.now() });
  return { ok: true, arc: name };
}

export function getArc(convId) {
  const v = ARCS.get(convId);
  return { ok: true, arc: v?.current || null, at: v?.at || 0 };
}

// Simple heuristic: pull capitalized noun phrases or known scene tokens
export function inferArcFromText(text) {
  const t = String(text || '');
  const m = t.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\b/g);
  return m?.[0] || null;
}
