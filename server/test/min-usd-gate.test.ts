import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { insertTrackedCa, listTrackedCas, open } from '../src/db.js';
import { getThresholds, updateThresholds } from '../src/settings.js';
import { assembleSignals } from '../src/signals.js';
import { createApp } from '../src/api.js';

const CA_LOW = 'caUsd-low-001';
const CA_OK = 'caUsd-ok-002';
const CA_NULL = 'caUsd-null-003';
const CA_EDGE = 'caUsd-edge-004';
// AUTH CONTRACT v1: POST /api/tracked-cas accepts the service role (the daemon's
// path). Static imports snapshot config before this module body runs, so the
// token goes in via createApp deps instead of env.
const SERVICE_TOKEN = 'min-usd-gate-service-token';
const AUTH_HEADER = { authorization: `Bearer ${SERVICE_TOKEN}` };

function signalCas(): string[] {
  return assembleSignals().map((s) => s.ca);
}

let server: Server;
let base = '';

before(async () => {
  open(':memory:');
  // Given: four tracked CAs — below, above, unknown (NULL), and exactly at the default gate.
  insertTrackedCa({ address: CA_LOW, chain: 'sol', note: '', entryUsd: 10 });
  insertTrackedCa({ address: CA_OK, chain: 'sol', note: '', entryUsd: 60 });
  insertTrackedCa({ address: CA_NULL, chain: 'sol', note: '' });
  insertTrackedCa({ address: CA_EDGE, chain: 'sol', note: '', entryUsd: 50 });
  server = createApp('test', { serviceToken: SERVICE_TOKEN }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

test('minUsd gate: entry_usd=60 included, entry_usd=10 excluded, NULL included (fail-open), edge 50 included', () => {
  // When: assembling signals with the default minUsd = 50.
  assert.equal(getThresholds().minUsd, 50);
  const cas = signalCas();
  // Then: rows with a KNOWN entry_usd >= minUsd surface; NULL (unknown) fails open.
  assert.ok(cas.includes(CA_OK), 'entry_usd=60 must be included');
  assert.ok(cas.includes(CA_EDGE), 'entry_usd=50 (boundary, gate is <) must be included');
  assert.ok(!cas.includes(CA_LOW), 'entry_usd=10 must be excluded');
  // NULL entry_usd = unknown (pre-migration row / no price at track time) — fail-open: included at minUsd=50.
  assert.ok(cas.includes(CA_NULL), 'entry_usd=NULL must be INCLUDED (fail-open) at minUsd=50');
});

test('minUsd gate is runtime-adjustable: lowering it to 5 admits the entry_usd=10 row', () => {
  // Given: the settings override persists (same mechanism PUT /api/settings uses).
  const result = updateThresholds({ minUsd: 5 });
  assert.ok(!('error' in result), 'minUsd=5 must validate');
  // When: signals are re-assembled (getThresholds is read per call).
  const cas = signalCas();
  // Then: the previously excluded row now passes; NULL still fails open (included at any threshold).
  assert.ok(cas.includes(CA_LOW), 'entry_usd=10 must be included at minUsd=5');
  assert.ok(cas.includes(CA_NULL), 'NULL rows are included at any threshold (fail-open)');
  updateThresholds({ minUsd: 50 });
});

test('settings validation: minUsd accepts any finite >= 0 (USD exceeds 100), rejects negative/NaN', () => {
  const big = updateThresholds({ minUsd: 250 });
  assert.ok(!('error' in big) && big.minUsd === 250, 'minUsd=250 must be accepted');
  assert.deepEqual(updateThresholds({ minUsd: -1 }), { error: 'minUsd must be a finite number >= 0' });
  assert.deepEqual(updateThresholds({ minUsd: NaN }), { error: 'minUsd must be a finite number >= 0' });
  updateThresholds({ minUsd: 50 });
});

test('settings validation: freshMinPct keeps the 0..100 bound and error text', () => {
  assert.deepEqual(updateThresholds({ freshMinPct: 150 }), {
    error: 'freshMinPct must be a finite number between 0 and 100',
  });
  const ok = updateThresholds({ freshMinPct: 10 });
  assert.ok(!('error' in ok) && ok.freshMinPct === 10, 'freshMinPct=10 must be accepted');
});

test('settings validation: t100MinMultiple >= 1, lf band absolute (>= 0, unbounded), inverted band rejected', () => {
  assert.deepEqual(updateThresholds({ t100MinMultiple: 0.9 }), {
    error: 't100MinMultiple must be a finite number >= 1',
  });
  const ok = updateThresholds({ t100MinMultiple: 1.5 });
  assert.ok(!('error' in ok) && ok.t100MinMultiple === 1.5);
  const big = updateThresholds({ lfMin: 1e6, lfMax: 2e6 });
  assert.ok(!('error' in big), 'absolute band edges have no upper bound');
  // Inverted RESULTING pair (3e6 > persisted lfMax 2e6) — rejected, nothing persisted.
  assert.deepEqual(updateThresholds({ lfMin: 3e6 }), { error: 'lfMin (3000000) must be <= lfMax (2000000)' });
  assert.equal(getThresholds().lfMin, 1e6, 'a rejected band patch must not persist');
  // Shrinking lfMax below lfMin is the same rejection from the other key.
  assert.deepEqual(updateThresholds({ lfMax: 100 }), { error: 'lfMin (1000000) must be <= lfMax (100)' });
  updateThresholds({ t100MinMultiple: 1.2, lfMin: 1e6, lfMax: 3e8 });
});

// POST /api/tracked-cas entry-size gate — the daemon posts every detected buy;
// the API refuses to queue a KNOWN entryUsd below minUsd (200 so the daemon's
// 2xx-is-ok client stays quiet). Harness pattern from wallet-watch-trade.test.ts.

async function postTrackedCa(body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/api/tracked-cas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...AUTH_HEADER },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

function trackedAddresses(): string[] {
  return listTrackedCas().map((r) => r.address);
}

test('POST /api/tracked-cas: known usd below minUsd is skipped (200 { skipped }, not queued)', async () => {
  // Given: the default gate is in effect (minUsd=50, reset by the tests above).
  assert.equal(getThresholds().minUsd, 50);
  // When: the daemon posts a real buy it detected below the gate ($4.88-style).
  const res = await postTrackedCa({ address: 'caGate-low-101', chain: 'sol', note: '', usd: 10 });
  // Then: 200 (not 4xx — the daemon treats 2xx as ok), body marks the skip, row not queued.
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { skipped: 'below-min-usd' });
  assert.ok(!trackedAddresses().includes('caGate-low-101'), 'a skipped CA must not be queued');
});

test('POST /api/tracked-cas: usd at/above minUsd is queued (201)', async () => {
  // Given/When: the boundary value (gate is <) and one above it.
  const at = await postTrackedCa({ address: 'caGate-edge-102', chain: 'sol', note: '', usd: 50 });
  const above = await postTrackedCa({ address: 'caGate-ok-103', chain: 'sol', note: '', usd: 60 });
  // Then: both insert exactly as before the gate existed.
  assert.equal(at.status, 201);
  assert.equal(above.status, 201);
  const cas = trackedAddresses();
  assert.ok(cas.includes('caGate-edge-102'), 'usd=50 (boundary) must be queued');
  assert.ok(cas.includes('caGate-ok-103'), 'usd=60 must be queued');
});

test('POST /api/tracked-cas: absent usd fails open (201) — unknown price still queues', async () => {
  // When: the daemon could not price the buy.
  const res = await postTrackedCa({ address: 'caGate-null-104', chain: 'sol', note: '' });
  // Then: fail-open — inserted exactly as before the gate existed.
  assert.equal(res.status, 201);
  assert.ok(trackedAddresses().includes('caGate-null-104'));
});
