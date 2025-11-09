// Build a compact, token-capped style booster string from style tokens.
// Keeps prose in-character without heavy prompt bloat.
import { TokenCounter } from '../../monolith.js';

const MAX_TOKENS = Number(process.env.STYLE_BOOSTER_MAX_TOKENS || 40);
const STYLE_BOOSTER_ENABLED = String(process.env.STYLE_BOOSTER_ENABLED || '1') === '1';

function toReadable(tokens = []) {
  // Turn ["STYLE:noir","CADENCE:staccato","TONE:world-weary","IMAGERY:shadow,neon,rain"]
  // into a terse human hint.
  const kv = tokens.map((t) => {
    const [k, v] = t.split(':', 2);
    return [k?.toLowerCase(), v?.toLowerCase()];
  });
  const map = new Map();
  for (const [k, v] of kv) {
    if (!k || !v) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(v);
  }
  const style = (map.get('style') || []).join(', ');
  const cadence = (map.get('cadence') || []).join(', ');
  const tone = (map.get('tone') || []).join(', ');
  const imagery = (map.get('imagery') || map.get('devices') || map.get('diction') || []).join(', ');
  const bits = [];
  if (style) bits.push(style);
  if (cadence) bits.push(`${cadence} cadence`);
  if (tone) bits.push(`${tone} tone`);
  if (imagery) bits.push(`imagery: ${imagery}`);
  return bits.join(' • ');
}

export function buildStyleBooster(ctx) {
  if (!STYLE_BOOSTER_ENABLED) return null;
  const preset = ctx?.vars?.style?.preset || 'dreamy';
  const toks = ctx?.vars?.style?.tokens || [];
  if (!toks.length) return null;

  // Compose an in-character whisper; keep it subtle.
  let text = `(${toReadable(toks)}. keep continuity; avoid stock phrases; vary sentence rhythm.)`;

  // Hard cap by model-aware token budget.
  const model = ctx?.vars?.__selected_model || ctx?.vars?.model || 'default';
  const est = TokenCounter.estimate(text, { model });
  if (est > MAX_TOKENS) {
    text = TokenCounter.trim(text, MAX_TOKENS, { model });
  }
  return { text, preset, tokenBudget: MAX_TOKENS, estTokens: Math.min(est, MAX_TOKENS) };
}

export default { buildStyleBooster };
