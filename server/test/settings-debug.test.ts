import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { getSetting, open } from '../src/db.js';
import { DEBUG_ALL_FACTORS_KEY, getDebugAllFactors, getThresholds, setDebugAllFactors } from '../src/settings.js';
import { createApp } from '../src/api.js';

const JSON_HEADERS = { 'content-type': 'application/json' };

let server: Server;
let base = '';

async function put(body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

before(async () => {
  open(':memory:');
  setDebugAllFactors(false); // normalize: don't depend on leftover persisted state
  server = createApp('test').listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

test('GET /api/settings exposes debug.allFactors=false by default, alongside values+defaults', async () => {
  const res = await fetch(`${base}/api/settings`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body.debug), ['allFactors']);
  assert.equal(body.debug.allFactors, false);
  for (const k of ['freshMinPct', 't100MinMultiple', 'lfMin', 'lfMax', 'minUsd']) {
    assert.equal(typeof body.values[k], 'number');
    assert.equal(typeof body.defaults[k], 'number');
  }
});

test('PUT allFactors=true persists and round-trips through GET', async () => {
  const putRes = await put({ allFactors: true });
  assert.equal(putRes.status, 200);
  assert.equal(putRes.json.debug.allFactors, true);

  const get = await fetch(`${base}/api/settings`);
  const getBody = await get.json();
  assert.equal(getBody.debug.allFactors, true);
  assert.equal(getDebugAllFactors(), true); // persistence-layer truth, read-per-call → no restart needed

  setDebugAllFactors(false);
});

test('PUT with only numeric keys leaves allFactors unchanged', async () => {
  const origFresh = getThresholds().freshMinPct;
  setDebugAllFactors(true);
  const res = await put({ freshMinPct: 12 });
  assert.equal(res.status, 200);
  assert.equal(res.json.values.freshMinPct, 12);
  assert.equal(res.json.debug.allFactors, true); // numeric-only PUT must not touch the debug flag
  await put({ freshMinPct: origFresh });
  setDebugAllFactors(false);
});

test('PUT with only allFactors leaves numeric thresholds unchanged', async () => {
  const valuesBefore = getThresholds();
  const res = await put({ allFactors: true });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.values, valuesBefore); // no numeric drift
  setDebugAllFactors(false);
});

test('PUT rejects a non-boolean allFactors with 400 { error }', async () => {
  for (const bad of ['true', 'false', 1, 0, '1', null, [true], {}]) {
    const res = await put({ allFactors: bad });
    assert.equal(res.status, 400, `allFactors=${JSON.stringify(bad)} must be rejected`);
    assert.equal(typeof res.json.error, 'string');
  }
  assert.equal(getDebugAllFactors(), false); // rejected writes change nothing
});

test('PUT rejects the retired t100MinPct / lfMaxPct keys with 400', async () => {
  for (const bad of [{ t100MinPct: 5 }, { lfMaxPct: 30 }, { freshMinPct: 12, t100MinPct: 5 }]) {
    const res = await put(bad);
    assert.equal(res.status, 400, `${JSON.stringify(bad)} must be rejected`);
    assert.equal(typeof res.json.error, 'string');
  }
  const res = await fetch(`${base}/api/settings`);
  const body = await res.json();
  assert.equal(body.values.t100MinPct, undefined); // retired keys never come back
  assert.equal(body.values.lfMaxPct, undefined);
});

test('PUT applies allFactors alongside numeric keys in one request', async () => {
  const origT100 = getThresholds().t100MinMultiple;
  const res = await put({ allFactors: false, t100MinMultiple: 1.4 });
  assert.equal(res.status, 200);
  assert.equal(res.json.debug.allFactors, false);
  assert.equal(res.json.values.t100MinMultiple, 1.4);
  await put({ t100MinMultiple: origT100 });
});

test('allFactors persists in the settings table as the string 1/0 getDebugAllFactors reads', async () => {
  setDebugAllFactors(true);
  assert.equal(getSetting(DEBUG_ALL_FACTORS_KEY), '1');
  assert.equal(getDebugAllFactors(), true);
  setDebugAllFactors(false);
  assert.equal(getSetting(DEBUG_ALL_FACTORS_KEY), '0');
  assert.equal(getDebugAllFactors(), false);
});
