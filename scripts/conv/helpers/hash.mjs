import crypto from 'node:crypto';

export function hashBytes(bytes) {
  const h = crypto.createHash('sha256');
  h.update(bytes);
  return h.digest('hex');
}

export function hashString(s) {
  return hashBytes(Buffer.from(String(s), 'utf8'));
}

export function randomId(prefix = '') {
  try {
    return prefix + crypto.randomUUID();
  } catch {
    return prefix + crypto.randomBytes(16).toString('hex');
  }
}
