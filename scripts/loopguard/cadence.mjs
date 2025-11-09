/**
 * Simple cadence tracker + style chooser.
 * Tracks per-conversation turn timings and cycles style tokens.
 */

const STATE = new Map(); // convId -> { lastUserTs:number, lastBotTs:number, styleIdx:number }

function get(convId) {
  const k = String(convId || '');
  if (!STATE.has(k)) STATE.set(k, { lastUserTs: 0, lastBotTs: 0, styleIdx: 0 });
  return STATE.get(k);
}

export function getCadenceCfg() {
  return {
    enabled: String(process.env.CADENCE_ENABLED || '1') === '1',
    styleTokens: String(
      process.env.CADENCE_STYLE_TOKENS ||
        process.env.LOOP_GUARD_STYLE_TOKENS ||
        'descriptive,poetic,terse,inner-thought'
    ),
    fastMs: Math.max(500, Number(process.env.CADENCE_FAST_MS || 2500)),
  };
}

export function pushTurn(convId, role = 'user', text = '', cfg = getCadenceCfg()) {
  if (!cfg.enabled) return;
  const s = get(convId);
  const now = Date.now();
  if (role === 'user') s.lastUserTs = now;
  else if (role === 'bot') s.lastBotTs = now;
  STATE.set(String(convId || ''), s);
}

export function chooseStyleForNext(convId, cfg = getCadenceCfg()) {
  if (!cfg.enabled) return { style: '', beat: 'steady' };
  const s = get(convId);
  // Cycle style tokens
  const tokens = String(cfg.styleTokens || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const arr = tokens.length ? tokens : ['descriptive'];
  const idx = (s.styleIdx || 0) % arr.length;
  s.styleIdx = idx + 1;
  // Beat heuristic: time since last user turn
  const dt = s.lastUserTs ? Date.now() - s.lastUserTs : cfg.fastMs;
  const beat = dt <= cfg.fastMs ? 'fast' : 'steady';
  return { style: arr[idx], beat };
}
