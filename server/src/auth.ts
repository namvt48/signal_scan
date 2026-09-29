// AUTH CONTRACT v1 — Bearer auth + role gating for every route except GET
// /api/health. Two token kinds: a Firebase Google ID token (browser users —
// verified against Firebase's PUBLIC JWKS via jose; there is deliberately NO
// service-account key on this server, so nothing privileged can leak from it)
// and the static SERVICE_TOKEN (wallet_watch daemon → role 'service').
//
// DENY BY DEFAULT: ROUTE_POLICY is the single gate table — a (method, path)
// missing from it is refused, so a route added later is CLOSED until it is
// listed. FAIL CLOSED on config, the opposite of the reference implementation's
// `if (ALLOWED_EMAILS.size === 0) return true` open-by-default bug:
//   FIREBASE_PROJECT_ID unset → browser tokens rejected;
//   AUTH_USER_ROLES empty     → nobody is admin/viewer;
//   SERVICE_TOKEN unset       → the service path is disabled ('' never matches).

import { timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { RequestHandler, Response } from 'express';
import { config } from './config.js';
import { log } from './log.js';

export type Role = 'admin' | 'viewer' | 'service';

export interface Principal {
  /** null for the service token — the daemon has no email identity. */
  email: string | null;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by the auth middleware once the Bearer token authenticated. */
      principal?: Principal;
    }
  }
}

/** A jose key resolver (createRemoteJWKSet / createLocalJWKSet both satisfy it). */
export type JwksResolver = JWTVerifyGetKey;

const FIREBASE_JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

/** Firebase's public JWKS, created once — jose caches the keys and follows rotation. */
let remoteJwks: JwksResolver | null = null;
function firebaseJwks(): JwksResolver {
  if (remoteJwks === null) remoteJwks = createRemoteJWKSet(new URL(FIREBASE_JWKS_URL));
  return remoteJwks;
}

export interface AuthDeps {
  /** JWKS getter — default: Firebase's remote set. Tests inject createLocalJWKSet. */
  jwks?: () => JwksResolver;
  /** lowercased email → role. Default: parseUserRoles(AUTH_USER_ROLES). */
  roles?: ReadonlyMap<string, Role>;
  /** Default: FIREBASE_PROJECT_ID. Empty → browser tokens rejected (fail closed). */
  firebaseProjectId?: string;
  /** Default: SERVICE_TOKEN. Empty → service path disabled (fail closed). */
  serviceToken?: string;
}

/** Roles assignable through AUTH_USER_ROLES — 'service' is NOT: it exists only
 * for SERVICE_TOKEN, so a typo in the env can never mint a daemon principal. */
const ASSIGNABLE_ROLES: readonly Role[] = ['admin', 'viewer'];

/** Parse AUTH_USER_ROLES ("a@b.com:admin, c@d.com:viewer"): emails trimmed +
 * lowercased, unknown role strings ignored, duplicate email → last wins. An
 * empty/unset string yields an EMPTY map — nobody is admin or viewer. */
export function parseUserRoles(raw: string): ReadonlyMap<string, Role> {
  const map = new Map<string, Role>();
  for (const entry of raw.split(',')) {
    const sep = entry.indexOf(':');
    if (sep <= 0) continue;
    const email = entry.slice(0, sep).trim().toLowerCase();
    const role = entry.slice(sep + 1).trim().toLowerCase();
    if (email === '' || !(ASSIGNABLE_ROLES as readonly string[]).includes(role)) continue;
    map.set(email, role as Role);
  }
  return map;
}

/** Constant-time service-token check. `expected === ''` (SERVICE_TOKEN unset)
 * disables the path outright — never let an empty provided token match. The
 * length guard is required: timingSafeEqual THROWS on unequal lengths. */
