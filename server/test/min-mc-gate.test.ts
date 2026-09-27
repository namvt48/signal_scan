import { before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { insertTrackedCa, open, setSetting } from '../src/db.js';
import { updateTokenMetrics } from '../src/ingest.js';
import { getThresholds, setDebugAllFactors, thresholdDefaults, updateThresholds } from '../src/settings.js';
import { assembleSignals } from '../src/signals.js';

const CA_LOW = 'caMc-low-001';
const CA_OK = 'caMc-ok-002';
const CA_EDGE = 'caMc-edge-003';
const CA_NONE = 'caMc-nostate-004';
const CA_TINY = 'caMc-tiny-005';
const FLOOR = 5_000_000;

function signalCas(): string[] {
  return assembleSignals().map((s) => s.ca);
}

before(() => {
  open(':memory:');
  // entry_usd=60 on every row clears the parallel minUsd gate, so only minMc can drop them.
  insertTrackedCa({ address: CA_LOW, chain: 'sol', note: '', entryUsd: 60 });
  insertTrackedCa({ address: CA_OK, chain: 'sol', note: '', entryUsd: 60 });
  insertTrackedCa({ address: CA_EDGE, chain: 'sol', note: '', entryUsd: 60 });
  insertTrackedCa({ address: CA_NONE, chain: 'sol', note: '', entryUsd: 60 });
  insertTrackedCa({ address: CA_TINY, chain: 'sol', note: '', entryUsd: 60 });

  updateTokenMetrics(CA_LOW, 'sol', { marketCap: 1_000_000 });
  updateTokenMetrics(CA_OK, 'sol', { marketCap: 10_000_000 });
  updateTokenMetrics(CA_EDGE, 'sol', { marketCap: FLOOR });
  updateTokenMetrics(CA_TINY, 'sol', { marketCap: 5_000 });
  // CA_NONE keeps no token_state row at all -> market_cap unknown.
});

beforeEach(() => {
  updateThresholds(thresholdDefaults());
});

test('minMc defaults to 0: the gate is off, so the MC column hides nothing', () => {
  assert.equal(getThresholds().minMc, 0);
  const cas = signalCas();
  assert.ok(cas.includes(CA_LOW), 'mc 1M must still surface while the gate is off');
  assert.ok(cas.includes(CA_OK));
  assert.ok(cas.includes(CA_EDGE));
  assert.ok(cas.includes(CA_NONE));
});

test('minMc gate: below the floor is dropped, at/above passes, unknown market_cap fails open', () => {
  const result = updateThresholds({ minMc: FLOOR });
  assert.ok(!('error' in result), 'minMc=5M must validate');
  const cas = signalCas();
  assert.ok(!cas.includes(CA_LOW), 'mc 1M below the 5M floor must be excluded');
  assert.ok(cas.includes(CA_EDGE), 'mc exactly at the floor (gate is <) must be included');
  assert.ok(cas.includes(CA_OK), 'mc 10M above the floor must be included');
  assert.ok(cas.includes(CA_NONE), 'no measured market_cap (no token_state) must be INCLUDED (fail-open)');
});

test('maxMc gate: above the ceiling is dropped, at the ceiling passes, unknown market_cap fails open', () => {
  const result = updateThresholds({ maxMc: FLOOR });
  assert.ok(!('error' in result), 'maxMc=5M must validate');
  const cas = signalCas();
  assert.ok(cas.includes(CA_LOW), 'mc 1M under the 5M ceiling must be included');
  assert.ok(cas.includes(CA_EDGE), 'mc exactly at the ceiling (gate is >) must be included');
  assert.ok(!cas.includes(CA_OK), 'mc 10M above the 5M ceiling must be excluded');
  assert.ok(cas.includes(CA_NONE), 'no measured market_cap (no token_state) must be INCLUDED (fail-open)');
});

test('MC band: floor and ceiling apply together, and an inverted band is rejected', () => {
  assert.deepEqual(updateThresholds({ minMc: 8_000_000, maxMc: FLOOR }), {
    error: `minMc (8000000) must be <= maxMc (${FLOOR})`,
  });
  const result = updateThresholds({ minMc: FLOOR, maxMc: 20_000_000 });
  assert.ok(!('error' in result), 'minMc 5M <= maxMc 20M must validate');
  const cas = signalCas();
  assert.ok(cas.includes(CA_EDGE), 'mc at the band floor must be included');
  assert.ok(cas.includes(CA_OK), 'mc 10M inside the 5M-20M band must be included');
  assert.ok(!cas.includes(CA_LOW), 'mc 1M under the band must be excluded');
});

test('maxMc defaults to -1: the ceiling is off unless armed', () => {
  assert.equal(getThresholds().maxMc, -1);
});

test('marketCap reaches the DTO as USD, and stays absent when nothing measured it', () => {
  const ok = assembleSignals().find((s) => s.ca === CA_OK);
  assert.equal(ok?.marketCap, 10_000_000);
  const none = assembleSignals().find((s) => s.ca === CA_NONE);
  assert.equal(none?.marketCap, undefined, 'unknown mc must stay absent, never a fake 0');
});

test('settings validation: minMc accepts any finite >= 0 (USD is unbounded), rejects negative/NaN', () => {
  const big = updateThresholds({ minMc: 250_000_000 });
  assert.ok(!('error' in big) && big.minMc === 250_000_000, 'minMc=250M must be accepted');
  assert.deepEqual(updateThresholds({ minMc: -1 }), { error: 'minMc must be a finite number >= 0' });
  assert.deepEqual(updateThresholds({ minMc: NaN }), { error: 'minMc must be a finite number >= 0' });
});

test('maxMc sentinel: -1 (no cap) validates and round-trips; -2 is rejected', () => {
  const result = updateThresholds({ maxMc: -1 });
  assert.ok(!('error' in result), 'maxMc=-1 must validate');
  assert.equal(result.maxMc, -1);
  assert.equal(getThresholds().maxMc, -1, 'persisted -1 must read back as -1');
  assert.deepEqual(updateThresholds({ maxMc: -2 }), {
    error: 'maxMc must be a finite number >= -1 (-1 = no cap)',
  });
});

test('legacy persisted maxMc="0" normalizes to -1 on read', () => {
  setSetting('maxMc', '0');
  assert.equal(getThresholds().maxMc, -1, 'legacy 0 row must surface as the -1 sentinel');
});

test('maxMc=-1 keeps huge caps; an armed maxMc drops rows above it', () => {
  const off = updateThresholds({ maxMc: -1 });
  assert.ok(!('error' in off));
  let cas = signalCas();
  assert.ok(cas.includes(CA_OK), 'mc 10M must surface while the ceiling is off (-1)');
  assert.ok(cas.includes(CA_TINY), 'mc 5000 must surface while the ceiling is off (-1)');

  const armed = updateThresholds({ maxMc: 1000 });
  assert.ok(!('error' in armed));
  cas = signalCas();
  assert.ok(!cas.includes(CA_TINY), 'mc 5000 above the 1000 ceiling must be dropped');
  assert.ok(cas.includes(CA_NONE), 'unknown market_cap still fails open');
});

test('MC band: armed but inverted minMc=15000 + maxMc=1000 is rejected', () => {
  const result = updateThresholds({ minMc: 15_000, maxMc: 1000 });
  assert.ok('error' in result, 'inverted band must error');
  assert.match(result.error, /minMc \(15000\) must be <= maxMc \(1000\)/);
});

test('allFactors debug lists EVERY tracked CA: the minUsd + MC display gates are skipped', () => {
  const CA_CHEAP = 'caCheap-below-minusd-006';
  insertTrackedCa({ address: CA_CHEAP, chain: 'sol', note: '', entryUsd: 10 }); // below minUsd 50
  updateTokenMetrics(CA_CHEAP, 'sol', { marketCap: 1_000_000 });
  updateThresholds({ maxMc: FLOOR }); // armed ceiling: CA_OK (10M) is above it

  assert.ok(!signalCas().includes(CA_OK), 'debug off: above the ceiling is hidden');
  assert.ok(!signalCas().includes(CA_CHEAP), 'debug off: below minUsd is hidden');

  setDebugAllFactors(true);
  const cas = signalCas();
  assert.ok(cas.includes(CA_OK), 'debug on: a row above maxMc must still be listed');
  assert.ok(cas.includes(CA_CHEAP), 'debug on: a row below minUsd must still be listed');
  setDebugAllFactors(false);
});
