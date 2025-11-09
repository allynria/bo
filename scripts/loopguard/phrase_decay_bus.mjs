// Lightweight bus wrapper exposing phrase-decay cooling helpers
// Delegates to the style/phrase_decay module so consumers have a stable import path.
import PhraseDecay from '../style/phrase_decay.mjs';

export function coolPhrases(convId, phrases, ttlMs) {
  try {
    return PhraseDecay.coolPhrases(convId, phrases, ttlMs);
  } catch {
    // no-op
    return undefined;
  }
}

export function isCooled(convId, text) {
  try {
    return PhraseDecay.isCooled(convId, text);
  } catch {
    return false;
  }
}

export default { coolPhrases, isCooled };

