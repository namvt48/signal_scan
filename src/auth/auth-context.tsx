import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { GoogleAuthProvider, getRedirectResult, onIdTokenChanged, signInWithPopup, signInWithRedirect, signOut as firebaseSignOut } from 'firebase/auth';
import type { User } from 'firebase/auth';
import { auth } from './firebase-config';
import { AuthContext, type Role } from './auth-context-value';
import { isPopupUnavailable, isSignInCancelled, signInErrorMessage } from './auth-errors';
import { setAuthBridge } from '../services/restDataStore';

// Same base every REST call uses; '' in the Docker build (nginx same-origin /api proxy).
const API_BASE = import.meta.env.VITE_API_BASE ?? '';

function isRole(v: unknown): v is Role {
  return v === 'admin' || v === 'viewer' || v === 'service';
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<Role | null>(null);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [notAuthorized, setNotAuthorized] = useState(false);

  // Complete a sign-in that came back from a redirect fallback. onIdTokenChanged
  // above turns a successful result into a signed-in user; only failures surface.
  useEffect(() => {
    void getRedirectResult(auth).catch((e: unknown) => {
      if (!isSignInCancelled(e)) setSignInError(signInErrorMessage(e));
    });
  }, []);

  useEffect(() => {
    // onIdTokenChanged also fires on the hourly auto-refresh and on sign-out, so
    // the token handed to the REST layer is always the current one.
    const unsubscribe = onIdTokenChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const getToken = useCallback(async (): Promise<string> => {
    const current = auth.currentUser;
    if (!current) throw new Error('Not authenticated');
    return current.getIdToken();
  }, []);

  // Plug auth into the data layer once: supply the bearer token, and drop the
  // session when any request comes back 401.
  useEffect(() => {
    setAuthBridge(
      async () => {
        const current = auth.currentUser;
        return current ? current.getIdToken() : null;
      },
      () => {
        void firebaseSignOut(auth);
      },
    );
  }, []);

  // Role is authoritative only when it comes from the server. No client-side
  // allowlist: /api/me is the single source of truth for what the UI may expose.
  useEffect(() => {
    if (loading) return;
    if (!user) {
      setRole(null);
      setNotAuthorized(false);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/me`, {
          headers: { Authorization: `Bearer ${await user.getIdToken()}` },
        });
        if (res.status === 401) {
          await firebaseSignOut(auth); // stale token → back to the login wall
          return;
        }
        // 403 = signed in but not on the server's allowlist: a hard denial, not a
        // viewer. Show the dedicated screen; role stays null (fail closed).
        if (res.status === 403) {
          if (alive) {
            setRole(null);
            setNotAuthorized(true);
          }
          return;
        }
        if (!res.ok) return;
        const data = (await res.json()) as { role?: unknown };
        if (alive) {
          setNotAuthorized(false);
          if (isRole(data.role)) setRole(data.role);
        }
      } catch {
        // Network/parse failure: leave role null (viewer UI) rather than guess.
      }
    })();
    return () => {
      alive = false;
    };
  }, [user, loading]);

  async function signIn() {
    setSignInError(null);
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (e) {
      // Dismissed popup = deliberate cancel: stay silent on the idle wall.
      if (isSignInCancelled(e)) return;
      // Popup blocked/unsupported (mobile Safari): redirect completes on next mount.
      if (isPopupUnavailable(e)) {
        try {
          await signInWithRedirect(auth, provider);
        } catch (redirectErr) {
          setSignInError(signInErrorMessage(redirectErr));
        }
        return;
      }
      setSignInError(signInErrorMessage(e));
    }
  }

  function clearSignInError() {
    setSignInError(null);
  }

  async function signOut() {
    await firebaseSignOut(auth);
  }

  return (
    <AuthContext.Provider value={{ user, loading, signIn, signOut, getToken, role, signInError, clearSignInError, notAuthorized }}>
      {children}
    </AuthContext.Provider>
  );
}
