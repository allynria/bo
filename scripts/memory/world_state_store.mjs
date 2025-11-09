import path from 'path';
import { stateIO, safeFsp, createSharedRateLimiter } from '../../monolith.js';

const S = new Map(); // convId -> Map(key -> { value, tag, updatedAt })
const BASE = path.join(process.cwd(), 'tmp', 'urga_world_state');
async function ensureBase() { try { await safeFsp.mkdir(BASE, { recursive: true }); } catch {} }
function fileFor(convId) {
  const clean = String(convId || 'conv').replace(/[^a-z0-9_\-.]/gi, '_').toLowerCase();
  return path.join(BASE, `${clean}.json`);
}
const RL = createSharedRateLimiter({
  limit: Number(process.env.WORLD_STATE_WRITES_PER_SECOND || 10),
  windowMs: Number(process.env.WORLD_STATE_WRITE_WINDOW_MS || 1000)
});
const SCHEDULED = new Set();
const LOADED = new Set();
const LOADING = new Set();
async function loadFromDisk(c) {
  try {
    if (String(process.env.WORLD_STATE_PERSIST ?? '1') !== '1') return;
    await ensureBase();
    const file = fileFor(c);
    const obj = await stateIO.readJson(file, {});
    if (obj && typeof obj === 'object') {
      const bucket = new Map();
      for (const [key, rec] of Object.entries(obj)) {
        if (!key) continue;
        const value = String(rec?.value ?? '').trim();
        if (!value) continue;
        bucket.set(String(key).toLowerCase(), { value, tag: rec?.tag || 'fact', updatedAt: Number(rec?.updatedAt) || Date.now() });
      }
      if (!S.has(c)) S.set(c, bucket);
    }
  } catch {}
  finally { LOADED.add(c); LOADING.delete(c); }
}
function scheduleLoad(c) {
  try {
    if (LOADED.has(c) || LOADING.has(c)) return;
    LOADING.add(c);
    queueMicrotask(() => { loadFromDisk(c).catch(() => { LOADING.delete(c); }); });
  } catch {}
}
async function persistNowIfAllowed(convId) {
  try {
    if (String(process.env.WORLD_STATE_PERSIST ?? '1') !== '1') return;
    await ensureBase();
    const allow = await RL.allow(`world:${String(convId || 'conv')}`);
    if (!allow?.ok) return; // skip write if rate-limited
    const bucket = S.get(String(convId).trim().toLowerCase());
    const obj = {};
    if (bucket) {
      for (const [key, rec] of bucket.entries()) {
        obj[key] = { value: rec.value, tag: rec.tag, updatedAt: rec.updatedAt };
      }
    }
    const file = fileFor(convId);
    await stateIO.writeJsonAtomic(file, obj);
  } catch {}
}
function schedulePersist(convId) {
  try {
    if (String(process.env.WORLD_STATE_PERSIST ?? '1') !== '1') return;
    const c = String(convId || 'conv').trim().toLowerCase();
    if (SCHEDULED.has(c)) return;
    SCHEDULED.add(c);
    queueMicrotask(async () => {
      try { await persistNowIfAllowed(c); }
      catch {}
      finally { SCHEDULED.delete(c); }
    });
  } catch {}
}

function k(s){ return String(s||'').trim().toLowerCase() }

export function setState(convId, key, value, tag='fact') {
  const c = k(convId); if(!c) return false;
  if(!S.has(c)) S.set(c, new Map());
  S.get(c).set(k(key), { value: k(value), tag, updatedAt: Date.now() });
  schedulePersist(c);
  return true;
}

export function getState(convId, key) {
  const cid = k(convId);
  if (!S.has(cid)) scheduleLoad(cid);
  const c = S.get(cid); if(!c) return null;
  return c.get(k(key)) || null;
}

export function listState(convId) {
  const cid = k(convId);
  if (!S.has(cid)) scheduleLoad(cid);
  const c = S.get(cid); if(!c) return [];
  return [...c.entries()].map(([key,obj]) => ({ key, ...obj }));
}

export function clearState(convId, key) {
  const c = S.get(k(convId)); if(!c) return false;
  const ok = c.delete(k(key));
  if (ok) schedulePersist(k(convId));
  return ok;
}

export function clearAll(convId){
  const ok = S.delete(k(convId));
  if (ok) schedulePersist(k(convId));
  return ok;
}

export function upsertWorldState(convId, deltaArray){
  const c = k(convId); if(!c) return 0;
  let updated = 0;
  if (Array.isArray(deltaArray)) {
    for (const d of deltaArray) {
      if (!d) continue;
      const key = k(d.key || d.name || '');
      const value = k(d.value || '');
      const tag = d.tag || 'fact';
      if (!key || !value) continue;
      setState(c, key, value, tag);
      updated++;
    }
    schedulePersist(c);
    return updated;
  }
  // Support object maps like { door: 'locked' }
  if (deltaArray && typeof deltaArray === 'object') {
    for (const [rawKey, rawVal] of Object.entries(deltaArray)) {
      const key = k(rawKey); const value = k(rawVal);
      if (!key || !value) continue;
      setState(c, key, value);
      updated++;
    }
  }
  if (updated > 0) schedulePersist(c);
  return updated;
}
