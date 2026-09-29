# Authorization roster — who is admin vs viewer

Date: 2026-09-28

## Decision

Per user instruction: only `lehoangtrong.vn@gmail.com` and `vuthenam.9.3.4@gmail.com`
are admins; the four previously-seeded accounts keep **read** access as viewers.
Confirmed with the user that "not admin" means viewer (can see data, cannot mutate),
not "no access".

## Value applied

```
AUTH_USER_ROLES=lehoangtrong.vn@gmail.com:admin,vuthenam.9.3.4@gmail.com:admin,thegreatkhanh.217@gmail.com:viewer,roguewolfalone@gmail.com:viewer,harry@drava.tech:viewer,harry.quantitative@gmail.com:viewer
```

| Email | Role | Can do |
|---|---|---|
| lehoangtrong.vn@gmail.com | admin | full: tier, wallets, settings, tier assignment |
| vuthenam.9.3.4@gmail.com | admin | full |
| thegreatkhanh.217@gmail.com | viewer | read all 5 GETs, `/api/me` |
| roguewolfalone@gmail.com | viewer | read all 5 GETs, `/api/me` |
| harry@drava.tech | viewer | read all 5 GETs, `/api/me` |
| harry.quantitative@gmail.com | viewer | read all 5 GETs, `/api/me` |

Written to both `/root/signal_scan/server/.env` (VPS, live source of truth) and the
local `server/.env`. Any Google account NOT listed above authenticates but gets
**403** — the roster is a closed allowlist (`server/src/auth.ts:198`).

## Verification — the real parser, not a eyeball read

`parseUserRoles` silently ignores malformed entries, so a typo would drop an account
without any error. Ran the production parser over the exact env value:

```
$ cd server && AUTH_USER_ROLES="$(grep '^AUTH_USER_ROLES=' .env | cut -d= -f2-)" npx tsx tmp-verify-roles.ts
tổng entry parse được: 6
admin (2):
   lehoangtrong.vn@gmail.com
   vuthenam.9.3.4@gmail.com
viewer (4):
   thegreatkhanh.217@gmail.com
   roguewolfalone@gmail.com
   harry@drava.tech
   harry.quantitative@gmail.com
ASSERT OK
EXIT=0
```

6 parsed / 6 intended = no entry silently dropped, roles as specified.

## State / caveat

- Backups: `/root/signal_scan/server/.env.bak.20260928T110516` (prior roster, 5 admins).
- **Not live yet.** The running api has no auth middleware — `auth.ts` is still local
  only. This roster takes effect at the first api start AFTER the auth code deploys
  (env is read at startup, so a restart alone on the old image changes nothing).

EVIDENCE_RECORDED: evidence/2026-09-28-auth-role-config.md