export function matchServiceToken(provided: string, expected: string): boolean {
  if (expected === '') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const ALL_ROLES: readonly Role[] = ['admin', 'viewer', 'service'];
const ADMIN_ONLY: readonly Role[] = ['admin'];
const ADMIN_SERVICE: readonly Role[] = ['admin', 'service'];

/** 'public' = no auth at all. Otherwise: the roles allowed on the route. */
export type RouteAccess = 'public' | readonly Role[];

export interface PolicyEntry {
  method: string;
  /** Express route path verbatim (`:id` params included) — auth-routes.test.ts
   * diffs this table against the registered router stack both ways. */
  path: string;
  access: RouteAccess;
}

/** THE gate table. Anything absent is refused (deny by default). */
export const ROUTE_POLICY: readonly PolicyEntry[] = [
  { method: 'GET', path: '/api/health', access: 'public' }, // monitors — ALWAYS public
  { method: 'GET', path: '/api/me', access: ALL_ROLES },
  { method: 'GET', path: '/api/signals', access: ALL_ROLES },
  { method: 'GET', path: '/api/settings', access: ALL_ROLES }, // the daemon reads it
  { method: 'PUT', path: '/api/settings', access: ADMIN_ONLY },
  { method: 'GET', path: '/api/wallets', access: ALL_ROLES }, // the daemon reads it
  { method: 'POST', path: '/api/wallets', access: ADMIN_ONLY },
  { method: 'PATCH', path: '/api/wallets/:id', access: ADMIN_ONLY },
  { method: 'DELETE', path: '/api/wallets/:id', access: ADMIN_ONLY },
  { method: 'POST', path: '/api/wallets/import', access: ADMIN_ONLY },
  { method: 'GET', path: '/api/tracked-cas', access: ALL_ROLES },
  { method: 'POST', path: '/api/tracked-cas', access: ADMIN_SERVICE }, // wallet_watch daemon
  { method: 'DELETE', path: '/api/tracked-cas/:id', access: ADMIN_ONLY },
  { method: 'PUT', path: '/api/tier', access: ADMIN_ONLY },
  { method: 'POST', path: '/api/wallet-watch/trades', access: ADMIN_SERVICE }, // wallet_watch daemon
];

/** Route paths only contain `/`, word chars and `-`, so they embed into a
 * RegExp literally; `:param` segments become `[^/]+`. */
function policyRegExp(path: string): RegExp {
  return new RegExp(`^${path.replace(/:[^/]+/g, '[^/]+')}$`);
}

const COMPILED_POLICY = ROUTE_POLICY.map((e) => ({
  method: e.method,
  re: policyRegExp(e.path),
  access: e.access,
}));

/** Match normalization: strip one trailing slash (Express routes `/api/tier/`
 * to the same handler); HEAD gates as GET (Express dispatches HEAD to GET
 * handlers, so monitors may HEAD the public health route). req.path already
 * excludes the query string. Case is NOT folded: a case-variant path simply
 * misses the table and is refused — fail closed, never fail open. */
export function resolveRouteAccess(method: string, path: string): RouteAccess | null {
  const m = method === 'HEAD' ? 'GET' : method;
  const p = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  for (const entry of COMPILED_POLICY) {
    if (entry.method === m && entry.re.test(p)) return entry.access;
  }
  return null;
}

/** Verify a Firebase ID token against the injected JWKS. Returns the verified
 * email, or null for ANY failure: unset project id (fail closed), bad signature,
 * wrong aud/iss, expired (exp, 30s clock tolerance), missing exp/iat/sub, iat in
 * the future (>5min skew), or an absent/unverified email claim. */
export async function verifyIdTokenEmail(
  token: string,
  jwks: JwksResolver,
  projectId: string,
): Promise<string | null> {
  if (projectId === '') return null; // FIREBASE_PROJECT_ID unset → browser auth disabled
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
      algorithms: ['RS256'],
      requiredClaims: ['exp', 'iat', 'sub', 'email'],
      clockTolerance: '30s',
    });
    if (typeof payload.sub !== 'string' || payload.sub === '') return null;
    if (payload.email_verified !== true) return null; // unverified email → reject
    if (typeof payload.email !== 'string' || payload.email === '') return null;
    if (typeof payload.iat !== 'number' || payload.iat > Date.now() / 1000 + 300) return null;
    return payload.email;
  } catch (err) {
    log.debug('[auth] id token rejected', { err });
    return null;
  }
}

type AuthOutcome = { principal: Principal } | { status: 401 | 403 };

/** Classify one Bearer token: service principal, Firebase principal (role from
 * the map), 401 (invalid/unverifiable), or 403 (valid token, email has no role). */
async function authenticate(
  token: string,
  jwks: JwksResolver,
  projectId: string,
  serviceToken: string,
  roles: ReadonlyMap<string, Role>,
): Promise<AuthOutcome> {
  if (matchServiceToken(token, serviceToken)) return { principal: { email: null, role: 'service' } };
  const email = await verifyIdTokenEmail(token, jwks, projectId);
  if (email === null) return { status: 401 };
  const role = roles.get(email.trim().toLowerCase());
  if (role === undefined) return { status: 403 }; // authenticated, but not on the role list
  return { principal: { email, role } };
}

/** `Authorization: Bearer <token>` → the token; null for a missing/malformed header. */
function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const parts = header.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer' || parts[1] === '') return null;
  return parts[1];
}

const ERROR_BODY = { 401: 'unauthorized', 403: 'forbidden' } as const;

function deny(res: Response, status: 401 | 403): void {
  res.status(status).json({ error: ERROR_BODY[status] });
}

/** Build the auth middleware. Injectable deps default to the config snapshot +
 * Firebase's remote JWKS; tests pass a local JWKS and sign real RS256 tokens. */
export function createAuthMiddleware(deps: AuthDeps = {}): RequestHandler {
  const jwks = (deps.jwks ?? firebaseJwks)();
  const roles = deps.roles ?? parseUserRoles(config.authUserRoles);
  const projectId = deps.firebaseProjectId ?? config.firebaseProjectId;
  const serviceToken = deps.serviceToken ?? config.serviceToken;
  return async (req, res, next) => {
    const access = resolveRouteAccess(req.method, req.path);
    if (access === 'public') {
      next();
      return;
    }
    const token = bearerToken(req.headers.authorization);
    if (token === null) {
      deny(res, 401);
      return;
    }
    const outcome = await authenticate(token, jwks, projectId, serviceToken, roles);
    if ('status' in outcome) {
      deny(res, outcome.status);
      return;
    }
    req.principal = outcome.principal;
    // access === null → not in the policy table → refuse (deny by default).
    if (access === null || !access.includes(outcome.principal.role)) {
      deny(res, 403);
      return;
    }
    next();
  };
}
