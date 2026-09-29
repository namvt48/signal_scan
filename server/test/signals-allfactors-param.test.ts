import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { insertTrackedCa, open } from '../src/db.js';
import { updateTokenMetrics } from '../src/ingest.js';
import { getDebugAllFactors, thresholdDefaults, updateThresholds } from '../src/settings.js';
import type { TokenSignal } from '../src/signals.js';
import { createApp } from '../src/api.js';

const CA_FAIL = 'allf-fail-fresh-001';
const CA_PASS = 'allf-pass-fresh-002';
const CA_CHEAP = 'allf-below-minusd-003';
// AUTH CONTRACT v1: GET /api/signals accepts the service role (via createApp
// deps — static imports snapshot config before env in the body could apply).
const SERVICE_TOKEN = 'signals-allfactors-service-token';

let server: Server;
let base = '';

async function getSignals(query: string): Promise<TokenSignal[]> {
  const res = await fetch(`${base}/api/signals${query}`, { headers: { authorization: `Bearer ${SERVICE_TOKEN}` } });
  assert.equal(res.status, 200);
  return (await res.json()) as TokenSignal[];
}

/** The default (flag off) view: gate-failing value hidden, gate-dropped row absent, passer shown. */
function assertHidden(rows: TokenSignal[]): void {
  const fail = rows.find((r) => r.ca === CA_FAIL);
  assert.ok(fail, 'CA_FAIL clears minUsd/MC gates, so its row is listed even with the flag off');
  assert.equal(fail.nansen.fresh, undefined, 'a gate-FAILING factor value must be hidden');
  assert.equal(fail.nansen.pass.fresh, false);
  const pass = rows.find((r) => r.ca === CA_PASS);
  assert.ok(pass);
  assert.equal(pass.nansen.fresh, 50, 'a gate-PASSING factor value is always shown');
  assert.ok(!rows.some((r) => r.ca === CA_CHEAP), 'row below minUsd must be hidden');
}

before(async () => {
  open(':memory:');
  updateThresholds(thresholdDefaults());
  insertTrackedCa({ address: CA_FAIL, chain: 'sol', note: '', entryUsd: 60 });
  insertTrackedCa({ address: CA_PASS, chain: 'sol', note: '', entryUsd: 60 });
  // entryUsd 10 < minUsd default 50 → the display gate drops this row unless allFactors=1.
  insertTrackedCa({ address: CA_CHEAP, chain: 'sol', note: '', entryUsd: 10 });
  // fresh 1% < freshMinPct default 10 → value exists but FAILS the gate.
  updateTokenMetrics(CA_FAIL, 'sol', { nansenFreshPct: 1 });
  updateTokenMetrics(CA_PASS, 'sol', { nansenFreshPct: 50 });
  server = createApp('test', { serviceToken: SERVICE_TOKEN }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

test('(a) GET /api/signals without the param hides the gate-failing factor value', async () => {
  assertHidden(await getSignals(''));
});

test('(b) ?allFactors=1 reveals the failing value AND lists every tracked CA (minUsd/MC gates skipped)', async () => {
  const rows = await getSignals('?allFactors=1');
  const fail = rows.find((r) => r.ca === CA_FAIL);
  assert.ok(fail);
  assert.equal(fail.nansen.fresh, 1, 'the gate-failing value must be revealed');
  assert.equal(fail.nansen.pass.fresh, false, 'the gate result itself is unchanged');
  const cas = rows.map((r) => r.ca);
  assert.ok(cas.includes(CA_PASS));
  assert.ok(cas.includes(CA_CHEAP), 'the row below minUsd must be listed with the flag on');
});

test('(c) ?allFactors=0 behaves exactly like no param', async () => {
  assertHidden(await getSignals('?allFactors=0'));
});

test('(d) the flag is per-request: the very next request without it is unaffected, nothing persisted', async () => {
  const on = await getSignals('?allFactors=1');
  assert.ok(on.some((r) => r.ca === CA_CHEAP));
  assertHidden(await getSignals(''));
  assert.equal(getDebugAllFactors(), false, 'the query param must never write the server-side setting');
});
