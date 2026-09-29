// AUTH CONTRACT v1 (src/auth.ts) against the REAL createApp routes: real RS256
// tokens signed by auth-testkit and verified through an injected local JWKS —
// the production middleware path, no mocked role logic. Covers the gate matrix
// (admin/viewer/service), the 401/403 body shapes, and every fail-closed leg:
// empty AUTH_USER_ROLES, unset FIREBASE_PROJECT_ID, unset SERVICE_TOKEN.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { insertWallet, open } from '../src/db.js';
import { createApp } from '../src/api.js';
import { matchServiceToken, parseUserRoles, resolveRouteAccess, type AuthDeps } from '../src/auth.js';
import { createTestAuth, TEST_SERVICE_TOKEN, type TestAuth } from './auth-testkit.js';

const WALLET = 'auth-wallet-addr-1';

let auth: TestAuth;
let server: Server;
let base = '';

before(async () => {
  open(':memory:');
  insertWallet({ address: WALLET, name: 'AUTH', tags: [], chain: 'sol', source: 'test' });
  auth = await createTestAuth();
  server = createApp('test', auth.deps).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

interface Reply {
  status: number;
  json: unknown;
}

async function req(
  url: string,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${url}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, json: text === '' ? null : (JSON.parse(text) as unknown) };
}

const get = (path: string, token?: string): Promise<Reply> => req(base, 'GET', path, { token });

/** Boot a throwaway app with overridden deps (the fail-closed legs). */
async function withApp(deps: AuthDeps, fn: (url: string) => Promise<void>): Promise<void> {
  const srv = createApp('test', deps).listen(0);
  await new Promise((resolve) => srv.once('listening', resolve));
  try {
    await fn(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`);
  } finally {
    srv.close();
  }
}

// --- the gate matrix ---------------------------------------------------------

test('GET /api/me: a valid admin ID token → 200 {email, role:"admin"}', async () => {
  const res = await get('/api/me', await auth.signToken(auth.adminEmail));
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { email: auth.adminEmail, role: 'admin' });
});

test('GET /api/me: the service token → 200 {email:null, role:"service"}', async () => {
  const res = await get('/api/me', TEST_SERVICE_TOKEN);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { email: null, role: 'service' });
});

test('GET /api/health: always public — 200 with NO Authorization header', async () => {
  const res = await get('/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual((res.json as { healthy: boolean }).healthy, true);
});

test('viewer token: 403 on PUT /api/tier but 200 on GET /api/signals', async () => {
  const viewer = await auth.signToken(auth.viewerEmail);
  const put = await req(base, 'PUT', '/api/tier', { token: viewer, body: { ca: 'nope', chain: 'sol', tier: 'A' } });
  assert.equal(put.status, 403);
  assert.deepEqual(put.json, { error: 'forbidden' });
  const signals = await get('/api/signals', viewer);
  assert.equal(signals.status, 200);
});

test('admin token passes the same gate the viewer was 403 on (handler reached → 404)', async () => {
  const res = await req(base, 'PUT', '/api/tier', {
    token: await auth.signToken(auth.adminEmail),
    body: { ca: 'auth-untracked-ca', chain: 'sol', tier: 'A' },
  });
  assert.equal(res.status, 404, 'admin reached findTrackedCa — the gate let it through');
});

test('no Authorization header → 401 {error:"unauthorized"}', async () => {
  const res = await get('/api/signals');
  assert.equal(res.status, 401);
  assert.deepEqual(res.json, { error: 'unauthorized' });
});

test('malformed Authorization headers → 401', async () => {
  for (const raw of ['garbage', 'Bearer', 'Bearer ', 'Basic abc123', 'Bearer a b', 'bearer x']) {
    const res = await fetch(`${base}/api/signals`, { headers: { authorization: raw } });
    assert.equal(res.status, 401, `header "${raw}" must be refused`);
    assert.deepEqual(await res.json(), { error: 'unauthorized' });
  }
});

test('garbage Bearer token → 401', async () => {
  const res = await get('/api/me', 'not-a-jwt-at-all');
  assert.equal(res.status, 401);
  assert.deepEqual(res.json, { error: 'unauthorized' });
});

test('wrong-audience token → 401', async () => {
  const token = await auth.signToken(auth.adminEmail, { audience: 'some-other-project' });
  assert.equal((await get('/api/me', token)).status, 401);
});

test('expired token → 401', async () => {
  const now = Math.floor(Date.now() / 1000);
  const token = await auth.signToken(auth.adminEmail, {
    issuedAtSeconds: now - 7200,
    expiresInSeconds: now - 60,
  });
  assert.equal((await get('/api/me', token)).status, 401);
});

test('future-iat token → 401 (iat sanity guard)', async () => {
  const now = Math.floor(Date.now() / 1000);
  const token = await auth.signToken(auth.adminEmail, {
    issuedAtSeconds: now + 3600,
    expiresInSeconds: now + 7200,
  });
  assert.equal((await get('/api/me', token)).status, 401);
});

test('unverified email claim → 401', async () => {
  const token = await auth.signToken(auth.adminEmail, { emailVerified: false });
  assert.equal((await get('/api/me', token)).status, 401);
});

test('valid token for an email with NO role → 403 (authenticated, not authorized)', async () => {
  const token = await auth.signToken('stranger@testkit.local');
  const res = await get('/api/me', token);
  assert.equal(res.status, 403);
  assert.deepEqual(res.json, { error: 'forbidden' });
});

test('role emails are matched case-insensitively', async () => {
  const token = await auth.signToken(auth.adminEmail.toUpperCase());
  const res = await get('/api/me', token);
  assert.equal(res.status, 200);
  assert.deepEqual((res.json as { role: string }).role, 'admin');
});

// --- the service role: least privilege ---------------------------------------

test('service token: allowed on POST /api/tracked-cas (201)', async () => {
  const res = await req(base, 'POST', '/api/tracked-cas', {
    token: TEST_SERVICE_TOKEN,
    body: { address: 'authCa-svc-001', chain: 'sol' },
  });
  assert.equal(res.status, 201);
});

test('service token: allowed on POST /api/wallet-watch/trades (200 inserted)', async () => {
  const res = await req(base, 'POST', '/api/wallet-watch/trades', {
    token: TEST_SERVICE_TOKEN,
    body: { wallet: WALLET, ca: 'authCa-svc-001', tx: 'sig-auth-1', ts: 1_758_000_000_000, amountUsd: 100, price: 0.01 },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { inserted: 1 });
});

test('service token: allowed on the read-only GETs (/api/wallets, /api/settings)', async () => {
  assert.equal((await get('/api/wallets', TEST_SERVICE_TOKEN)).status, 200);
  assert.equal((await get('/api/settings', TEST_SERVICE_TOKEN)).status, 200);
});

test('service token: 403 on admin-only writes — PUT /api/tier, DELETE /api/wallets/:id and friends', async () => {
  const forbidden: Array<[string, string, unknown?]> = [
    ['PUT', '/api/tier', { ca: 'authCa-svc-001', chain: 'sol', tier: 'A' }],
    ['DELETE', '/api/wallets/any-id'],
    ['PUT', '/api/settings', {}],
    ['POST', '/api/wallets', { address: 'x', chain: 'sol' }],
    ['DELETE', '/api/tracked-cas/any-id'],
  ];
  for (const [method, path, body] of forbidden) {
    const res = await req(base, method, path, { token: TEST_SERVICE_TOKEN, body });
    assert.equal(res.status, 403, `${method} ${path} must refuse the service role`);
    assert.deepEqual(res.json, { error: 'forbidden' });
  }
});

// --- deny by default ----------------------------------------------------------

test('a route outside the policy table is refused: 401 anonymous, 403 authenticated', async () => {
  assert.equal((await get('/api/not-a-route')).status, 401);
  const admin = await get('/api/not-a-route', await auth.signToken(auth.adminEmail));
  assert.equal(admin.status, 403);
  assert.deepEqual(admin.json, { error: 'forbidden' });
});

test('trailing slash does not dodge the gate (PUT /api/tier/ as viewer → 403)', async () => {
  const res = await req(base, 'PUT', '/api/tier/', {
    token: await auth.signToken(auth.viewerEmail),
    body: { ca: 'nope', chain: 'sol', tier: 'A' },
  });
  assert.equal(res.status, 403);
});

// --- fail-closed legs ----------------------------------------------------------

test('fail closed: empty AUTH_USER_ROLES → even a valid admin token is refused', async () => {
  await withApp({ ...auth.deps, roles: parseUserRoles('') }, async (url) => {
    const token = await auth.signToken(auth.adminEmail);
    const me = await req(url, 'GET', '/api/me', { token });
    assert.equal(me.status, 403, 'a valid Firebase token without a listed role must NOT pass');
    assert.equal((await req(url, 'GET', '/api/signals', { token })).status, 403);
    // The service path is independent of the role map — the daemon still works.
    assert.equal((await req(url, 'GET', '/api/wallets', { token: TEST_SERVICE_TOKEN })).status, 200);
  });
});

test('fail closed: unset FIREBASE_PROJECT_ID → browser tokens rejected, service unaffected', async () => {
  await withApp({ ...auth.deps, firebaseProjectId: '' }, async (url) => {
    const token = await auth.signToken(auth.adminEmail);
    assert.equal((await req(url, 'GET', '/api/me', { token })).status, 401);
    assert.equal((await req(url, 'GET', '/api/wallets', { token: TEST_SERVICE_TOKEN })).status, 200);
  });
});

test('fail closed: unset SERVICE_TOKEN → the service path is disabled (401)', async () => {
  await withApp({ ...auth.deps, serviceToken: '' }, async (url) => {
    const res = await req(url, 'POST', '/api/tracked-cas', {
      token: TEST_SERVICE_TOKEN,
      body: { address: 'authCa-svc-002', chain: 'sol' },
    });
    assert.equal(res.status, 401);
    assert.deepEqual(res.json, { error: 'unauthorized' });
  });
});

// --- unit: the pure pieces ------------------------------------------------------

test('parseUserRoles: trims, lowercases, ignores junk, never assigns service, last wins', () => {
  const roles = parseUserRoles(' Admin@X.com : ADMIN , b@x.com:viewer , c@x.com:root , d@x.com , :admin, e@x.com:service , b@x.com:admin ');
  assert.deepEqual(
    [...roles.entries()].sort(),
    [
      ['admin@x.com', 'admin'],
      ['b@x.com', 'admin'],
    ],
    'root/service/roleless/empty-email entries are ignored; duplicate email → last wins',
  );
  assert.equal(parseUserRoles('').size, 0, 'empty env ⇒ empty map ⇒ nobody (fail closed)');
});

test('matchServiceToken: constant-time compare, unset token disables the path', () => {
  assert.equal(matchServiceToken(TEST_SERVICE_TOKEN, TEST_SERVICE_TOKEN), true);
  assert.equal(matchServiceToken(TEST_SERVICE_TOKEN.slice(0, -1), TEST_SERVICE_TOKEN), false);
  assert.equal(matchServiceToken(`${TEST_SERVICE_TOKEN}x`, TEST_SERVICE_TOKEN), false);
  assert.equal(matchServiceToken('a', ''), false, 'SERVICE_TOKEN unset ⇒ never matches');
  assert.equal(matchServiceToken('', ''), false, 'empty-vs-empty must NOT open the door');
});

test('resolveRouteAccess: table hits, param paths, trailing slash, HEAD-as-GET, misses', () => {
  assert.equal(resolveRouteAccess('GET', '/api/health'), 'public');
  assert.equal(resolveRouteAccess('HEAD', '/api/health'), 'public');
  assert.deepEqual(resolveRouteAccess('PUT', '/api/tier'), ['admin']);
  assert.deepEqual(resolveRouteAccess('POST', '/api/tracked-cas'), ['admin', 'service']);
  assert.deepEqual(resolveRouteAccess('DELETE', '/api/wallets/some-id/'), ['admin']);
  assert.equal(resolveRouteAccess('GET', '/api/wallets/some-id'), null, 'no GET /api/wallets/:id route exists');
  assert.equal(resolveRouteAccess('POST', '/api/health'), null, 'method matters');
  assert.equal(resolveRouteAccess('GET', '/api/unknown'), null, 'unlisted ⇒ null ⇒ deny');
});
