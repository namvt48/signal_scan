// Per-CA tier persistence: token_tiers table (db helpers), PUT /api/tier (write
// boundary), assembleSignals (read side), and the permanent-map guarantee — the
// orphan sweep must NOT delete tier rows, so a pruned CA keeps its tier for a
// later re-add. Same harness as wallet-watch-trade.test.ts: in-memory DB + the
// real createApp over an ephemeral port.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { deleteTier, deleteTrackedCa, insertTrackedCa, listTiers, open, pruneUntrackedCas, setTier } from '../src/db.js';
import { createApp } from '../src/api.js';
import { assembleSignals } from '../src/signals.js';
// AUTH CONTRACT v1: PUT /api/tier is admin-only — sign a REAL admin ID token
// against the testkit's local JWKS (no auth bypass; production middleware path).
import { createTestAuth } from './auth-testkit.js';

const CA = 'caTier-sol-001';
const EVM_CA = '0x6A2f9C4e1B7d3F8a5E0c2D6b9A4f7C1e3D5b8E2a';
const ORPHAN = 'caTier-orphan-003';

interface TierJson {
  ca?: string;
  chain?: string;
  tier?: string | null;
  error?: string;
}

let adminAuth = '';
let server: Server;
let base = '';

async function put(body: unknown): Promise<{ status: number; json: TierJson }> {
  const res = await fetch(`${base}/api/tier`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: adminAuth },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as TierJson };
}

function tierOf(ca: string): string | undefined {
  return listTiers().find((t) => t.ca === ca)?.tier;
}

function signalTier(ca: string): string | null | undefined {
  return assembleSignals().find((s) => s.ca === ca)?.tier;
}

before(async () => {
  open(':memory:');
  // entry_usd unknown (NULL) fails the minUsd gate open, so the rows reach /api/signals.
  insertTrackedCa({ address: CA, chain: 'sol', note: '' });
  insertTrackedCa({ address: EVM_CA, chain: 'base', note: '' });
  const auth = await createTestAuth();
  adminAuth = `Bearer ${await auth.signToken(auth.adminEmail)}`;
  server = createApp('test', auth.deps).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

test('setTier persists the row, listTiers returns it, assembleSignals surfaces it', () => {
  // Given: an unrated tracked CA.
  assert.equal(signalTier(CA), null);

  // When: the db helper writes a tier.
  setTier(CA, 'sol', 'S+');

  // Then: the row round-trips and the DTO carries the stored tier.
  const row = listTiers().find((t) => t.ca === CA && t.chain === 'sol');
  assert.equal(row?.tier, 'S+');
  assert.equal(typeof row?.updated_at, 'number');
  assert.equal(signalTier(CA), 'S+');

  // And: a second write overwrites (ON CONFLICT DO UPDATE), never duplicates.
  setTier(CA, 'sol', 'B');
  assert.equal(tierOf(CA), 'B');
  assert.equal(listTiers().filter((t) => t.ca === CA).length, 1);
});

test('PUT /api/tier: 200 on a valid tier, EVM ca is stored canonical (lowercase)', async () => {
  // When: a valid rating lands over HTTP.
  const res = await put({ ca: CA, chain: 'sol', tier: 'A+' });

  // Then: 200 + the contract body, persisted.
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ca: CA, chain: 'sol', tier: 'A+' });
  assert.equal(tierOf(CA), 'A+');
  assert.equal(signalTier(CA), 'A+');

  // And: a mixed-case EVM address is canonicalized on write and in the response.
  const evm = await put({ ca: EVM_CA, chain: 'base', tier: 'S' });
  assert.equal(evm.status, 200);
  assert.equal(evm.json.ca, EVM_CA.toLowerCase());
  assert.equal(tierOf(EVM_CA.toLowerCase()), 'S');
  assert.equal(tierOf(EVM_CA), undefined, 'the mixed-case key must not be stored verbatim');
});

test('PUT /api/tier: null, absent or empty tier clears — the row is DELETED, signals read null', async () => {
  // Given: a rated CA.
  assert.equal(tierOf(CA), 'A+');

  // When: an explicit null clears it.
  const cleared = await put({ ca: CA, chain: 'sol', tier: null });

  // Then: 200 + tier null, row gone, DTO back to unrated.
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.json, { ca: CA, chain: 'sol', tier: null });
  assert.equal(tierOf(CA), undefined);
  assert.equal(signalTier(CA), null);

  // And: absent / empty-string tier mean clear too (no 400, no row written).
  await setTier(CA, 'sol', 'A');
  assert.equal((await put({ ca: CA, chain: 'sol' })).status, 200);
  assert.equal(tierOf(CA), undefined);
  await setTier(CA, 'sol', 'A');
  const empty = await put({ ca: CA, chain: 'sol', tier: '' });
  assert.equal(empty.status, 200);
  assert.equal(empty.json.tier, null);
  assert.equal(tierOf(CA), undefined);
});

test('PUT /api/tier: 400 on invalid tier, invalid chain or missing ca — nothing written', async () => {
  const badTier = await put({ ca: CA, chain: 'sol', tier: 'C' });
  assert.equal(badTier.status, 400);
  assert.equal(badTier.json.error, 'tier must be one of S+, S, A+, A, B+, B, P or null');

  assert.equal((await put({ ca: CA, chain: 'doge', tier: 'S' })).status, 400);
  assert.equal((await put({ chain: 'sol', tier: 'S' })).status, 400);
  assert.equal((await put({ ca: '  ', chain: 'sol', tier: 'S' })).status, 400);
  assert.equal((await put({})).status, 400);

  // A rejected write must not touch the table.
  assert.equal(tierOf(CA), undefined);
});

