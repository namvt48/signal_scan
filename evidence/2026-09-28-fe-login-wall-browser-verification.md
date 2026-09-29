# FE login wall — browser verification (reproduce → pass)

Date: 2026-09-28
Scope: `src/App.tsx`, `src/auth/auth-errors.ts`, `src/auth/auth-context.tsx` (the
sign-in error-handling fix). Verified by running the PRODUCTION build in a real
browser via Playwright, not by trusting the agent's report.

## Setup

```
npm run build                      # exit 0
dist/assets/index-9gUfBwdX.css   43.67 kB │ gzip:  10.90 kB
dist/assets/index-CRgj7Mf1.js   390.62 kB │ gzip: 104.14 kB
✓ built in 5.13s
npx vite preview --port 4173 --strictPort   # http 200
```

## Defect (original symptom, observed before the fix)

`SignInScreen` did `setError(e instanceof Error ? e.message : 'Sign in failed.')`.
With the Google popup dismissed, the login wall rendered the raw Firebase string:

```
Firebase: Error (auth/popup-closed-by-user)
```

## After the fix — same actions, observed result

1. Navigate to the login wall. Rendered correctly, `0 console errors/warnings`:
   `⌁ | signal_scan | Sign in to continue | This dashboard is restricted to authorized accounts. | Sign in with Google`
2. Click the only button. Popup opens at
   `trading-auth-67772.firebaseapp.com/__/auth/handler?...authType=signInViaPopup...`
   (confirms the popup flow and correct Firebase wiring).
3. Close the popup — the exact action that produced the defect:

```json
{
  "bodyText": "⌁ | signal_scan | Sign in to continue | This dashboard is restricted to authorized accounts. | Signing in…",
  "hasRawFirebaseString": false,
  "errorNodePresent": false,
  "errorNodeText": null
}
```

After a further 6s settle:

```json
{
  "buttonLabel": "Sign in with Google",
  "disabled": false,
  "errorNodeText": null,
  "remainingText": "⌁ | signal_scan | Sign in to continue | This dashboard is restricted to authorized accounts. | Sign in with Google"
}
```

| Check | Result |
|---|---|
| Raw `Firebase:` / `auth/...` string in UI | **gone** (`hasRawFirebaseString: false`) |
| Error node rendered on cancel | **none** (`errorNodePresent: false`) — cancellation is silent |
| Button recovers from busy | **yes** — `disabled: false`, label restored |
| Mobile 375×812 horizontal overflow | **none** — `scrollWidth === clientWidth === 375` |
| Dashboard reachable without login | **no** — wall renders, no tabs |

Static confirmation that no raw-error path remains:

```
$ grep -rn "e\.message\|\.message\b\|Firebase:" src/App.tsx src/auth/
src/auth/auth-errors.ts:1:// Firebase auth errors are user-hostile ("Firebase: Error (auth/...)"). Translate
```
The single hit is a code comment, never rendered.

Code path for the mobile fallback (`src/auth/auth-context.tsx:91-110`):
popup → `isSignInCancelled` → silent return; `isPopupUnavailable` →
`signInWithRedirect`; mount effect (`:25-29`) runs `getRedirectResult` to finish
a redirected sign-in.

## Finding — production nginx sets no COOP (worth one line)

Console during the repro:

```
[ERROR] Cross-Origin-Opener-Policy policy would block the window.closed call.
```

`nginx.conf` (and the live `/etc/nginx/conf.d/default.conf` in the container) set
only `Cache-Control` — no `Cross-Origin-Opener-Policy`. Consequences:

- Not broken: with no COOP header the popup is not blocked, so popup sign-in works.
- Cost: Firebase cannot reliably observe `window.closed`, so a cancelled popup
  leaves the button on "Signing in…" for ~6-7s before it recovers.
- Recommended one-line addition in the `location /` block:
  `add_header Cross-Origin-Opener-Policy "same-origin-allow-popups" always;`
  → instant cancel detection plus opener-attack hardening. Not applied yet.

## Verdict

Defect 1 (raw Firebase error leaking to the UI) — **fixed, reproduced-then-verified**.
Defect 2 (popup-only sign-in locking out mobile) — code path present and reviewed;
the popup-blocked branch cannot be triggered locally, so it still needs a real
phone/blocked-popup check after deploy.

EVIDENCE_RECORDED: evidence/2026-09-28-fe-login-wall-browser-verification.md
