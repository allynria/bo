// scripts/state/character_spine.mjs
import { AsyncFS } from '../../monolith.js';
import path from 'path';

const BASE = path.join(process.cwd(), 'tmp', 'urga_spine');
await AsyncFS.mkdir(BASE, { recursive: true }).catch(() => {});

const FNAME = (convId, char='bot') =>
  path.join(BASE, `${String(convId).replace(/[^a-z0-9_.-]/gi,'_')}__${char}.json`);

export async function loadSpine(convId, char='bot') {
  try { return JSON.parse(await AsyncFS.readFile(FNAME(convId,char), 'utf8')); }
  catch { return {
    convId, char,
    mood: process.env.SPINE_DEFAULT_MOOD || 'neutral',
    trust: 0.5, suspicion: 0.1,
    tone: 'balanced',
    impulses: [],    // e.g. ["protect","argue","comfort"]
    lastUpdate: Date.now()
  }; }
}

export async function saveSpine(convId, char, s) {
  s.lastUpdate = Date.now();
  await AsyncFS.writeFileAtomic(FNAME(convId,char), JSON.stringify(s,null,2), 'utf8');
  return s;
}

export function decayImpulses(spine) {
  const ttl = Math.max(60_000, Number(process.env.SPINE_IMPULSE_DECAY_MS||'900000'));
  const now = Date.now();
  spine.impulses = (spine.impulses||[]).filter(it => (now - (it.ts||now)) < ttl);
  return spine;
}

export function reinforce(spine, {trustDelta=0, suspicionDelta=0, addImpulse}) {
  spine.trust = Math.min(1, Math.max(0, (spine.trust ?? 0.5) + trustDelta));
  spine.suspicion = Math.min(1, Math.max(0, (spine.suspicion ?? 0.1) + suspicionDelta));
  if (addImpulse) {
    spine.impulses = spine.impulses || [];
    spine.impulses.push({ name:addImpulse, ts: Date.now() });
  }
  return decayImpulses(spine);
}
