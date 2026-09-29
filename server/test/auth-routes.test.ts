// Regression gate for deny-by-default auth: EVERY route registered on the real
// app must appear in ROUTE_POLICY (src/auth.ts), and the table must hold no
// stale entries. If this file fails, someone added a route without making an
// explicit gating decision — list it in ROUTE_POLICY with its roles. Also pins
// GET /api/health as explicitly public (monitors depend on it), and pins the
// FOMO gate matrix (task 2 of .omo/plans/fomo-user-watch.md). All six FOMO
// routes are now registered (tasks 5+6), so PENDING_ROUTES is empty and the
// stale-entry check runs at full strength.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { insertFomoUser, open } from '../src/db.js';
import { createApp } from '../src/api.js';
import { resolveRouteAccess, ROUTE_POLICY } from '../src/auth.js';
import { createTestAuth, TEST_SERVICE_TOKEN, type TestAuth } from './auth-testkit.js';

interface RouteLayer {
  path: string;
  methods: Record<string, unknown>;
}
interface RouterLike {
  stack: ReadonlyArray<{ route?: RouteLayer }>;
}

/** Express 4 keeps registered routes on `app._router.stack` (middleware layers
 * — json, logger, auth, 404, error — carry no `.route` and are skipped). */
function registeredRoutes(): Array<{ method: string; path: string }> {
  const app = createApp('policy-audit') as unknown as { _router?: RouterLike };
  assert.ok(app._router, 'Express 4 app must expose _router — update this walk if Express is upgraded');
  const out: Array<{ method: string; path: string }> = [];
  for (const layer of app._router.stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      out.push({ method: method.toUpperCase(), path: layer.route.path });
    }
  }
  return out;
}

const key = (method: string, path: string): string => `${method} ${path}`;

/** ROUTE_POLICY entries whose express routes do not exist YET (gated-ahead-of-
 *  registration, so deny-by-default never has a gap between "route lands" and
 *  "gate lands"). Empty since task 6 registered POST /api/fomo-watch/trades —
 *  the self-cleaning test below keeps the mechanism honest for any future
 *  entry: it FAILS the moment a listed route becomes registered. */
const PENDING_ROUTES: ReadonlySet<string> = new Set();

test('every registered route appears in ROUTE_POLICY (an ungated route fails here)', () => {
  const routes = registeredRoutes();
  assert.ok(
    routes.length >= ROUTE_POLICY.length - PENDING_ROUTES.size,
    `router walk found only ${routes.length} routes — walk broken?`,
  );
  const policy = new Set(ROUTE_POLICY.map((e) => key(e.method, e.path)));
  for (const r of routes) {
    assert.ok(policy.has(key(r.method, r.path)), `UNGATED ROUTE: ${key(r.method, r.path)} is missing from ROUTE_POLICY`);
  }
});

test('ROUTE_POLICY has no stale entries (every entry is a registered route)', () => {
  const routes = new Set(registeredRoutes().map((r) => key(r.method, r.path)));
  for (const e of ROUTE_POLICY) {
    const k = key(e.method, e.path);
    if (PENDING_ROUTES.has(k)) continue; // gated ahead of registration — see PENDING_ROUTES
    assert.ok(routes.has(k), `STALE policy entry: ${k} is not registered`);
  }
});

test('PENDING_ROUTES are still awaiting registration (remove each one here the moment its route lands)', () => {
  const routes = new Set(registeredRoutes().map((r) => key(r.method, r.path)));
  for (const k of PENDING_ROUTES) {
    assert.ok(!routes.has(k), `${k} is now registered — REMOVE it from PENDING_ROUTES in this file (task 5/6)`);
  }
});

test('GET /api/health is explicitly public in the policy table', () => {
  const health = ROUTE_POLICY.find((e) => e.method === 'GET' && e.path === '/api/health');
  assert.ok(health, '/api/health must be listed');
  assert.equal(health.access, 'public');
});

test('no other route is public', () => {
  for (const e of ROUTE_POLICY) {
    if (e.path === '/api/health') continue;
    assert.notEqual(e.access, 'public', `${key(e.method, e.path)} must require a role`);
  }
});

// --- FOMO gate matrix (task 2) ------------------------------------------------
// Auth runs in the middleware, BEFORE route resolution, so 401 (anonymous) and
// 403 (wrong role) are exact and route-independent TODAY. All six routes are
// registered (tasks 5+6), so gate-PASS outcomes are asserted as real 2xx.

