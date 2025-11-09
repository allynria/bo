// Simple cadence meter: measures average words per sentence
// Returns: { avg, min, max, n, bySentence }

export function measureCadence(text) {
  const s = String(text || '').trim();
  if (!s) return { avg: 0, min: 0, max: 0, n: 0, bySentence: [] };

  // Split by sentence boundaries (.?!), also break on newlines
  const parts = s.split(/(?<=[.!?])\s+|\n+/u)
    .map(t => t.trim())
    .filter(Boolean);

  const counts = parts.map(sent => {
    // Normalize punctuation to spaces, keep letters/numbers/apostrophes/hyphens
    const words = sent.replace(/[^\p{L}\p{N}'-]+/gu, ' ')
      .trim()
      .split(/\s+/u)
      .filter(Boolean);
    return words.length;
  });

  const n = counts.length;
  const sum = counts.reduce((a, b) => a + b, 0);
  const avg = n ? sum / n : 0;
  const min = n ? Math.min(...counts) : 0;
  const max = n ? Math.max(...counts) : 0;
  return { avg, min, max, n, bySentence: counts };
}

