import { createContext } from 'react';
import type { User } from 'firebase/auth';

/**
 * Server-assigned role, resolved from GET /api/me. null = not resolved yet (or the
 * endpoint failed) — the FE treats null as "no admin powers", never as admin.
 */
export type Role = 'admin' | 'viewer' | 'service';

export interface AuthContextValue {
  user: User | null;
  loading: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  getToken: () => Promise<string>;
  /**
   * UX-only gate. The server enforces authorization on every route; there is NO
   * client-side role allowlist here — `role` is copied verbatim from /api/me.
   */
  role: Role | null;
  /** Human-readable sign-in failure (never a raw Firebase string); null when idle. */
  signInError: string | null;
  clearSignInError: () => void;
  /**
   * Authenticated but rejected by the server's allowlist (GET /api/me → 403).
   * A hard denial, distinct from the viewer role; `role` stays null (fail closed).
   */
  notAuthorized: boolean;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
