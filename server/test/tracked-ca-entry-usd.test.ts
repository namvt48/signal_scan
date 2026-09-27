import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { findTrackedCa, insertTrackedCa, open, setTrackedCaEntryUsd } from '../src/db.js';

const CA = 'caEntry-usd-001';

before(() => {
  open(':memory:');
});

test('setTrackedCaEntryUsd: fills NULL once, never overwrites a known entry, unknown CA -> undefined', () => {
  // Given: a CA inserted before any price was known.
  insertTrackedCa({ address: CA, chain: 'sol', note: '' });
  assert.equal(findTrackedCa(CA, 'sol')?.entry_usd, null);

  // When: a price arrives later — the NULL entry is backfilled.
  assert.equal(setTrackedCaEntryUsd(CA, 'sol', 60)?.entry_usd, 60);

  // Then: a known entry is a historical fact — a second write must not overwrite it.
  assert.equal(setTrackedCaEntryUsd(CA, 'sol', 999)?.entry_usd, 60);

  // And: an unknown CA has no row to update.
  assert.equal(setTrackedCaEntryUsd('caEntry-missing', 'sol', 60), undefined);
});
