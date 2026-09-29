# Server-side AuthN/AuthZ (AUTH CONTRACT v1) — verification evidence

Date: 2026-09-28 · Scope: `server/` only · Model agent: Sisyphus-Junior

## What shipped

- `server/src/auth.ts` (new): jose-based Firebase ID-token verification (public JWKS via
  `createRemoteJWKSet`, RS256, aud/iss/exp/iat/sub/email_verified gates), constant-time
  service-token match (`crypto.timingSafeEqual` + length guard), `ROUTE_POLICY` deny-by-default
  gate table (15 entries), injectable `AuthDeps` (jwks getter / roles / projectId / serviceToken).
- `server/src/config.ts` L152-163: `firebaseProjectId`, `authUserRoles`, `serviceToken` — all
  default `''` = FAIL CLOSED (no allow-by-default path; empty roles ⇒ empty map ⇒ nobody).
- `server/src/api.ts`: import L9; `createApp(providerName, authDeps?)` L283; middleware
  `app.use(createAuthMiddleware(authDeps))` L296-299 (after request logger, before /api/health);
  `GET /api/me` L314-325. Handlers untouched.
- `server/test/auth.test.ts` (new, 26 tests): real RS256 tokens via local JWKS — admin/viewer/
  service matrix, 401 shapes (missing/malformed/garbage/wrong-aud/expired/future-iat/unverified-
  email), 403 shapes (viewer→PUT tier, service→admin writes, no-role email), trailing-slash +
  unknown-route deny, fail-closed legs (empty roles / unset project id / unset service token),
  unit tests for parseUserRoles / matchServiceToken / resolveRouteAccess.
- `server/test/auth-routes.test.ts` (new, 4 tests): walks `app._router.stack`, asserts every
  registered route ∈ ROUTE_POLICY (both directions), `/api/health` explicitly public, nothing
  else public.
- `server/test/auth-testkit.ts` (new, helper — not a test file): signs real Firebase-shaped
  RS256 ID tokens against `createLocalJWKSet`.
- `server/.env.example` L106-120: FIREBASE_PROJECT_ID / AUTH_USER_ROLES (format documented) /
  SERVICE_TOKEN — no real secrets.
- `server/package.json` + `package-lock.json`: `jose@^6.2.12` (npm ci safe).
- 7 existing HTTP tests fixed to authenticate properly (NO bypass/flag):
  - service token via createApp deps: `min-usd-gate`, `wallet-watch-trade`,
    `signals-allfactors-param`; via env-before-import (that file's existing pattern):
    `setup-http-e2e`.
  - real admin ID token via testkit: `tier`, `settings-debug`, `wallet-chain-key`.

## Command evidence

### 1. Typecheck

```
$ cd server && npx tsc --noEmit
tsc exit: 0
```

### 2. Full test suite (baseline before change: 320 pass / 0 fail)

```
$ cd server && npm test
ℹ tests 350
ℹ suites 0
ℹ pass 350
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ duration_ms 29183.864453
```

350 = 320 baseline + 26 (auth.test.ts) + 4 (auth-routes.test.ts).

### 3. New-test detail (all ✔)

```
$ npx tsx --test test/auth.test.ts test/auth-routes.test.ts
✔ every registered route appears in ROUTE_POLICY (an ungated route fails here)
✔ ROUTE_POLICY has no stale entries (every entry is a registered route)
✔ GET /api/health is explicitly public in the policy table
✔ no other route is public
✔ GET /api/me: a valid admin ID token → 200 {email, role:"admin"}
✔ GET /api/me: the service token → 200 {email:null, role:"service"}
✔ GET /api/health: always public — 200 with NO Authorization header
✔ viewer token: 403 on PUT /api/tier but 200 on GET /api/signals
✔ admin token passes the same gate the viewer was 403 on (handler reached → 404)
✔ no Authorization header → 401 {error:"unauthorized"}
✔ malformed Authorization headers → 401
✔ garbage Bearer token → 401
✔ wrong-audience token → 401
✔ expired token → 401
✔ future-iat token → 401 (iat sanity guard)
✔ unverified email claim → 401
✔ valid token for an email with NO role → 403 (authenticated, not authorized)
✔ role emails are matched case-insensitively
✔ service token: allowed on POST /api/tracked-cas (201)
✔ service token: allowed on POST /api/wallet-watch/trades (200 inserted)
✔ service token: allowed on the read-only GETs (/api/wallets, /api/settings)
✔ service token: 403 on admin-only writes — PUT /api/tier, DELETE /api/wallets/:id and friends
✔ a route outside the policy table is refused: 401 anonymous, 403 authenticated
✔ trailing slash does not dodge the gate (PUT /api/tier/ as viewer → 403)
✔ fail closed: empty AUTH_USER_ROLES → even a valid admin token is refused
✔ fail closed: unset FIREBASE_PROJECT_ID → browser tokens rejected, service unaffected
✔ fail closed: unset SERVICE_TOKEN → the service path is disabled (401)
✔ parseUserRoles: trims, lowercases, ignores junk, never assigns service, last wins
✔ matchServiceToken: constant-time compare, unset token disables the path
✔ resolveRouteAccess: table hits, param paths, trailing slash, HEAD-as-GET, misses
ℹ tests 30 / pass 30 / fail 0
```

### 4. Red-Green proof: the regression gate catches an ungated route

In-memory simulation (no file touched) — register a rogue route, run the same walk
auth-routes.test.ts uses:

```
$ npx tsx -e "... app.get('/api/rogue-ungated', ...); walk router.stack vs ROUTE_POLICY ..."
ungated detected: ["GET /api/rogue-ungated"]
RED-GREEN OK: the auth-routes walk catches an ungated route
```

### 5. Lockfile (Dockerfile `npm ci` safe)

```
package.json:15:    "jose": "^6.2.12",
package-lock.json:13:        "jose": "^6.2.12",
```

## Constraint compliance

- No firebase-admin, no service-account key anywhere — public JWKS only.
- No `console.*`, no `as any`, no `@ts-ignore` in new/edited files (grep clean; the
  `as unknown as { _router?: RouterLike }` walk in auth-routes.test.ts is a typed structural
  cast, matching the repo's existing `as AddressInfo` test style).
- `GET /api/health` untouched; commented-out token-detail routes untouched; `src/` (frontend)
  and `watchers/` untouched; nothing deployed/committed/docker-run.
- No zod; boundary style matches existing hand-rolled parsing.
- Fail closed verified by tests: empty AUTH_USER_ROLES ⇒ 403 on a valid admin token;
  unset FIREBASE_PROJECT_ID ⇒ 401; unset SERVICE_TOKEN ⇒ service path 401; unlisted route ⇒ deny.
