// Firebase auth errors are user-hostile ("Firebase: Error (auth/...)"). Translate
// them to short copy here so no internal code/string ever reaches the UI.

const CANCELLED = new Set(['auth/popup-closed-by-user', 'auth/cancelled-popup-request']);
// Environments where a popup cannot open at all — the caller falls back to redirect.
const POPUP_UNAVAILABLE = new Set(['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment']);

function codeOf(err: unknown): string | null {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return null;
}

/** True when the user dismissed the popup — deliberate cancel, not a failure. */
export function isSignInCancelled(err: unknown): boolean {
  const code = codeOf(err);
  return code !== null && CANCELLED.has(code);
}

/** True when a popup is blocked/unsupported and redirect is the only path. */
export function isPopupUnavailable(err: unknown): boolean {
  const code = codeOf(err);
  return code !== null && POPUP_UNAVAILABLE.has(code);
}

/** Human message for a real failure. Cancellation is filtered out before this point. */
export function signInErrorMessage(err: unknown): string {
  switch (codeOf(err)) {
    case 'auth/popup-blocked':
      return 'Your browser blocked the sign-in popup. Allow popups and try again.';
    case 'auth/unauthorized-domain':
      return "This domain isn't authorized for sign-in.";
    case 'auth/network-request-failed':
      return 'Network error. Check your connection and try again.';
    default:
      return 'Sign in failed. Please try again.';
  }
}
