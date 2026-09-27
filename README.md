# signal_scan

CT alpha-signal dashboard for memecoin tracking: token signal table (framework01), tracked-wallet management with CSV import/export, and a CA tracking queue.

UI-first: all data comes from a swappable service layer (`src/services/dataStore.ts`) backed by localStorage with mock seed data. The real API layer (Birdeye + GMGN pipeline, see docs/) will replace this implementation later without touching any component.

## Stack

Vite · React 18 · TypeScript (strict) · Tailwind CSS v4

## Dev

```bash
npm i
npm run dev       # dev server
npm run build     # tsc + vite -> dist/
npm run preview   # serve the production build locally
```

## CSV format

Header is `address,name,tags,chain,source` with an OPTIONAL trailing `clan` column (legacy 5-column files still import).

- `tags`: multiple tags inside one cell, separated by `;`
- `chain`: one of `sol`
- `clan` (optional): display-only label shown beside the wallet name (Wallet tab and the "Tracked by" rows). It never filters or routes anything.
- Rows with an empty address or an unknown chain are skipped and shown with a reason in the import preview before committing.

Example:

```csv
address,name,tags,chain,source,clan
0x6A2f9C4e1B7d3F8a5E0c2D6b9A4f7C1e3D5b8E2a,CT01,sniper;fresh-wallet,sol,gmgn,a
Fg9xK2mR7qT4vBn8cLd3Ws6Za1Py5Ue9HjA,CT03,whale,sol,birdeye,b
```

## Deploy (Docker)

```bash
docker build -t signal_scan .
docker run -d -p 8080:80 --name signal_scan signal_scan
# open http://<vps-ip>:8080
```

## Deploy (plain static hosting)

```bash
npm run build
```

Serve `dist/` with any web server. SPA fallback is required (unknown paths must serve `index.html`); see `nginx.conf` for a ready-made config with gzip and immutable caching for hashed assets.

## API swap

Components never touch localStorage directly; they only call `dataStore` from `src/services/dataStore.ts`, which implements the `DataStore` interface (async methods). To go live, re-implement that interface with `fetch()` calls against the alpha engine API. No component changes needed.

## Tunables

`src/config.ts` holds `ENTRY_VOLUME_THRESHOLD` (24h volume under which a token shows a green entry) and other constants.

## Reference docs

- `docs/framework01-spec.md` - signal table column spec
- `docs/alpha-engine-brief.md` - data science engine that will feed the dashboard later