let auth: TestAuth;
let server: Server;
let base = '';

before(async () => {
  open(':memory:');
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

async function req(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, json: text === '' ? null : (JSON.parse(text) as unknown) };
}

/** Concrete request targets for the six gated routes (`:id` filled). */
const FOMO_ROUTES: ReadonlyArray<readonly [method: string, path: string]> = [
  ['GET', '/api/fomo-users'],
  ['POST', '/api/fomo-users'],
  ['PATCH', '/api/fomo-users/some-id'],
  ['DELETE', '/api/fomo-users/some-id'],
  ['POST', '/api/fomo-users/import'],
  ['POST', '/api/fomo-watch/trades'],
];

/** The four ADMIN_ONLY fomo-users writes the viewer/service roles must never reach. */
const FOMO_ADMIN_WRITES: ReadonlyArray<readonly [method: string, path: string]> = [
  ['POST', '/api/fomo-users'],
  ['PATCH', '/api/fomo-users/some-id'],
  ['DELETE', '/api/fomo-users/some-id'],
  ['POST', '/api/fomo-users/import'],
];

/** A body shaped for the task-6 parser contract (captured FOMO schema). */
const FOMO_TRADE_BODY = {
  eventId: 'evt-auth-routes-1',
  trader: 'authkit-handle',
  type: 'buy',
  tokenAddress: 'authCa-fomo-001',
  chain: 'sol',
  ts: 1_758_000_000_000,
  usdValue: 3000,
};

test('resolveRouteAccess pins all six fomo gates to their exact roles', () => {
  assert.deepEqual(resolveRouteAccess('GET', '/api/fomo-users'), ['admin', 'viewer', 'service']);
  assert.deepEqual(resolveRouteAccess('POST', '/api/fomo-users'), ['admin']);
  assert.deepEqual(resolveRouteAccess('PATCH', '/api/fomo-users/some-id'), ['admin']);
  assert.deepEqual(resolveRouteAccess('DELETE', '/api/fomo-users/some-id'), ['admin']);
  assert.deepEqual(resolveRouteAccess('POST', '/api/fomo-users/import'), ['admin']);
  assert.deepEqual(resolveRouteAccess('POST', '/api/fomo-watch/trades'), ['admin', 'service']);
});

test('anonymous request: 401 on all six fomo routes', async () => {
  for (const [method, path] of FOMO_ROUTES) {
    const body = method === 'GET' || method === 'DELETE' ? undefined : {};
    const res = await req(method, path, { body });
    assert.equal(res.status, 401, `anonymous ${method} ${path} must be 401`);
    assert.deepEqual(res.json, { error: 'unauthorized' });
  }
});

test('viewer token: 403 on the admin-only fomo writes', async () => {
  const viewer = await auth.signToken(auth.viewerEmail);
  for (const [method, path] of FOMO_ADMIN_WRITES) {
    const res = await req(method, path, { token: viewer, body: {} });
    assert.equal(res.status, 403, `viewer ${method} ${path} must be 403`);
    assert.deepEqual(res.json, { error: 'forbidden' });
  }
});

test('service token: 403 on the admin-only fomo writes (least privilege)', async () => {
  for (const [method, path] of FOMO_ADMIN_WRITES) {
    const res = await req(method, path, { token: TEST_SERVICE_TOKEN, body: {} });
    assert.equal(res.status, 403, `service ${method} ${path} must be 403`);
    assert.deepEqual(res.json, { error: 'forbidden' });
  }
});

test('viewer token passes the GET /api/fomo-users gate', async () => {
  const res = await req('GET', '/api/fomo-users', { token: await auth.signToken(auth.viewerEmail) });
  // Task 5 registered the route: a gate pass is now the real 200 + JSON list.
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json));
});

test('service token passes the POST /api/fomo-watch/trades gate (valid body)', async () => {
  // Task 6 registered the route: the gate pass is now the real 200 + insert.
  // The body's trader must be tracked or the handler 404s before inserting.
  // Removing the policy entry makes deny-by-default kick in → 403 → this fails.
  insertFomoUser({ handle: FOMO_TRADE_BODY.trader, name: 'Authkit Handle' });
  const res = await req('POST', '/api/fomo-watch/trades', { token: TEST_SERVICE_TOKEN, body: FOMO_TRADE_BODY });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { inserted: 1 });
});
