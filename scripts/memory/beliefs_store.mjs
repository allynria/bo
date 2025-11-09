import crypto from 'node:crypto';

const MEM = new Map(); // key: characterId -> { beliefs: [{id,text,weight,addedAt,updatedAt}], lru: [] }

const cfg = () => ({
  maxPerChar: Number(process.env.BELIEFS_MAX_PER_CHAR || 64),
});

export function _key(charId='default') { return String(charId || 'default').toLowerCase(); }

function touchLRU(bucket, id) {
  const i = bucket.lru.indexOf(id);
  if (i >= 0) bucket.lru.splice(i,1);
  bucket.lru.push(id);
  // trim
  const over = bucket.lru.length - cfg().maxPerChar;
  for (let j=0;j<over;j++) {
    const dropId = bucket.lru.shift();
    const ix = bucket.beliefs.findIndex(b => b.id === dropId);
    if (ix >= 0) bucket.beliefs.splice(ix,1);
  }
}

function ensureBucket(key) {
  if (!MEM.has(key)) MEM.set(key, { beliefs: [], lru: [] });
  return MEM.get(key);
}

function hashText(t) { return crypto.createHash('sha1').update(t.trim().toLowerCase()).digest('hex'); }

export function listBeliefs(charId) {
  const b = ensureBucket(_key(charId));
  return b.beliefs.slice();
}

export function addBelief(charId, text, weight=1) {
  const key = _key(charId);
  const bucket = ensureBucket(key);
  const norm = text.trim();
  if (!norm) return null;
  const h = hashText(norm);
  let item = bucket.beliefs.find(b => b.hash === h);
  const now = Date.now();
  if (item) {
    item.weight = Math.max(item.weight, weight);
    item.updatedAt = now;
    touchLRU(bucket, item.id);
    return item;
  }
  item = { id: `${key}:${h}`, hash: h, text: norm, weight, addedAt: now, updatedAt: now };
  bucket.beliefs.push(item);
  touchLRU(bucket, item.id);
  return item;
}

export function deleteBelief(charId, idOrText) {
  const bucket = ensureBucket(_key(charId));
  const h = idOrText.includes(':') ? null : hashText(String(idOrText));
  const idx = bucket.beliefs.findIndex(b => b.id === idOrText || (h && b.hash === h));
  if (idx >= 0) {
    const [removed] = bucket.beliefs.splice(idx,1);
    const i = bucket.lru.indexOf(removed.id);
    if (i>=0) bucket.lru.splice(i,1);
    return true;
  }
  return false;
}

export function reinforceBelief(charId, textOrId, inc=1) {
  const bucket = ensureBucket(_key(charId));
  const h = textOrId.includes(':') ? null : hashText(String(textOrId));
  const item = bucket.beliefs.find(b => b.id === textOrId || (h && b.hash === h));
  if (item) {
    item.weight += inc;
    item.updatedAt = Date.now();
    touchLRU(bucket, item.id);
  }
  return item || null;
}

export function topBeliefs(charId, n=3) {
  const bucket = ensureBucket(_key(charId));
  return bucket.beliefs
    .slice()
    .sort((a,b) => (b.weight - a.weight) || (b.updatedAt - a.updatedAt))
    .slice(0, n);
}

