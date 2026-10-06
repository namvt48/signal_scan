import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/api.js';
import { findTrackedCa, insertTrackedCa, open } from '../src/db.js';
import { createTestAuth } from './auth-testkit.js';
import { assembleSignals } from '../src/signals.js';

let server: Server;
let base = '';
let admin = '';
let viewer = '';
let service = '';
before(async () => {
  open(':memory:');
  insertTrackedCa({ address: 'note-ca', chain: 'sol', note: '' });
  insertTrackedCa({ address: 'note-ca', chain: 'base', note: 'other chain' });
  const auth = await createTestAuth();
  admin = await auth.bearer(auth.adminEmail);
  viewer = await auth.bearer(auth.viewerEmail);
  service = `Bearer ${auth.serviceToken}`;
  server = createApp('test', auth.deps).listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());
async function put(body: unknown, token = admin, chain = 'sol', ca = 'note-ca'): Promise<Response> {
  return fetch(`${base}/api/tokens/${chain}/${ca}/note`, { method: 'PUT', headers: { authorization: token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
test('admin note saves exact text and clearing preserves other chain', async () => {
  const note = '  why buy\nwhy avoid  ';
  assert.equal((await put({ note })).status, 200);
  assert.equal(findTrackedCa('note-ca', 'sol')?.user_note, note);
  assert.equal(findTrackedCa('note-ca', 'base')?.note, 'other chain');
  assert.equal((await put({ note: '' })).status, 200);
  assert.equal(findTrackedCa('note-ca', 'sol')?.user_note, '');
});
test('note validation rejects invalid payloads and unknown identities', async () => {
  for (const body of [null, [], {}, { note: 42 }, { note: 'x', extra: true }, { note: 'x'.repeat(2001) }]) assert.equal((await put(body)).status, 400);
  assert.equal((await put({ note: 'x' }, admin, 'invalid')).status, 400);
  assert.equal((await put({ note: 'x' }, admin, 'sol', 'missing')).status, 404);
});
test('viewer and service can read saved notes but cannot edit or clear them', async () => {
  const note = 'Admin saved\nRead-only context';
  assert.equal((await put({ note })).status, 200);
  for (const token of [viewer, service]) {
    const res = await fetch(`${base}/api/signals?allFactors=1`, { headers: { authorization: token } });
    assert.equal(res.status, 200);
    const rows = await res.json() as { ca: string; chain: string; note?: string }[];
    assert.equal(rows.find((row) => row.ca === 'note-ca' && row.chain === 'sol')?.note, note);
    assert.equal((await put({ note: 'denied' }, token)).status, 403);
    assert.equal((await put({ note: '' }, token)).status, 403);
    assert.equal(findTrackedCa('note-ca', 'sol')?.user_note, note);
  }
});

test('automatic tracking labels never prefill a new user note', () => {
  for (const label of ['wallet-trade', 'fomo']) {
    const ca = `empty-user-note-${label}`;
    insertTrackedCa({ address: ca, chain: 'sol', note: label });
    const signal = assembleSignals(Date.now(), true).find((s) => s.ca === ca);
    assert.ok(signal);
    assert.equal(signal.note ?? '', '');
    assert.equal(findTrackedCa(ca, 'sol')?.note, label, 'tracking provenance remains untouched');
  }
});
