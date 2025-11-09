/**
 * Build tiny, in-character injections (no OOC).
 */
import { SafeText, sampled } from '../../monolith.js';

const MAX_RECAP_CHARS = Math.max(
  40,
  Math.min(240, Number(process.env.MEMORY_RECAP_MAX_CHARS || 200))
);
const MAX_CUE_CHARS = Math.max(40, Math.min(140, Number(process.env.MEMORY_CUE_MAX_CHARS || 90)));
const MAX_FACET_CHARS = Math.max(
  40,
  Math.min(220, Number(process.env.MEMORY_FACET_MAX_CHARS || 160))
);

export function buildRecapLine(strRecap) {
  if (!strRecap) return '';
  const clean = SafeText.clamp(SafeText.stripDangerous(String(strRecap || '')), MAX_RECAP_CHARS);
  const out = `(${clean})\n`;
  if (clean.length < String(strRecap || '').length)
    sampled('debug', 0.02, '[injectors] recap truncated/sanitized');
  return out;
}

export function pickEpisodicCue(ef) {
  // Pick one salient EF item for nudge
  const items = ef?.items || [];
  const last = items.slice(-6); // recent pool
  return last.reverse().find((x) => x.t !== 'other') || last[0] || null;
}

export function renderEpisodicCue(item) {
  if (!item) return '';
  // Keep it tiny and evocative
  if (item.t === 'injury' && /scar/i.test(item.txt))
    return 'She feels the old scar beneath her sleeve.';
  if (item.t === 'confession') return 'His mind replays her whisper: “I never stopped loving you.”';
  if (item.t === 'promise') return 'The promise on the bridge still stings.';
  if (item.t === 'secret') return 'They still share that secret under the stars.';
  if (item.t === 'location') return 'The air still smells like rain by the bridge.';
  const base = SafeText.stripDangerous(String(item.txt || ''));
  const out = SafeText.clamp(base, MAX_CUE_CHARS);
  if (out.length < base.length)
    sampled('debug', 0.02, '[injectors] episodic cue truncated/sanitized');
  return out;
}

export function renderFacetEcho(facet) {
  if (!facet) return '';
  const bits = [];
  if (facet.rel) bits.push(SafeText.stripDangerous(String(facet.rel)));
  if (facet.fear) bits.push(`fear: ${SafeText.stripDangerous(String(facet.fear))}`);
  if (facet.key) bits.push(SafeText.stripDangerous(String(facet.key)));
  const joined = bits.filter(Boolean).join(' · ');
  if (!joined) return '';
  const s = SafeText.clamp(joined, MAX_FACET_CHARS);
  if (s.length < joined.length)
    sampled('debug', 0.02, '[injectors] facet echo truncated/sanitized');
  return `He carries it quietly — ${s}.`;
}
