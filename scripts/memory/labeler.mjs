/**
 * Ultra-cheap, deterministic-ish labeler. Optional LLM refinement can be added later.
 */
const RE = {
  confession: /\b(i never stopped loving you|i love you|forgive me|confess)\b/i,
  promise: /\b(promise|swear|vow)\b/i,
  secret: /\b(secret|don’t tell|don't tell|no one can know)\b/i,
  death: /\b(died|dead|killed|murdered)\b/i,
  injury: /\b(scar|wound|blood|bleeding|injury|burn|orphanage)\b/i,
  trigger: /\b(trigger|flinch|panic|afraid|fear)\b/i,
  location: /\b(bridge|harbor|orphanage|forest|inn|castle|train)\b/i,
};
const ORDER = ['confession', 'promise', 'secret', 'death', 'injury', 'trigger', 'location'];

export function labelExchange(userText = '', assistantText = '') {
  const chunk = `${userText}\n${assistantText}`.slice(0, 2000);
  const found = [];
  for (const k of ORDER) if (RE[k]?.test(chunk)) found.push(k);
  const imp = Math.min(1, 0.4 + 0.1 * found.length); // 0.4..1.0
  const type = found[0] || (chunk.length > 40 ? 'other' : null);
  return { type, importance: type ? imp : 0, who: 'user' };
}
