import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, insertTrackedCa, open } from '../src/db.js';
import { updateTokenMetrics } from '../src/ingest.js';
import { assembleSignals } from '../src/signals.js';

// Write path for the token's X handle (GMGN token/info data.link.twitter_username):
// patch → x_handle column → TokenSignal DTO. Offline, mirrors the icon write-path tests.

before(() => {
  open(':memory:');
  insertTrackedCa({ address: 'caNoHandle', chain: 'sol', note: '', entryUsd: 100 });
  insertTrackedCa({ address: 'caHandle', chain: 'sol', note: '', entryUsd: 100 });
  updateTokenMetrics('caHandle', 'sol', { xHandle: 'bonk_inu' });
});

test('xHandle patch lands in x_handle and surfaces in the DTO', () => {
  const row = getDb().prepare('SELECT x_handle FROM token_state WHERE ca = ? AND chain = ?').get('caHandle', 'sol') as {
    x_handle: string | null;
  };
  assert.equal(row.x_handle, 'bonk_inu');
  const sig = assembleSignals().find((s) => s.ca === 'caHandle');
  assert.equal(sig?.xHandle, 'bonk_inu');
});

test('a NULL x_handle omits the DTO key (FE falls back to a CA search)', () => {
  updateTokenMetrics('caNoHandle', 'sol', { xHandle: undefined, price: 1 });
  const sig = assembleSignals().find((s) => s.ca === 'caNoHandle');
  assert.ok(sig, 'the handle-less CA must still be listed');
  assert.equal('xHandle' in (sig as object), false, 'NULL x_handle must omit the key, not emit null');
});

test('xHandle write does not clobber sibling columns (per-endpoint write isolation)', () => {
  updateTokenMetrics('caHandle', 'sol', { price: 2.5, symbol: 'HNDL' });
  updateTokenMetrics('caHandle', 'sol', { xHandle: 'refreshed_handle' });
  const row = getDb().prepare('SELECT x_handle, price, symbol FROM token_state WHERE ca = ? AND chain = ?').get('caHandle', 'sol') as {
    x_handle: string | null;
    price: number | null;
    symbol: string | null;
  };
  assert.equal(row.x_handle, 'refreshed_handle');
  assert.equal(row.price, 2.5);
  assert.equal(row.symbol, 'HNDL');
});
