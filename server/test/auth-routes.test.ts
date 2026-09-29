// Regression gate for deny-by-default auth: EVERY route registered on the real
// app must appear in ROUTE_POLICY (src/auth.ts), and the table must hold no
// stale entries. If this file fails, someone added a route without making an
// explicit gating decision — list it in ROUTE_POLICY with its roles. Also pins
// GET /api/health as explicitly public (monitors depend on it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/api.js';
import { ROUTE_POLICY } from '../src/auth.js';

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

test('every registered route appears in ROUTE_POLICY (an ungated route fails here)', () => {
  const routes = registeredRoutes();
  assert.ok(routes.length >= ROUTE_POLICY.length, `router walk found only ${routes.length} routes — walk broken?`);
  const policy = new Set(ROUTE_POLICY.map((e) => key(e.method, e.path)));
  for (const r of routes) {
    assert.ok(policy.has(key(r.method, r.path)), `UNGATED ROUTE: ${key(r.method, r.path)} is missing from ROUTE_POLICY`);
  }
});

test('ROUTE_POLICY has no stale entries (every entry is a registered route)', () => {
  const routes = new Set(registeredRoutes().map((r) => key(r.method, r.path)));
  for (const e of ROUTE_POLICY) {
    assert.ok(routes.has(key(e.method, e.path)), `STALE policy entry: ${key(e.method, e.path)} is not registered`);
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
