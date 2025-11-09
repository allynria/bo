// Stateless JSON helpers

/**
 * Safely parse a JSON string or Buffer into an object.
 * Returns { ok: boolean, value: any } and never throws.
 */
export function safeJsonParse(input, fallback = null) {
  try {
    const s = Buffer.isBuffer(input)
      ? input.toString('utf8')
      : typeof input === 'string'
      ? input
      : JSON.stringify(input ?? '');
    if (!s) return { ok: true, value: fallback };
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false, value: fallback };
  }
}

