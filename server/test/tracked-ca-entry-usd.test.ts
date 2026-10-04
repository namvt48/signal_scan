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

test('setTrackedCaEntryUsd: upgrades a sub-threshold entry when larger trade arrives with minUsd gate', () => {
  const CA2 = 'caEntry-subthresh-002';
  insertTrackedCa({ address: CA2, chain: 'sol', note: '' });

  // Step 1: initial dust buy ($0.71) backfills NULL.
  assert.equal(setTrackedCaEntryUsd(CA2, 'sol', 0.71, 50)?.entry_usd, 0.71);

  // Step 2: smaller dust buy ($0.10) does NOT downgrade.
  assert.equal(setTrackedCaEntryUsd(CA2, 'sol', 0.10, 50)?.entry_usd, 0.71);

  // Step 3: real qualifying buy ($224.79) upgrades sub-threshold entry.
  assert.equal(setTrackedCaEntryUsd(CA2, 'sol', 224.79, 50)?.entry_usd, 224.79);

  // Step 4: once qualifying (>= minUsd 50), further buys (even larger $999) do NOT overwrite.
  assert.equal(setTrackedCaEntryUsd(CA2, 'sol', 999, 50)?.entry_usd, 224.79);
});
