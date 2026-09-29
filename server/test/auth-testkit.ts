// Shared test kit for AUTH CONTRACT v1: signs REAL RS256 Firebase-shaped ID
// tokens with a locally generated keypair and verifies them through a jose
// createLocalJWKSet injected into createApp — the auth middleware runs its
// production code path, only the trust anchor is local. No mocks of the role
// logic. Not a *.test.ts file, so `tsx --test` never runs it directly.

import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { parseUserRoles, type AuthDeps, type JwksResolver } from '../src/auth.js';

export const TEST_PROJECT_ID = 'testkit-project';
export const TEST_SERVICE_TOKEN = 'testkit-service-token-9f3c1a7e5b';
export const ADMIN_EMAIL = 'admin@testkit.local';
export const VIEWER_EMAIL = 'viewer@testkit.local';
const KID = 'testkit-key-1';

export interface SignTokenOverrides {
  /** Wrong-audience case. Default: TEST_PROJECT_ID. */
  audience?: string;
  /** Absolute exp (epoch seconds). Default: now + 1h. */
  expiresInSeconds?: number;
  /** Absolute iat (epoch seconds). Default: now. */
  issuedAtSeconds?: number;
  subject?: string;
  /** false → the email_verified gate must reject the token. */
  emailVerified?: boolean;
}

export interface TestAuth {
  projectId: string;
  adminEmail: string;
  viewerEmail: string;
  serviceToken: string;
  /** createApp deps: local JWKS + admin/viewer role map + the known service token. */
  deps: AuthDeps;
  /** A real signed RS256 ID token for the email (verified-email claim by default). */
  signToken(email: string, overrides?: SignTokenOverrides): Promise<string>;
  /** `authorization` header value for a freshly signed token of the email. */
  bearer(email: string, overrides?: SignTokenOverrides): Promise<string>;
}

export async function createTestAuth(
  rolesRaw: string = `${ADMIN_EMAIL}:admin, ${VIEWER_EMAIL}:viewer`,
): Promise<TestAuth> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = KID;
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  const resolver: JwksResolver = createLocalJWKSet({ keys: [jwk] });

  const signToken = async (email: string, o: SignTokenOverrides = {}): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ email, email_verified: o.emailVerified ?? true })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: KID })
      .setSubject(o.subject ?? `uid-${email}`)
      .setAudience(o.audience ?? TEST_PROJECT_ID)
      .setIssuer(`https://securetoken.google.com/${TEST_PROJECT_ID}`)
      .setIssuedAt(o.issuedAtSeconds ?? now)
      .setExpirationTime(o.expiresInSeconds ?? now + 3600)
      .sign(privateKey);
  };

  return {
    projectId: TEST_PROJECT_ID,
    adminEmail: ADMIN_EMAIL,
    viewerEmail: VIEWER_EMAIL,
    serviceToken: TEST_SERVICE_TOKEN,
    deps: {
      jwks: () => resolver,
      roles: parseUserRoles(rolesRaw),
      firebaseProjectId: TEST_PROJECT_ID,
      serviceToken: TEST_SERVICE_TOKEN,
    },
    signToken,
    bearer: async (email, o) => `Bearer ${await signToken(email, o)}`,
  };
}
