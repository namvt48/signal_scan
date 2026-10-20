import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/api.js';
import { getDb, insertTrackedCa, open, saveMetricPollResponse } from '../src/db.js';
import { updateTokenAnalytics, updateTokenMetrics } from '../src/ingest.js';
import { updateThresholds } from '../src/settings.js';
import { assembleSignals, type TokenSignal } from '../src/signals.js';
import { config } from '../src/config.js';
import { freshPercentageInRange } from '../../src/lib/signalMetrics.js';
import { createTestAuth } from './auth-testkit.js';

let server: Server;
let base = '';
let viewer = '';
before(async () => {
  open(':memory:');
  updateThresholds({ freshMinPct: 10, t100MinMultiple: 1.2, minMc: 0, maxMc: -1 });
  for (const [ca, fresh] of [['fresh-below-gate', 5], ['fresh-zero', 0]] as const) {
    insertTrackedCa({ address: ca, chain: 'sol', note: '' });
    updateTokenMetrics(ca, 'sol', { nansenFreshPct: fresh });
    updateTokenAnalytics(ca, 'sol', { t100Pct: 50, t100Multiple: 2 });
  }
  insertTrackedCa({ address: 'fresh-unknown', chain: 'sol', note: '' });
  const auth = await createTestAuth();
  viewer = await auth.bearer(auth.viewerEmail);
  server = createApp('test', auth.deps).listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test('normal API response preserves known below-gate Fresh for explicit inclusive ranges', async () => {
  const response = await fetch(`${base}/api/signals?allFactors=0`, { headers: { authorization: viewer } });
  assert.equal(response.status, 200);
  const rows = await response.json() as TokenSignal[];
  const row = rows.find((s) => s.ca === 'fresh-below-gate');
  assert.ok(row);
  assert.equal(row.nansen.pass.fresh, false);
  assert.equal(row.nansen.freshCurrent, true);
  assert.equal(row.nansen.pass.t100, true);
  assert.equal(row.nansen.fresh, undefined, 'normal setup display remains gated');
  assert.equal(freshPercentageInRange(row.nansen, '0', '10'), true);
  assert.equal(freshPercentageInRange(row.nansen, '5', '5'), true);
  assert.equal(freshPercentageInRange(row.nansen, '6', '10'), false);
  const zero = rows.find((s) => s.ca === 'fresh-zero');
  assert.ok(zero);
  assert.equal(freshPercentageInRange(zero.nansen, '0', '0'), true);
  const unknown = rows.find((s) => s.ca === 'fresh-unknown');
  assert.ok(unknown);
  assert.equal(unknown.nansen.freshCurrent, false);
  assert.equal(freshPercentageInRange(unknown.nansen, '0', '10'), false);
});

test('stale, unknown-time, and future Fresh remain historical without qualifying current signals', async () => {
  const now = Date.now();
  for (const [ca, sampledAt] of [
    ['fresh-stale', now - config.pollSetupMs - 60_000],
    ['fresh-no-time', now],
    ['fresh-future', now + config.pollSetupMs],
  ] as const) {
    insertTrackedCa({ address: ca, chain: 'sol', note: '' });
    updateTokenMetrics(ca, 'sol', { nansenFreshPct: 50 }, sampledAt);
    updateTokenAnalytics(ca, 'sol', { t100Pct: 50, t100Multiple: 2 });
  }
  getDb().prepare("UPDATE token_state SET fresh_updated_at = NULL WHERE ca = 'fresh-no-time'").run();

  const response = await fetch(`${base}/api/signals?allFactors=1`, { headers: { authorization: viewer } });
  assert.equal(response.status, 200);
  const rows = await response.json() as TokenSignal[];
  for (const ca of ['fresh-stale', 'fresh-no-time', 'fresh-future']) {
    const row = rows.find((signal) => signal.ca === ca);
    assert.ok(row);
    assert.equal(row.nansen.pass.fresh, false, ca);
    assert.equal(row.nansen.score, 1, `${ca}: only T100 still passes`);
    assert.equal(row.nansen.fresh, 50, `${ca}: historical reading stays visible`);
    assert.equal(freshPercentageInRange(row.nansen, '10', '100'), false, ca);
    assert.equal(freshPercentageInRange(row.nansen, '', ''), true, ca);
  }
});

test('Fresh expires exactly at its TTL and unrelated market updates cannot refresh it', () => {
  const ca = 'fresh-ttl-boundary';
  const sampledAt = Date.parse('2026-10-01T00:00:00Z');
  insertTrackedCa({ address: ca, chain: 'sol', note: '' });
  updateTokenMetrics(ca, 'sol', { nansenFreshPct: 50 }, sampledAt);
  updateTokenMetrics(ca, 'sol', { price: 2 }, sampledAt + config.pollSetupMs);

  const current = assembleSignals(sampledAt + config.pollSetupMs - 1).find((signal) => signal.ca === ca);
  const expired = assembleSignals(sampledAt + config.pollSetupMs).find((signal) => signal.ca === ca);
  assert.ok(current && expired);
  assert.equal(current.nansen.pass.fresh, true);
  assert.equal(expired.nansen.pass.fresh, false);
  assert.equal(expired.nansen.score, 0);
  assert.equal(expired.nansen.fresh, 50);
  assert.equal(expired.nansen.freshUpdatedAt, sampledAt);
});

test('a legacy Fresh value uses its successful Gini timestamp when the ingest marker is absent', () => {
  const ca = 'fresh-legacy-success-time';
  const sampledAt = Date.parse('2026-10-02T00:00:00Z');
  insertTrackedCa({ address: ca, chain: 'sol', note: '' });
  updateTokenMetrics(ca, 'sol', { nansenFreshPct: 50 }, sampledAt);
  saveMetricPollResponse(ca, 'sol', 'gini', sampledAt, sampledAt + config.pollSetupMs, { nansenFreshPct: 50 });
  getDb().prepare('UPDATE token_state SET fresh_updated_at = NULL WHERE ca = ?').run(ca);

  const current = assembleSignals(sampledAt + config.pollSetupMs - 1).find((signal) => signal.ca === ca);
  const expired = assembleSignals(sampledAt + config.pollSetupMs).find((signal) => signal.ca === ca);
  assert.ok(current && expired);
  assert.equal(current.nansen.pass.fresh, true);
  assert.equal(current.dataUpdatedAt?.fresh, sampledAt);
  assert.equal(expired.nansen.pass.fresh, false);
  assert.equal(expired.nansen.rawFresh, 50);
});
