# FE Google Auth + RBAC gating — evidence (2026-09-28)

## Build (verification command + real output)
`npm run build` → `EXIT=0`

```
dist/assets/index-DAVqt3tA.css   43.65 kB │ gzip: 10.89 kB
dist/assets/index-C9Jb7g9b.js   388.71 kB │ gzip: 103.75 kB
✓ built in 5.82s
```

LSP diagnostics: 0 errors on src/auth/*, src/App.tsx, src/components/SignalTable.tsx,
src/components/WalletsPage.tsx, src/services/restDataStore.ts.

## Bundle assertions
- `grep -c "trading-auth-67772" dist/assets/index-C9Jb7g9b.js` → 1 (Firebase env baked)
- `grep -cE "vuthenam|roguewolfalone|harry@drava" dist/assets/index-C9Jb7g9b.js` → 0
- `grep -c "/api/me" dist/assets/index-C9Jb7g9b.js` → 1
- `grep -rn "h-screen" src/` → NONE

## No client-side allowlist
`grep -rniE "VITE_AUTH_USER_ROLES|ALLOWED_EMAILS|isAllowed" src/` → NONE FOUND.
Role is read only from `GET /api/me` (auth-context.tsx:57-73).

## Files
Added:
- src/auth/firebase-config.ts
- src/auth/auth-context-value.ts
- src/auth/use-auth.ts
- src/auth/auth-context.tsx
- .env.example
- .env (gitignored; real values)

Changed:
- src/services/restDataStore.ts (16-39)
- src/App.tsx
- src/components/SignalTable.tsx (8, 388, 699-703)
- src/components/WalletsPage.tsx (7, 124-125, 226, 250, 305, 341, 348, 373)
- Dockerfile (15-22)
- docker-compose.yml (66-71)
- package.json / package-lock.json (firebase ^12.19.0)

## Follow-up: sign-in error mapping + popup-blocked redirect fallback (2026-09-28)

Defects fixed:
1. Raw `Firebase: Error (auth/popup-closed-by-user)` leaked into the wall.
2. Mobile Safari / popup-blocked users could not sign in.

Files (only src/App.tsx + src/auth/*):
- ADDED `src/auth/auth-errors.ts` — `isSignInCancelled`, `isPopupUnavailable`,
  `signInErrorMessage` (cancellation → null-equivalent; popup-blocked/unauthorized-domain/
  network-request-failed/default → fixed human copy).
- `src/auth/auth-context-value.ts` — added `signInError` + `clearSignInError` to the contract.
- `src/auth/auth-context.tsx:21-30` — `getRedirectResult(auth)` on mount completes a
  redirect sign-in and surfaces only real failures; `signIn()` (:93-113) silent on cancel,
  `signInWithRedirect` fallback on popup-blocked/unsupported.
- `src/App.tsx:49-80` — SignInScreen reads `signInError` from context; NO `e.message` path.
  Markup/copy/classes/`min-h-[100dvh]`/BrandMark unchanged.

Verification:
- `npx tsc --noEmit` → TSC_EXIT=0
- `npm run build` → BUILD_EXIT=0
  ```
  dist/assets/index-9gUfBwdX.css   43.67 kB │ gzip: 10.90 kB
  dist/assets/index-CRgj7Mf1.js   390.62 kB │ gzip: 104.14 kB
  ✓ built in 5.80s
  ```
- `grep -rn "e.message\|Firebase:" src/App.tsx src/auth/` → only one hit, a code comment
  in auth-errors.ts (not rendered). No runtime raw-string path.
- Copy intact at App.tsx:69-72. No client-side role list added. `restDataStore.ts` /
  `SignalTable.tsx` / `WalletsPage.tsx` not modified this follow-up.

## Follow-up 2: GET /api/me 403 → dedicated "Not authorized" screen (2026-09-28)

Bug: an authenticated but unlisted email got 403 on /api/me; only 401 was handled, so it
fell through to DashboardShell viewer mode + 403 data-error spam.

Files (only src/App.tsx + src/auth/*):
- `src/auth/auth-context-value.ts:24-28` — `notAuthorized: boolean` added to contract.
- `src/auth/auth-context.tsx:22` state; `:65-89` effect: 403 → `setRole(null)` +
  `setNotAuthorized(true)` (guarded by `alive`); `!user` and success reset it false;
  401 path unchanged (`:77` sign-out); `alive` cleanup unchanged; `:135` provider value.
- `src/App.tsx:80-107` — new `NotAuthorizedScreen` (heading "Not authorized", body
  "Your account isn't authorized for this dashboard.", button "Sign out and switch account"
  → existing `signOut()`); `:205-209` `AppContent` renders it before SignInScreen/DashboardShell.

Verification:
- `npx tsc --noEmit` → TSC_EXIT=0
- `npm run build` → BUILD_EXIT=0
  ```
  dist/assets/index-9gUfBwdX.css   43.67 kB │ gzip: 10.90 kB
  dist/assets/index-mrW9FKqC.js   391.50 kB │ gzip: 104.25 kB
  ✓ built in 5.31s
  ```
- `role` stays null on 403 (fail closed); login-wall copy untouched; keep-alive
  `visited`/`hidden` untouched; forbidden files not modified.


