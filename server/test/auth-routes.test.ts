// Regression gate for deny-by-default auth: EVERY route registered on the real
// app must appear in ROUTE_POLICY (src/auth.ts), and the table must hold no
// stale entries. If this file fails, someone added a route without making an
// explicit gating decision — list it in ROUTE_POLICY with its roles. Also pins
// GET /api/health as explicitly public (monitors depend on it), and pins the
// FOMO gate matrix (task 2 of .omo/plans/fomo-user-watch.md). The five
// /api/fomo-users routes landed in task 5; only POST /api/fomo-watch/trades is
// still gated-ahead-of-registration (task 6), so it sits on PENDING_ROUTES
// until it lands (see the self-cleaning rule below).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { open } from '../src/db.js';
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

/** ROUTE_POLICY entries whose express routes do not exist YET: task 6 registers
 * POST /api/fomo-watch/trades (.omo/plans/fomo-user-watch.md). Gating it now is
 * the point (deny-by-default must never have a gap between "route lands" and
 * "gate lands"); it is exempt from the stale-entry check only until registered —
 * the test below FAILS the moment it lands, forcing its removal here, so the
 * list shrinks to empty by the end of wave 2 and the stale check regains full
 * strength. */
const PENDING_ROUTES: ReadonlySet<string> = new Set([
  'POST /api/fomo-watch/trades',
]);

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
    if (PENDING_ROUTES.has(k)) continue; // route lands in task 5/6 — see PENDING_ROUTES
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
// 403 (wrong role) are exact and route-independent TODAY. Gate-PASS outcomes are
// asserted as real 2xx for the routes task 5 registered; the still-unregistered
// POST /api/fomo-watch/trades is asserted as "not refused" (an authorized
// request to an unregistered route 404s at the catch-all) and carries a TODO
// naming task 6, which tightens it to the real 2xx.

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

/** A body shaped for task 6's parser contract (captured FOMO schema), so this
 * request stays valid once the route exists. */
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
  const res = await req('POST', '/api/fomo-watch/trades', { token: TEST_SERVICE_TOKEN, body: FOMO_TRADE_BODY });
  // TODO(task 6): tighten to a 2xx assertion once POST /api/fomo-watch/trades is
  // registered (an untracked-trader 404 from the handler is also a gate pass).
  // Removing the policy entry makes deny-by-default kick in → 403 → this fails.
  assert.ok(res.status !== 401 && res.status !== 403, `service token must pass the gate, got ${res.status}`);
});
