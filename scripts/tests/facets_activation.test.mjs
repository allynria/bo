import assert from 'node:assert/strict';
import { upsertFacet, loadFacets, pickFacets, facetToNarrative } from '../memory/facets.mjs';

const convId = 'facets-test';

await upsertFacet({ convId, charId:'bot', key:'fear', val:'open water', delta:0.6, turn:10, pin:false });
await upsertFacet({ convId, charId:'bot', key:'goal', val:'find the lost ring', delta:0.5, turn:12, pin:true });

const store = await loadFacets(convId);
assert.ok(store.characters.bot?.length >= 2);

const chosen = pickFacets({ list: store.characters.bot, nowTurn: 20, k: 2, temperature: 0.5, alpha: 0.7, halfLife: 64 });
assert.ok(chosen.length >= 1, 'no facets chosen');

const line = facetToNarrative(chosen[0], 'she');
assert.ok(/she/.test(line), 'narrative did not personalize');

