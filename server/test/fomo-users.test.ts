// Task 5 (.omo/plans/fomo-user-watch.md): /api/fomo-users CRUD + CSV import.
// Mirrors the wallet-route contract: bare {error:'...'} bodies, 201+row on POST,
// 409 duplicate handle, 204 delete (FK cascade), 404 missing id on PATCH, and the
// camelCase FomoUser DTO (never the snake_case db row).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getDb, insertFomoTrade, insertFomoUser, open } from '../src/db.js';
import { createApp } from '../src/api.js';
import { createTestAuth, type TestAuth } from './auth-testkit.js';

let auth: TestAuth;
let server: Server;
let base = '';
let admin = '';

interface Reply {
  status: number;
  json: any;
}

async function req(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<Reply> {
  const headers: Record<string, string> = {};
  const token = opts.token ?? admin;
  if (token) headers.authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, json: text === '' ? null : JSON.parse(text) };
}

const countUsers = (): number =>
  (getDb().prepare('SELECT COUNT(*) AS n FROM fomo_users').get() as { n: number }).n;

const rawRow = (handle: string): Record<string, unknown> | undefined =>
  getDb().prepare('SELECT * FROM fomo_users WHERE handle = ?').get(handle) as Record<string, unknown> | undefined;

before(async () => {
  open(':memory:');
  auth = await createTestAuth();
  admin = await auth.signToken(auth.adminEmail);
  server = createApp('test', auth.deps).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

test('POST /api/fomo-users: creates and returns the camelCase DTO row', async () => {
  const res = await req('POST', '/api/fomo-users', {
    body: { handle: '@alice', name: 'Alice', clan: 'a', userId: 'u-1', walletSolana: 'SolAddr', walletEvm: '0xEvm', source: 'seed' },
  });
  assert.equal(res.status, 201);
  assert.equal(typeof res.json.id, 'string');
  assert.deepEqual(res.json, {
    id: res.json.id,
    handle: '@alice',
    name: 'Alice',
    clan: 'a',
    userId: 'u-1',
    walletSolana: 'SolAddr',
    walletEvm: '0xEvm',
    source: 'seed',
  });
  for (const key of ['user_id', 'wallet_solana', 'wallet_evm', 'created_at']) {
    assert.ok(!(key in res.json), `snake_case key ${key} must not leak`);
  }
});

test('POST /api/fomo-users: minimal body defaults name="" / source="manual" and omits unset optionals', async () => {
  const res = await req('POST', '/api/fomo-users', { body: { handle: '@min' } });
  assert.equal(res.status, 201);
  assert.deepEqual(res.json, { id: res.json.id, handle: '@min', name: '', source: 'manual' });
});

test('POST /api/fomo-users: duplicate handle is 409', async () => {
  const res = await req('POST', '/api/fomo-users', { body: { handle: '@alice', name: 'Impostor' } });
  assert.equal(res.status, 409);
  assert.deepEqual(res.json, { error: 'fomo user handle already exists' });
  assert.equal(rawRow('@alice')?.name, 'Alice');
});

test('POST /api/fomo-users: empty handle is 400 (not 500, not a silent insert)', async () => {
  const before = countUsers();
  for (const handle of ['', '   ']) {
    const res = await req('POST', '/api/fomo-users', { body: { handle, name: 'Ghost' } });
    assert.equal(res.status, 400);
    assert.deepEqual(res.json, { error: 'handle is required' });
  }
  assert.equal(countUsers(), before, 'no row was inserted');
});

test('POST /api/fomo-users: unknown extra fields are ignored, never persisted', async () => {
  const res = await req('POST', '/api/fomo-users', { body: { handle: '@extra', name: 'E', bogus: 'nope', tags: ['x'] } });
  assert.equal(res.status, 201);
  assert.ok(!('bogus' in res.json));
  assert.ok(!('tags' in res.json));
  const row = rawRow('@extra');
  assert.ok(row);
  assert.ok(!('bogus' in row));
  assert.deepEqual(Object.keys(row).sort(), [
    'clan', 'created_at', 'handle', 'id', 'name', 'source', 'user_id', 'wallet_evm', 'wallet_solana',
  ]);
});

test('GET /api/fomo-users: lists every user sorted by name', async () => {
  await req('POST', '/api/fomo-users', { body: { handle: '@zoe', name: 'Zoe' } });
  const res = await req('GET', '/api/fomo-users');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json));
  const names = res.json.map((u: { name: string }) => u.name);
  assert.deepEqual(names, names.slice().sort((a, b) => a.localeCompare(b)));
  assert.ok(names.includes('Alice') && names.includes('Zoe'));
});

