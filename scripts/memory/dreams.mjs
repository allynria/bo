// Tiny helper to optionally prepend a short “dream fragment” to input text.
// Metered by MEMORY_DREAMS_EVERY (default 7). You can later swap this
// implementation for an LLM micro-call if you want stylized prose.

const EVERY = Math.max(1, Number(process.env.MEMORY_DREAMS_EVERY || 7));
const MAX_LEN = Math.max(1, Number(process.env.MEMORY_DREAMS_MAX_CHARS || 140));

// Very small pool to keep things short and tone-light. Intentionally generic.
const DREAMS = [
  '(She glimpses a warm hallway of memory.)',
  '(He recalls a quiet promise under dim light.)',
  '(She senses the scene shifting like a page turn.)',
  '(He feels the room remember their footsteps.)',
  '(She hears a distant line, almost familiar.)',
  '(He notices a gentle echo of last time.)',
];

import { rng, SafeText } from '../../monolith.js';

function pick(arr) {
  return arr[(rng() * arr.length) | 0];
}

export function maybeDream({ text = '', allow = true } = {}) {
  if (!allow) return null;

  // Metering: inject roughly once every N turns on average.
  {
    if (EVERY > 1 && rng() >= 1 / EVERY) return null;
  }

  // Keep fragment very short; caller guards not to double-inject if it already starts
  // with a dream parenthetical.
  // Optionally, we could try a super-light tone match based on punctuation density.
  try {
    const trimmed = String(text || '').trim();
    // Simple tone hint: if text is exclamatory/energetic, pick slightly brighter ones.
    const energetic = /!/.test(trimmed) || /\b(really|so|very)\b/i.test(trimmed);
    if (energetic) {
      const d = pick([
        '(She feels a bright flicker of a thought.)',
        '(He catches a lively note in the air.)',
      ]);
      const clean = SafeText.stripDangerous(String(d || ''));
      return SafeText.clamp(clean, MAX_LEN);
    }
  } catch {}

  const d = pick(DREAMS);
  const clean = SafeText.stripDangerous(String(d || ''));
  return SafeText.clamp(clean, MAX_LEN);
}

export default { maybeDream };
