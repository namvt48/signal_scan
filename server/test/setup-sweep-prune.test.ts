// F2 fix regression (plan setup-fill-on-add): the setupSweep file-cache prune must
// read the tracked-CA set FRESH at prune time. The sweep is paced across ~0.8 ×
// POLL_SETUP_MS (~9.6h in prod), so a CA added mid-sweep (POST /api/tracked-cas →
// kickCAs → early kick → refreshSeries → putSetupCacheEntry) writes a legitimate
// fresh entry whose key is absent from the sweep-start snapshot — pruning against
// that stale snapshot deletes it, voiding the wipe-resilience guarantee.
// Test: run the real setupSweep, add a CA through the real kickCAs path while the
// sweep is paced mid-queue, and assert the entry SURVIVES the closing prune.
// Env BEFORE the src imports (node:test = one process per file): crawl gate on,
// POLL_SETUP_MS/NEW_CA_PRIORITY_MS shrunk so pacedFor slots are test-sized —
// assertions are on cache/DB state, never on wall-clock.
process.env.NANSEN_CRAWL = 'on';
process.env.POLL_SETUP_MS = '1000';
process.env.POLL_SETUP_RETRY_MS = '1000';
process.env.NEW_CA_PRIORITY_MS = '1000';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DoorConn, DoorHttpResponse } from '../src/crawl.js';
import type { HourlyStatsRow, TgmFlowsRow, TokenFlowsClient } from '../src/providers/nansen.js';
import type { MarketDataProvider, MetricPatch, TokenInfo, WalletTokenHolding } from '../src/providers/provider.js';
import type { Chain } from '../src/shared/chain.js';

const { open, insertTrackedCa, getTokenState } = await import('../src/db.js');
const { loadSetupCache, getSetupCacheEntry } = await import('../src/setup-cache.js');
const { DoorPool, setPoolForTest } = await import('../src/crawl.js');
const { kickCAs, setPollerDeps, earlySetupIdle, setupSweep } = await import('../src/poller.js');

const CHAIN: Chain = 'sol';
const OLD1 = 'CA-SWEEP-OLD-1';
const OLD2 = 'CA-SWEEP-OLD-2';
const NEW = 'CA-SWEEP-MIDADD';
const DAY = 86_400_000;

function flowRows(points: readonly (readonly [ageDays: number, total: number])[], now: number): TgmFlowsRow[] {
  return points.map(([ageDays, total]) => ({ date: new Date(now - ageDays * DAY).toISOString(), token_amount: total, holders_count: 1 }));
}

function okJson(data: HourlyStatsRow[]): DoorHttpResponse {
  return { status: 200, contentType: 'application/json', retryAfter: null, head: '', len: 2, json: { data }, threw: false };
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Fake of the official tgm/flows client feeding the T100/LF path. */
function installFakeFlows(series: TgmFlowsRow[], exchange: TgmFlowsRow[]): TokenFlowsClient {
  return { tokenFlows: async (req) => (req.label === 'exchange' ? exchange : series) };
}

/** Tripwire door — the T100/LF path must never fetch through it (returns empty). */
async function installFakeDoor(): Promise<void> {
  const conn: DoorConn = {
    fetch: async () => okJson([]),
    invalidate: async () => {},
    close: async () => {},
  };
  const pool = new DoorPool({
    connect: async () => conn,
    now: () => Date.now(),
    sleep: async () => {},
    config: {
      wsEndpoint: 'ws://fake-door',
      proxies: [],
      pathBudget: 1_000,
      budgetWindowMs: 60_000,
      doorCapPerMin: 1_000,
      warmupTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
      quarantineJitterMs: 0,
    },
    log: () => {},
  });
  pool.start();
  setPoolForTest(pool);
  await nextTurn(); // let the fake door finish warming before the first postJson
}

/** kickToken's credit tokenInfo creates the row — the fake resolves immediately. */
function fakeProvider(deployedAt: number): MarketDataProvider {
  return {
    name: 'fake-sweep-prune',
    tokenInfo: async (ca: string, chain: Chain): Promise<TokenInfo> => ({
      ca,
      chain,
      price: 1,
      holders: 100,
      volume24h: 1_000,
      buyVol24h: 600,
      sellVol24h: 400,
      marketCap: 100_000,
      liquidity: 50_000,
      supply: 1_000_000_000,
      deployedAt,
      symbol: 'TST',
    }),
    metric: async (): Promise<MetricPatch> => ({}),
    walletTokenHoldings: async (): Promise<WalletTokenHolding[]> => [],
  };
}

/** Waits (bounded) until kickToken's upsert created the row — sync point, not an assertion. */
async function awaitRow(ca: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (getTokenState(ca, CHAIN) === undefined) {
    if (Date.now() > deadline) throw new Error('token_state row never appeared');
    await nextTurn();
  }
}

test('setupSweep prune: a CA added mid-sweep keeps its fresh cache entry (stale snapshot must not prune it)', async () => {
  open(':memory:');
  loadSetupCache(join(mkdtempSync(join(tmpdir(), 'setup-sweep-prune-')), 'nansen-cache.json'));
  const now = Date.now();
  const deployedAt = now - 2 * DAY;
  // series: leftmost 900 @ deploy, trough 600, latest 700 → multiple 1.5; exchange leftmost 120
  await installFakeDoor();
  const flows = installFakeFlows(flowRows([[2, 900], [1, 600], [0, 700]], now), flowRows([[2, 120], [1, 130]], now));
  const provider = fakeProvider(deployedAt);
  setPollerDeps(provider, null, flows);
  insertTrackedCa({ address: OLD1, chain: CHAIN, note: '' });
  insertTrackedCa({ address: OLD2, chain: CHAIN, note: '' });

  // Sweep starts NOW — its snapshot is {OLD1, OLD2}; pacedFor (400ms slot at
  // POLL_SETUP_MS=1000, 2 items) keeps it in flight while the mid-add happens.
  const sweep = setupSweep(provider);

  // The real mid-sweep add path: POST /api/tracked-cas inserts the row, then kickCAs
  // chains kickToken → kickSetupEarly → refreshSeries → putSetupCacheEntry.
  insertTrackedCa({ address: NEW, chain: CHAIN, note: '' });
  kickCAs([{ address: NEW, chain: CHAIN }]);
  await awaitRow(NEW);
  await earlySetupIdle();

  // Precondition: the early pass really wrote a fresh entry BEFORE the prune ran.
  const written = getSetupCacheEntry(NEW, CHAIN);
  assert.ok(written, 'early pass must have cached the mid-add CA (precondition)');
  assert.equal(written.t100_multiple, 1.5, 'cached entry carries the real derived columns');
  assert.equal(getTokenState(NEW, CHAIN)?.genesis_bal, 120, 'early pass filled the row too');

  await sweep; // closing prune runs here

  // THE regression assertion: prune must read the tracked set fresh — NEW is
  // tracked and its entry is seconds old, so it survives. Against the stale
  // sweep-start snapshot the entry is deleted and this fails.
  assert.ok(
    getSetupCacheEntry(NEW, CHAIN),
    'mid-sweep add: the fresh cache entry must SURVIVE the setupSweep prune (stale snapshot deletes it)',
  );
});