test('PATCH /api/fomo-users/:id: updates user_id/name/clan and returns the DTO', async () => {
  const created = await req('POST', '/api/fomo-users', { body: { handle: '@patch', name: 'Before' } });
  const id = created.json.id as string;
  const res = await req('PATCH', `/api/fomo-users/${id}`, { body: { userId: 'u-2', name: 'After', clan: 'b' } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { id, handle: '@patch', name: 'After', clan: 'b', userId: 'u-2', source: 'manual' });
  const row = rawRow('@patch');
  assert.equal(row?.user_id, 'u-2');
  assert.equal(row?.name, 'After');
  assert.equal(row?.clan, 'b');
});

test('PATCH /api/fomo-users/:id: missing id is 404, handle collision is 409, empty handle is 400', async () => {
  const missing = await req('PATCH', '/api/fomo-users/no-such-id', { body: { name: 'x' } });
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.json, { error: 'not found' });

  const created = await req('POST', '/api/fomo-users', { body: { handle: '@collide', name: 'C' } });
  const clash = await req('PATCH', `/api/fomo-users/${created.json.id}`, { body: { handle: '@alice' } });
  assert.equal(clash.status, 409);

  const empty = await req('PATCH', `/api/fomo-users/${created.json.id}`, { body: { handle: '  ' } });
  assert.equal(empty.status, 400);
});

test('DELETE /api/fomo-users/:id: 204, GET omits it, FK cascade cleans fomo_trades', async () => {
  const created = await req('POST', '/api/fomo-users', { body: { handle: '@gone', name: 'Gone' } });
  const id = created.json.id as string;
  insertFomoTrade({ fomo_user_id: id, event_id: 'evt-cascade', ca: 'CaSc1', chain: 'sol', type: 'buy', ts: 1 });

  const del = await req('DELETE', `/api/fomo-users/${id}`);
  assert.equal(del.status, 204);
  assert.equal(del.json, null);

  const list = await req('GET', '/api/fomo-users');
  assert.ok(!list.json.some((u: { id: string }) => u.id === id));
  const trades = getDb().prepare('SELECT COUNT(*) AS n FROM fomo_trades WHERE fomo_user_id = ?').get(id) as { n: number };
  assert.equal(trades.n, 0, 'fomo_trades row was cascade-deleted');
});

test('POST /api/fomo-users/import: one valid + one empty-handle row -> added=1, skipped carries a reason, source stamped csv', async () => {
  const res = await req('POST', '/api/fomo-users/import', {
    body: { rows: [{ handle: '@imp', name: 'Imp' }, { handle: '', name: 'Blank' }] },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { added: 1, updated: 0, skipped: [{ row: 1, reason: 'handle is empty' }] });
  assert.equal(rawRow('@imp')?.source, 'csv');
});

test('POST /api/fomo-users/import: caller-supplied source wins over the csv stamp', async () => {
  const res = await req('POST', '/api/fomo-users/import', { body: { rows: [{ handle: '@imp2', source: 'seed' }] } });
  assert.equal(res.status, 200);
  assert.equal(res.json.added, 1);
  assert.equal(rawRow('@imp2')?.source, 'seed');
});

test('POST /api/fomo-users/import: re-import enriches an existing handle (upsert, no blanking)', async () => {
  const res = await req('POST', '/api/fomo-users/import', { body: { rows: [{ handle: '@imp', userId: 'u-9' }] } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { added: 0, updated: 1, skipped: [] });
  const row = rawRow('@imp');
  assert.equal(row?.user_id, 'u-9');
  assert.equal(row?.name, 'Imp', 'empty incoming name did not blank the stored one');
});

test('POST /api/fomo-users/import: malformed body is 400', async () => {
  const res = await req('POST', '/api/fomo-users/import', { body: {} });
  assert.equal(res.status, 400);
  assert.deepEqual(res.json, { error: 'body must be { rows: [...] }' });
});

test('viewer token: 403 on POST /api/fomo-users', async () => {
  const res = await req('POST', '/api/fomo-users', { token: await auth.signToken(auth.viewerEmail), body: { handle: '@v' } });
  assert.equal(res.status, 403);
  assert.deepEqual(res.json, { error: 'forbidden' });
});

test('no token: 401 on POST /api/fomo-users', async () => {
  const res = await req('POST', '/api/fomo-users', { token: '', body: { handle: '@anon' } });
  assert.equal(res.status, 401);
  assert.deepEqual(res.json, { error: 'unauthorized' });
});

test('db accessor sanity: insertFomoUser rows stay independent of the routes', () => {
  const row = insertFomoUser({ handle: '@direct', name: 'Direct' });
  assert.equal(row.source, 'manual');
});