test('PUT /api/tier: 404 for a CA that is not tracked', async () => {
  const res = await put({ ca: 'caTier-ghost-999', chain: 'sol', tier: 'S' });
  assert.equal(res.status, 404);
  assert.deepEqual(res.json, { error: 'CA not tracked' });
  assert.equal(tierOf('caTier-ghost-999'), undefined);

  // Tracked on ANOTHER chain only — the (ca, chain) key must not cross.
  const wrongChain = await put({ ca: CA, chain: 'bsc', tier: 'S' });
  assert.equal(wrongChain.status, 404);
});

test('PUT /api/tier: P (Pass) is saved in token_tiers, removed from dashboard, and blocked from re-adding', async () => {
  insertTrackedCa({ address: 'caTier-P-004', chain: 'sol', note: '' });
  const res = await put({ ca: 'caTier-P-004', chain: 'sol', tier: 'P' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ca: 'caTier-P-004', chain: 'sol', tier: 'P' });
  assert.equal(tierOf('caTier-P-004'), 'P');
  // Dropped from dashboard:
  assert.equal(signalTier('caTier-P-004'), undefined);
  // Blocked from re-adding:
  assert.throws(() => insertTrackedCa({ address: 'caTier-P-004', chain: 'sol', note: '' }), /tier is Pass/);
});

test('immutable Pass tombstone: cannot be cleared (null), re-rated (B), or re-added even with BUY trade', async () => {
  const CA_PASS = 'caTier-P-immutable';
  insertTrackedCa({ address: CA_PASS, chain: 'sol', note: '' });
  await put({ ca: CA_PASS, chain: 'sol', tier: 'P' });
  assert.equal(tierOf(CA_PASS), 'P');

  // 1. Attempt to clear tier via PUT /api/tier with null -> 409 Conflict
  const clearRes = await put({ ca: CA_PASS, chain: 'sol', tier: null });
  assert.equal(clearRes.status, 409);
  assert.equal(tierOf(CA_PASS), 'P');

  // 2. Attempt to re-rate via PUT /api/tier with 'B' -> 409 Conflict
  const rerateRes = await put({ ca: CA_PASS, chain: 'sol', tier: 'B' });
  assert.equal(rerateRes.status, 409);
  assert.equal(tierOf(CA_PASS), 'P');

  // 3. Direct DB helper attempts throw
  assert.throws(() => deleteTier(CA_PASS, 'sol'), /permanently blocked as Pass/);
  assert.throws(() => setTier(CA_PASS, 'sol', 'B'), /permanently blocked as Pass/);
  assert.equal(tierOf(CA_PASS), 'P');

  // 4. Inflow attempt via POST /api/wallet-watch/trades is skipped
  const tradeRes = await fetch(`${base}/api/wallet-watch/trades`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: adminAuth },
    body: JSON.stringify({
      wallet: 'any-wallet',
      ca: CA_PASS,
      chain: 'sol',
      side: 'buy',
      tx: 'tx-immutable-buy',
      ts: Date.now(),
      amountUsd: 1000,
    }),
  });
  assert.equal(tradeRes.status, 200);
  const tradeJson = await tradeRes.json();
  assert.deepEqual(tradeJson, { inserted: 0, skipped: 'pass-tier' });

  // 5. Inflow attempt via POST /api/tracked-cas is skipped
  const addRes = await fetch(`${base}/api/tracked-cas`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: adminAuth },
    body: JSON.stringify({ address: CA_PASS, chain: 'sol', note: 'attempt re-add' }),
  });
  assert.equal(addRes.status, 200);
  const addJson = await addRes.json();
  assert.deepEqual(addJson, { skipped: 'pass-tier' });

  // 6. Direct insert throws
  assert.throws(() => insertTrackedCa({ address: CA_PASS, chain: 'sol', note: '' }), /tier is Pass/);
});

test('tier map is permanent: pruning keeps the row, re-adding the CA restores the tier', () => {
  // Given: a tracked CA with a stored tier.
  const row = insertTrackedCa({ address: ORPHAN, chain: 'sol', note: '' });
  setTier(ORPHAN, 'sol', 'B+');
  assert.equal(tierOf(ORPHAN), 'B+');
  assert.equal(signalTier(ORPHAN), 'B+');

  // When: the CA is deleted and a prune path runs sweepOrphanedCaData.
  deleteTrackedCa(row.id);
  pruneUntrackedCas(1_000);

  // Then: the user's map survives — the sweep must NOT touch token_tiers.
  assert.equal(tierOf(ORPHAN), 'B+');

  // And: the DTO is unrated only because the CA itself is gone, not because the tier was lost.
  assert.equal(signalTier(ORPHAN), undefined);

  // And: re-adding the same CA comes back tiered with no extra write ("mỗi khi add mới CA thì check cái này").
  insertTrackedCa({ address: ORPHAN, chain: 'sol', note: '' });
  assert.equal(signalTier(ORPHAN), 'B+');
});
