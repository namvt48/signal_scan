// Fix D regression (2026-09-29): per-field crawl TTL. The marker means "we actually
// OBTAINED this field's data at T", not "we made a call at T" — empty data must not
// stamp. gini/fresh% keeps the 6h clock (POLL_SETUP_MS); the T100 series gets its own
// 12h clock (POLL_FLOWS_MS). Absence at runtime ⇒ never obtained ⇒ stale; legacy
// entries (no marker) are backfilled from taken_at ONCE at load, not at read time.
// Env BEFORE the src imports (node:test = one process per file): the crawl gate is
// forced, the retry ladder is flattened to its 60s floor so a clock-advanced pass can
// re-ask, and both cadences keep their PROD defaults so the boundary ages are real.
// Each test uses its own CA so independent persisted retry clocks cannot collide.
process.env.NANSEN_CRAWL = 'on';
process.env.POLL_SETUP_RETRY_MS = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DoorConn, DoorHttpResponse } from '../src/crawl.js';
import type { HourlyStatsRow, TgmFlowsRow, TokenFlowsClient } from '../src/providers/nansen.js';
import type { MarketDataProvider, MetricPatch, TokenInfo, WalletTokenHolding } from '../src/providers/provider.js';
import type { Chain } from '../src/shared/chain.js';
import type { SetupCacheEntry } from '../src/setup-cache.js';

const { getTokenState, open, insertTrackedCa } = await import('../src/db.js');
const { upsertTokenInfo, updateTokenAnalytics } = await import('../src/ingest.js');
const {
  getSetupCacheEntry,
  isInfoFresh,
  isSeriesFresh,
  loadSetupCache,
  putSetupCacheEntry,
  stampSetupCacheField,
} = await import('../src/setup-cache.js');
const { DoorPool, setPoolForTest } = await import('../src/crawl.js');
const { flowsSweep, refreshSeries, setPollerDeps, setupSweep } = await import('../src/poller.js');
const { config } = await import('../src/config.js');

const CHAIN: Chain = 'sol';
const DAY = 86_400_000;
const HOUR = 3_600_000;

function flowRows(points: readonly (readonly [ageDays: number, total: number])[], now: number): TgmFlowsRow[] {
  return points.map(([ageDays, total]) => ({ date: new Date(now - ageDays * DAY).toISOString(), token_amount: total, holders_count: 1 }));
}

