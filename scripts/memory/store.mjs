/**
 * Lightweight memory stores with TTL + LRU, optional Redis read/write.
 * Keys are namespaced per-conversation.
 */
import crypto from 'crypto';
let redisClient = null;

const env = (k, d) => process.env[k] ?? d;
const now = () => Date.now();

const HAS_REDIS = !!(process.env.IDEMPOTENCY_REDIS_URL || process.env.REDIS_URL);

export async function initMemoryStore() {
  if (!HAS_REDIS) return;
  if (redisClient) return;
  const { createClient } = await import('redis');
  const url = process.env.IDEMPOTENCY_REDIS_URL || process.env.REDIS_URL;
  redisClient = createClient({ url });
  redisClient.on('error', () => {});
  await redisClient.connect().catch(() => {
    redisClient = null;
  });
}

function makeLRU(capacity = 64) {
  // Map used as ordered list; we "touch" by delete+set
  const m = new Map();
  return {
    get(k) {
      const v = m.get(k);
      if (v) {
        m.delete(k);
        m.set(k, v);
      }
      return v;
    },
    set(k, v) {
      if (m.has(k)) m.delete(k);
      m.set(k, v);
      if (m.size > capacity) {
        const fk = m.keys().next().value;
        m.delete(fk);
      }
    },
    delete(k) {
      m.delete(k);
    },
    values() {
      return Array.from(m.values());
    },
    size() {
      return m.size;
    },
  };
}

const STR_TTL = Number(env('MEMORY_STR_TTL_MS', 30 * 60 * 1000)); // 30m
const STR_MAX = Number(env('MEMORY_STR_MAX_ITEMS', 4));
const EF_TTL = Number(env('MEMORY_EF_TTL_MS', 7 * 24 * 60 * 60 * 1000)); // 7d
const EF_MAX = Number(env('MEMORY_EF_MAX_ITEMS', 64));
const CF_TTL = Number(env('MEMORY_CF_TTL_MS', 30 * 24 * 60 * 60 * 1000)); // 30d
const CF_MAXC = Number(env('MEMORY_CF_MAX_CHARS', 8));

const strLRU = makeLRU(256);
const efLRU = makeLRU(256);
const cfLRU = makeLRU(256);

const NS = {
  str: (cid) => `mem:str:${cid}`,
  ef: (cid) => `mem:ef:${cid}`,
  cf: (cid) => `mem:cf:${cid}`,
};

function isFresh(ts, ttl) {
  return now() - (ts || 0) <= ttl;
}
function pruneListByTTL(items, ttl) {
  const t = now();
  return items.filter((x) => t - (x.ts || 0) <= ttl);
}

async function rget(key) {
  if (!redisClient) return null;
  try {
    const s = await redisClient.get(key);
    if (!s) return null;
    return JSON.parse(s);
  } catch {
    return null;
  }
}
async function rset(key, obj, ttlMs) {
  if (!redisClient) return;
  try {
    const str = JSON.stringify(obj);
    if (ttlMs > 0) await redisClient.set(key, str, { PX: ttlMs });
    else await redisClient.set(key, str);
  } catch {}
}

export async function getSTR(convId) {
  const k = NS.str(convId);
  let v = strLRU.get(k) || (await rget(k));
  if (!v || !isFresh(v.ts, STR_TTL)) return null;
  return v;
}
export async function setSTR(convId, recap, turnRange) {
  const k = NS.str(convId);
  const obj = { ts: now(), recap, turn_range: turnRange };
  strLRU.set(k, obj);
  await rset(k, obj, STR_TTL);
  return obj;
}

export async function getEF(convId) {
  const k = NS.ef(convId);
  let v = efLRU.get(k) || (await rget(k));
  if (!v) return { items: [] };
  v.items = pruneListByTTL(v.items || [], EF_TTL).slice(-EF_MAX);
  return v;
}
export async function pushEF(convId, item) {
  const k = NS.ef(convId);
  let v = efLRU.get(k) || (await rget(k)) || { items: [] };
  const pruned = pruneListByTTL(v.items || [], EF_TTL);
  pruned.push({ ...item, ts: now() });
  const obj = { items: pruned.slice(-EF_MAX) };
  efLRU.set(k, obj);
  await rset(k, obj, EF_TTL);
  return obj;
}

export async function getCF(convId) {
  const k = NS.cf(convId);
  let v = cfLRU.get(k) || (await rget(k));
  if (!v) return { chars: {} };
  // no per-field TTL decay now; rely on top-level TTL
  return v;
}
export async function upsertCF(convId, name, patch) {
  const k = NS.cf(convId);
  let v = cfLRU.get(k) || (await rget(k)) || { chars: {} };
  const next = {
    ...v,
    chars: {
      ...v.chars,
      [name]: { ...(v.chars?.[name] || {}), ...patch, last_update: now() },
    },
  };
  // bound number of chars
  const names = Object.keys(next.chars);
  if (names.length > CF_MAXC) {
    // drop oldest by last_update
    const sorted = names.sort(
      (a, b) => (next.chars[a].last_update || 0) - (next.chars[b].last_update || 0)
    );
    const drop = sorted.slice(0, names.length - CF_MAXC);
    for (const d of drop) delete next.chars[d];
  }
  cfLRU.set(k, next);
  await rset(k, next, CF_TTL);
  return next;
}

export function cheapHash(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 8);
}
