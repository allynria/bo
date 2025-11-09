// Stateless network-related helpers extracted for reuse across service
import { URL } from 'node:url';

/**
 * Parse Authorization header and return token string.
 * Supports formats: "Bearer <token>" and raw token without scheme.
 */
export function getBearerOrRawToken(authorization) {
  try {
    const h = String(authorization || '').trim();
    if (!h) return '';
    const m = /^Bearer\s+(\S+)$/i.exec(h);
    if (m) return m[1];
    return h;
  } catch {
    return '';
  }
}

/**
 * Extract token from query string by checking common parameter names.
 * `paramNames` allows overriding names; defaults cover typical tokens.
 */
export function getTokenFromQuery(urlLike, paramNames = ['token', 'access_token', 'auth']) {
  try {
    const u = urlLike instanceof URL ? urlLike : new URL(String(urlLike || ''), 'http://x');
    for (const name of paramNames) {
      const v = u.searchParams.get(name);
      if (v) return String(v);
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * Check whether the remote IP of a request is allowed based on a CSV allowlist
 * provided via environment variable `listEnvName`. Supports CIDR-free exact matches.
 * Empty/missing env means allow all.
 */
export function isIpAllowed(req, listEnvName) {
  try {
    const raw = String(process.env[String(listEnvName || '')] || '').trim();
    if (!raw) return true; // no allowlist configured => allow all
    const items = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const forwarded = String(req?.headers?.['x-forwarded-for'] || '')
      .split(',')[0]
      .trim();
    let ip = String(
      forwarded || (req?.socket?.remoteAddress ?? req?.connection?.remoteAddress ?? '') || ''
    )
      .replace(/^::ffff:/, '')
      .trim();
    if (!ip) return false;
    for (const item of items) {
      if (item === '*') return true;
      if (item.endsWith('.')) {
        if (ip.startsWith(item)) return true;
      } else if (ip === item) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Utility to combine possible token sources for a request.
 */
export function getToken(req) {
  try {
    const auth = req?.headers?.authorization ?? '';
    const fromHeader = getBearerOrRawToken(auth);
    const fromQuery = (() => {
      try {
        const u = new URL(String(req?.url || ''), 'http://x');
        return getTokenFromQuery(u);
      } catch {
        return '';
      }
    })();
    return String(fromHeader || fromQuery || '');
  } catch {
    return '';
  }
}