function okJson(data: HourlyStatsRow[]): DoorHttpResponse {
  return { status: 200, contentType: 'application/json', retryAfter: null, head: '', len: 2, json: { data }, threw: false };
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

let seriesCalls = 0;
let exchangeCalls = 0;

/** Label-counting fake of the official tgm/flows client. */
function installFakeFlows(series: TgmFlowsRow[], exchange: TgmFlowsRow[]): TokenFlowsClient {
  seriesCalls = 0;
  exchangeCalls = 0;
  return {
    tokenFlows: async (req) => {
      if (req.label === 'exchange') exchangeCalls += 1;
      else seriesCalls += 1;
      return req.label === 'exchange' ? exchange : series;
    },
  };
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
  await nextTurn();
}

/** Run `fn` with Date.now() pinned — setupSweep's miss ladder reads the wall clock. */
async function atClock(at: number, fn: () => Promise<void>): Promise<void> {
  const realNow = Date.now;
  Date.now = () => at;
  try {
    await fn();
  } finally {
    Date.now = realNow;
  }
}

function info(ca: string, now: number): TokenInfo {
  return {
    ca,
    chain: CHAIN,
    price: 1,
    holders: 100,
    volume24h: 1_000,
    buyVol24h: 600,
    sellVol24h: 400,
    marketCap: 100_000,
    liquidity: 50_000,
    supply: 1_000_000_000,
    deployedAt: now - 2 * DAY,
    symbol: 'TST',
  };
}

function countingProvider(now: number, metricCalls: Map<string, number>, patch: MetricPatch = { nansenFreshPct: 30 }): MarketDataProvider {
  return {
    name: 'fake-field-ttl',
    tokenInfo: async (ca: string): Promise<TokenInfo> => info(ca, now),
    metric: async (ca: string): Promise<MetricPatch> => {
      metricCalls.set(ca, (metricCalls.get(ca) ?? 0) + 1);
      return patch;
    },
    walletTokenHoldings: async (): Promise<WalletTokenHolding[]> => [],
  };
}

function entryFor(ca: string, over: Partial<SetupCacheEntry>): SetupCacheEntry {
  const now = Date.now();
  return {
    ca,
    chain: CHAIN,
    taken_at: now,
    window: 'week',
    series_from: now - 7 * DAY,
    series: [{ t: new Date(now - DAY).toISOString(), total: 700 }],
    exchange: [{ t: new Date(now - DAY).toISOString(), total: 120 }],
    t100_pct: 40,
    t100_multiple: 1.5,
    anchor_at: now,
    lf_rule: 'bucket-hour-v2',
    genesis_bal: 120,
    ...over,
  };
}

function tempCache(): string {
  return join(mkdtempSync(join(tmpdir(), 'field-ttl-')), 'nansen-cache.json');
}

test('isInfoFresh / isSeriesFresh: TTL boundaries — no marker means never obtained', () => {
  const now = Date.now();
  const INFO = config.pollSetupMs; // 6h
  const SERIES = config.pollFlowsMs; // 12h

  assert.equal(isInfoFresh(entryFor('a', { info_at: now - (INFO - 1) }), now), true);
  assert.equal(isInfoFresh(entryFor('b', { info_at: now - INFO }), now), false);
  assert.equal(isSeriesFresh(entryFor('c', { series_at: now - (SERIES - 1) }), now), true);
  assert.equal(isSeriesFresh(entryFor('d', { series_at: now - SERIES }), now), false);
  assert.equal(isInfoFresh(entryFor('e', { info_at: now }), now), true);

  // No marker ⇒ never obtained ⇒ STALE, even when taken_at is fresh. The legacy
  // taken_at fallback is load-time only now — see the legacy-load test below.
  assert.equal(isInfoFresh(entryFor('f', { taken_at: now - (INFO - 1) }), now), false);
  assert.equal(isSeriesFresh(entryFor('g', { taken_at: now - (SERIES - 1) }), now), false);
});

test('gini pass with NO nansenFreshPct does not stamp info_at — the CA keeps retrying', async () => {
  const ca = 'CA-TTL-EMPTY-GINI';
  open(':memory:');
  loadSetupCache(tempCache());
  const now = Date.now();
  await installFakeDoor();
  const metricCalls = new Map<string, number>();
  const provider = countingProvider(now, metricCalls, {}); // DAS-floor: resolves with no fresh%
  setPollerDeps(provider, null, installFakeFlows(flowRows([[2, 900], [1, 600], [0, 700]], now), flowRows([[2, 120], [1, 130]], now)));
  insertTrackedCa({ address: ca, chain: CHAIN, note: '' });
  upsertTokenInfo(info(ca, now));
  // series is fresh, but gini was never obtained → setup is owed regardless of taken_at.
  putSetupCacheEntry(entryFor(ca, { taken_at: now - HOUR, series_at: now - HOUR }));

  await atClock(now, () => setupSweep(provider));
  assert.equal(metricCalls.get(ca), 1, 'no info_at ⇒ enough to owe setup ⇒ gini asked once');
  assert.equal(seriesCalls, 0, 'a fresh series applies from cache — no flows fetch');
  assert.equal(getSetupCacheEntry(ca, CHAIN)?.info_at, undefined, 'empty gini must NOT stamp info_at');

  // Past the 60s miss floor ⇒ the owner's old retry ladder re-asks.
  await atClock(now + 61_000, () => setupSweep(provider));
  assert.equal(metricCalls.get(ca), 2, 'still-owed gini is re-asked on the next pass');
});

test('gini pass WITH nansenFreshPct stamps info_at — the CA then sits on the 6h clock', async () => {
  const ca = 'CA-TTL-GINI-OK';
  open(':memory:');
  loadSetupCache(tempCache());
  const now = Date.now();
  await installFakeDoor();
  const metricCalls = new Map<string, number>();
  const provider = countingProvider(now, metricCalls); // { nansenFreshPct: 30 }
  setPollerDeps(provider, null, installFakeFlows(flowRows([[2, 900], [1, 600], [0, 700]], now), flowRows([[2, 120], [1, 130]], now)));
  insertTrackedCa({ address: ca, chain: CHAIN, note: '' });
  upsertTokenInfo(info(ca, now));
  putSetupCacheEntry(entryFor(ca, { taken_at: now - HOUR, series_at: now - HOUR }));

  await atClock(now, () => setupSweep(provider));
  assert.equal(metricCalls.get(ca), 1, 'gini owed (no info_at) ⇒ asked');
  assert.equal(typeof getSetupCacheEntry(ca, CHAIN)?.info_at, 'number', 'real gini data stamps info_at');

  await atClock(now + 61_000, () => setupSweep(provider));
  assert.equal(metricCalls.get(ca), 1, 'a stamped gini (61s < 6h) is NOT re-asked');
});

test('refreshSeries: fresh series with no info_at applies from cache and invents no gini stamp', async () => {
  const ca = 'CA-TTL-NO-INFO';
  open(':memory:');
  loadSetupCache(tempCache());
  const now = Date.now();
  await installFakeDoor();
  setPollerDeps(countingProvider(now, new Map()), null, installFakeFlows(flowRows([[2, 900], [1, 600], [0, 700]], now), flowRows([[2, 120], [1, 130]], now)));
  insertTrackedCa({ address: ca, chain: CHAIN, note: '' });
  upsertTokenInfo(info(ca, now));
  putSetupCacheEntry(entryFor(ca, { taken_at: now - HOUR, series_at: now - HOUR })); // no info_at

  await refreshSeries(ca, CHAIN);

  assert.equal(seriesCalls, 0, 'a fresh series is applied from cache — never fetched');
  assert.equal(getSetupCacheEntry(ca, CHAIN)?.info_at, undefined, 'a series pass must not fabricate a gini stamp');
});


test('legacy on-disk entry (no markers) is backfilled from taken_at at load — no deploy-day burst', () => {
  const file = tempCache();
  const now = Date.now();
  const takenAt = now - 1_000;
  const legacy = {
    version: 1,
    entries: [
      {
        ca: 'CA-LEGACY',
        chain: 'sol',
        taken_at: takenAt,
        window: 'week',
        series_from: now - 7 * DAY,
        series: [{ t: new Date(now - DAY).toISOString(), total: 700 }],
        exchange: [{ t: new Date(now - DAY).toISOString(), total: 120 }],
        t100_pct: 40,
        t100_multiple: 1.5,
        anchor_at: now,
        genesis_bal: 120,
      },
    ],
  };
  writeFileSync(file, JSON.stringify(legacy));

  const e = loadSetupCache(file).get('sol:CA-LEGACY');
  assert.equal(e?.info_at, takenAt, 'legacy info_at backfilled from taken_at at load');
  assert.equal(e?.series_at, takenAt, 'legacy series_at backfilled from taken_at at load');
  assert.equal(isInfoFresh(e!, now), true);
  assert.equal(isSeriesFresh(e!, now), true);
});

test('needsSetup: info_at 7h old re-asks gini even though series_at is fresh', async () => {
  const ca = 'CA-TTL-INFO-OLD';
  open(':memory:');
  loadSetupCache(tempCache());
  const now = Date.now();
  await installFakeDoor();
  const metricCalls = new Map<string, number>();
  const provider = countingProvider(now, metricCalls);
  setPollerDeps(provider, null, installFakeFlows(flowRows([[2, 900], [1, 600], [0, 700]], now), flowRows([[2, 120], [1, 130]], now)));
  insertTrackedCa({ address: ca, chain: CHAIN, note: '' });
  upsertTokenInfo(info(ca, now));
  putSetupCacheEntry(entryFor(ca, { taken_at: now - 7 * HOUR, info_at: now - 7 * HOUR, series_at: now - HOUR }));

  await setupSweep(provider);

  assert.equal(metricCalls.get(ca), 1, 'gini 7h old (> 6h TTL) must be re-asked');
  assert.equal(seriesCalls, 0, 'series 1h old (< 12h TTL) applies from cache — no flows fetch');
});

test('refreshSeries: stale series_at fetches; inside the TTL it applies from cache', async () => {
  const ca = 'CA-TTL-BOUNDARY';
  open(':memory:');
  loadSetupCache(tempCache());
  const now = Date.now();
  await installFakeDoor();
  setPollerDeps(countingProvider(now, new Map()), null, installFakeFlows(flowRows([[2, 900], [1, 600], [0, 700]], now), flowRows([[2, 120], [1, 130]], now)));
  insertTrackedCa({ address: ca, chain: CHAIN, note: '' });
  upsertTokenInfo(info(ca, now));
  updateTokenAnalytics(ca, CHAIN, { genesisBal: 120 }); // known LF → the exchange call is skipped

  const young = config.pollFlowsMs - HOUR; // just inside the 12h TTL
  putSetupCacheEntry(entryFor(ca, { taken_at: now - young, series_at: now - young }));
  await refreshSeries(ca, CHAIN);
  assert.equal(seriesCalls, 0, 'series_at inside the TTL is applied from cache, never fetched');

  const old = config.pollFlowsMs + HOUR; // just past the 12h TTL
  putSetupCacheEntry(entryFor(ca, { taken_at: now - old, series_at: now - old }));
  await refreshSeries(ca, CHAIN);
  assert.equal(seriesCalls, 1, 'series_at past the TTL must trigger one T100 fetch');
  assert.equal(exchangeCalls, 0, 'a known genesis_bal keeps the LF write-once guard');
});

test('applySeriesPass: a series fetch carries the previous info_at forward', async () => {
  const ca = 'CA-TTL-CARRY';
  open(':memory:');
  loadSetupCache(tempCache());
  const now = Date.now();
  await installFakeDoor();
  setPollerDeps(countingProvider(now, new Map()), null, installFakeFlows(flowRows([[2, 900], [1, 600], [0, 700]], now), flowRows([[2, 120], [1, 130]], now)));
  insertTrackedCa({ address: ca, chain: CHAIN, note: '' });
  upsertTokenInfo(info(ca, now));
  updateTokenAnalytics(ca, CHAIN, { genesisBal: 120 });
  const infoStamp = now - 5 * HOUR;
  const staleAt = now - config.pollFlowsMs - HOUR;
  putSetupCacheEntry(entryFor(ca, { taken_at: staleAt, series_at: staleAt, info_at: infoStamp }));

  await refreshSeries(ca, CHAIN);

  assert.ok(seriesCalls >= 1, 'a stale series must actually fetch');
  const e = getSetupCacheEntry(ca, CHAIN);
  assert.equal(e?.info_at, infoStamp, 'the series fetch must not lose the older-but-valid info_at');
  assert.ok((e?.series_at ?? 0) > now - 60_000, 'series_at advanced to this fetch');
});

test('round-trip: stampSetupCacheField writes both clocks to disk and reload keeps them', () => {
  const file = tempCache();
  loadSetupCache(file);
  const now = Date.now();
  putSetupCacheEntry(entryFor('caRT', { taken_at: now - 30 * HOUR, info_at: now - 30 * HOUR, series_at: now - 30 * HOUR }));

  stampSetupCacheField('caRT', CHAIN, 'info_at', now - 1_000);
  stampSetupCacheField('caRT', CHAIN, 'series_at', now - 2_000);

  const e = loadSetupCache(file).get('sol:caRT');
  assert.equal(e?.info_at, now - 1_000);
  assert.equal(e?.series_at, now - 2_000);

});

// Credit-leak regression (2026-09-29): flowsSweep walked ALL tracked CAs through an
// ALWAYS-fetch series pass, ignoring the per-field series_at marker. A CA with a
// fresh cache entry must cost ZERO credits; only a stale series_at may fetch.
test('flowsSweep: a cached CA with a FRESH series_at makes 0 series and 0 exchange calls', async () => {
  const ca = 'CA-FLOWS-FRESH';
  open(':memory:');
  loadSetupCache(tempCache());
  const now = Date.now();
  await installFakeDoor();
  setPollerDeps(countingProvider(now, new Map()), null, installFakeFlows(flowRows([[2, 900], [1, 600], [0, 700]], now), flowRows([[2, 120], [1, 130]], now)));
  insertTrackedCa({ address: ca, chain: CHAIN, note: '' });
  upsertTokenInfo(info(ca, now));
  putSetupCacheEntry(entryFor(ca, { taken_at: now - HOUR, series_at: now - HOUR }));

  await flowsSweep();

  assert.equal(seriesCalls, 0, 'a fresh series_at is honored — no T100 fetch');
  assert.equal(exchangeCalls, 0, 'a fresh pass costs no LF credit either');
});

test('flowsSweep: a cached CA with a STALE series_at makes exactly 1 series fetch', async () => {
  const ca = 'CA-FLOWS-STALE';
  open(':memory:');
  loadSetupCache(tempCache());
  const now = Date.now();
  await installFakeDoor();
  setPollerDeps(countingProvider(now, new Map()), null, installFakeFlows(flowRows([[2, 900], [1, 600], [0, 700]], now), flowRows([[2, 120], [1, 130]], now)));
  insertTrackedCa({ address: ca, chain: CHAIN, note: '' });
  upsertTokenInfo(info(ca, now));
  updateTokenAnalytics(ca, CHAIN, { genesisBal: 120 }); // known LF → write-once guard skips exchange
  const staleAt = now - config.pollFlowsMs - HOUR;
  putSetupCacheEntry(entryFor(ca, { taken_at: staleAt, series_at: staleAt }));

  await flowsSweep();

  assert.equal(seriesCalls, 1, 'a stale series_at must trigger exactly one T100 fetch');
  assert.equal(exchangeCalls, 0, 'a known genesis_bal keeps the LF write-once guard');
});

test('flowsSweep: a cached CA parked on info_at only (no series_at) still OWES its T100 — 1 fetch', async () => {
  const ca = 'CA-FLOWS-MARKERLESS';
  open(':memory:');
  loadSetupCache(tempCache());
  const now = Date.now();
  await installFakeDoor();
  setPollerDeps(countingProvider(now, new Map()), null, installFakeFlows(flowRows([[2, 900], [1, 600], [0, 700]], now), flowRows([[2, 120], [1, 130]], now)));
  insertTrackedCa({ address: ca, chain: CHAIN, note: '' });
  upsertTokenInfo(info(ca, now));
  updateTokenAnalytics(ca, CHAIN, { genesisBal: 120 });
  // gini landed (info_at), so setupSweep now counts this CA done — but the credit series
  // never did, and that pass is the CA's ONLY retry path. Parking it here leaves T100 at
  // NULL forever, so this filter must key on the series marker, never on entry presence.
  putSetupCacheEntry(entryFor(ca, { taken_at: now - HOUR, info_at: now - HOUR }));

  await flowsSweep();

  assert.equal(seriesCalls, 1, 'a markerless entry must still be retried by flowsSweep');
  assert.equal(exchangeCalls, 0, 'the known genesis_bal keeps the LF write-once guard');
});

test('flowsSweep: a tracked CA with NO cache entry is setupSweep\'s job — 0 calls', async () => {
  const ca = 'CA-FLOWS-NOCACHE';
  open(':memory:');
  loadSetupCache(tempCache());
  const now = Date.now();
  await installFakeDoor();
  setPollerDeps(countingProvider(now, new Map()), null, installFakeFlows(flowRows([[2, 900], [1, 600], [0, 700]], now), flowRows([[2, 120], [1, 130]], now)));
  insertTrackedCa({ address: ca, chain: CHAIN, note: '' });
  upsertTokenInfo(info(ca, now)); // row exists, but no cache entry → not flowsSweep's to fetch

  await flowsSweep();

  assert.equal(seriesCalls, 0, 'an uncached CA is left to setupSweep — flowsSweep must not fetch');
  assert.equal(exchangeCalls, 0, 'and must not fetch its LF either');
});

/** A marker-carrying, payload-less entry — numeric fields absent, arrays empty. */
function markerOnlyEntry(ca: string, over: Partial<SetupCacheEntry>): SetupCacheEntry {
  return {
    ca,
    chain: CHAIN,
    taken_at: Date.now(),
    window: '',
    series_from: undefined,
    series: [],
    exchange: [],
    t100_pct: undefined,
    t100_multiple: undefined,
    anchor_at: undefined,
    genesis_bal: undefined,
    ...over,
  };
}

// Decouple marker from payload (2026-09-29): 343 CAs held current numeric data
// but no cache entry — isStorable demanded non-empty series AND exchange, so the
// marker that parks the CA on its TTL was coupled to the chart payload.
test('marker-only entry: replay applies NOTHING — token_state bal/t100 untouched', async () => {
  const ca = 'CA-MARKER-REPLAY';
  open(':memory:');
  loadSetupCache(tempCache());
  const now = Date.now();
  await installFakeDoor();
  setPollerDeps(countingProvider(now, new Map()), null, installFakeFlows(flowRows([[2, 900], [1, 600], [0, 700]], now), flowRows([[2, 120], [1, 130]], now)));
  insertTrackedCa({ address: ca, chain: CHAIN, note: '' });
  upsertTokenInfo(info(ca, now));
  updateTokenAnalytics(ca, CHAIN, { t100Pct: 42, genesisBal: 7, anchorAt: now - 1_000, bal: { d1: { peak: 100, trough: 50 } } });

  putSetupCacheEntry(markerOnlyEntry(ca, { info_at: now, series_at: now }));
  assert.notEqual(getSetupCacheEntry(ca, CHAIN), undefined, 'a marker-only entry must be cached and replayable');

  await refreshSeries(ca, CHAIN);

  const st = getTokenState(ca, CHAIN);
  assert.ok(st);
  assert.equal(st.bal_peak_24h, 100, 'a payload-less replay must not wipe bal_peak_24h');
  assert.equal(st.bal_trough_24h, 50, 'a payload-less replay must not wipe bal_trough_24h');
  assert.equal(st.t100_pct, 42, 'a payload-less replay must not wipe t100_pct');
  assert.equal(seriesCalls, 0, 'a fresh marker applies from cache — no fetch');
});

test('empty series pass keeps prev series_at — no fresh stamp, marker-carrying entry persisted', async () => {
  const ca = 'CA-EMPTY-CARRY';
  open(':memory:');
  loadSetupCache(tempCache());
  const now = Date.now();
  await installFakeDoor();
  setPollerDeps(countingProvider(now, new Map()), null, installFakeFlows([], [])); // empty series
  insertTrackedCa({ address: ca, chain: CHAIN, note: '' });
  upsertTokenInfo(info(ca, now));
  updateTokenAnalytics(ca, CHAIN, { genesisBal: 120 });
  const staleAt = now - config.pollFlowsMs - HOUR;
  const staleTakenAt = staleAt - 5 * HOUR;
  putSetupCacheEntry(entryFor(ca, { taken_at: staleTakenAt, series_at: staleAt, info_at: staleAt }));

  await refreshSeries(ca, CHAIN);

  const e = getSetupCacheEntry(ca, CHAIN);
  assert.ok(e);
  assert.equal(e.series_at, staleAt, 'an empty pass must NOT stamp a fresh series_at — prev marker carried');
  assert.ok(e.taken_at > staleTakenAt, 'the empty pass still persisted a marker-carrying entry');
  assert.ok(Date.now() - (e.series_at ?? 0) >= config.pollFlowsMs, 'the carried marker is still the stale one');
});

test('verified LF remains cached when raw exchange points are absent on a stale series pass', async () => {
  const ca = 'CA-HAVE-LF-RELAX';
  open(':memory:');
  loadSetupCache(tempCache());
  const now = Date.now();
  await installFakeDoor();
  setPollerDeps(countingProvider(now, new Map()), null, installFakeFlows(flowRows([[2, 900], [1, 600], [0, 700]], now), flowRows([[2, 120], [1, 130]], now)));
  insertTrackedCa({ address: ca, chain: CHAIN, note: '' });
  upsertTokenInfo(info(ca, now));
  updateTokenAnalytics(ca, CHAIN, { genesisBal: 120 });
  const staleAt = now - config.pollFlowsMs - HOUR;
  putSetupCacheEntry(markerOnlyEntry(ca, {
    taken_at: staleAt, info_at: staleAt, series_at: staleAt,
    genesis_bal: 120, lf_rule: 'bucket-hour-v2',
  }));

  await refreshSeries(ca, CHAIN);

  assert.equal(seriesCalls, 1, 'a stale series still fetches the T100');
  assert.equal(exchangeCalls, 0, 'a verified same-resolution LF avoids repeat reads even without raw cached points');
});
