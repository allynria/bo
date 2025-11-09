/**
 * Build tiny, in-character injections (no OOC).
 */
export function buildRecapLine(strRecap) {
  if (!strRecap) return '';
  return `(${strRecap})\n`;
}

export function pickEpisodicCue(ef) {
  // Pick one salient EF item for nudge
  const items = ef?.items || [];
  const last = items.slice(-6); // recent pool
  return last.reverse().find(x => x.t !== 'other') || last[0] || null;
}

export function renderEpisodicCue(item) {
  if (!item) return '';
  // Keep it tiny and evocative
  if (item.t === 'injury' && /scar/i.test(item.txt)) return 'She feels the old scar beneath her sleeve.';
  if (item.t === 'confession') return 'His mind replays her whisper: “I never stopped loving you.”';
  if (item.t === 'promise') return 'The promise on the bridge still stings.';
  if (item.t === 'secret') return 'They still share that secret under the stars.';
  if (item.t === 'location') return 'The air still smells like rain by the bridge.';
  return item.txt?.slice(0, 90);
}

export function renderFacetEcho(facet) {
  if (!facet) return '';
  const bits = [];
  if (facet.rel) bits.push(facet.rel);
  if (facet.fear) bits.push(`fear: ${facet.fear}`);
  if (facet.key) bits.push(facet.key);
  const s = bits.filter(Boolean).join(' · ');
  if (!s) return '';
  return `He carries it quietly — ${s}.`;
}

