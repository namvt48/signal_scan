// SQLite persistence (better-sqlite3, WAL). Read-side typed helpers + schema +
// mock seed live here; the write seam lives in ingest.ts; signal aggregation
// queries live in signals.ts. Everything else goes through these helpers.

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { CHAINS, canonicalCa, type Chain } from './shared/chain.js';
import { type Tier } from './shared/tier.js';
import { config } from './config.js';
import { MOCK_CA_POOL } from './providers/mock.js';

export interface WalletRow {
  id: string;
  address: string;
  name: string;
  /** JSON-encoded string[] — parse at the API boundary. */
  tags: string;
  /** Only CHAINS-validated values are ever written (api.ts / seed), so the read is trustworthy. */
  chain: Chain;
  source: string;
  /** Display-only label beside the wallet name. Never filters or routes (user 2026-09-24). */
  clan: string | null;
}

export interface TrackedCaRow {
  id: string;
  address: string;
  chain: Chain;
  note: string;
  added_at: string;
  status: string;
  /** USD entry size — NULL until known; assembleSignals skips NULL/< minUsd rows. */
  entry_usd: number | null;
}

export interface TokenStateRow {
  ca: string;
  chain: Chain;
  price: number | null;
  holders: number | null;
  volume24h: number | null;
  buy_vol24h: number | null;
  sell_vol24h: number | null;
  /** Trailing-1h DEX volume, USD — derived: volume24h growth since the previous sweep. */
  vol_1h: number | null;
  /** Previous volume24h reading + its epoch ms — the delta base for vol_1h (1 call/hour). */
  vol_24h_prev: number | null;
  vol_24h_prev_at: number | null;
  market_cap: number | null;
  liquidity: number | null;
  supply: number | null;
  fresh_count: number | null;
  fresh_rate: number | null;
  top10_rate: number | null;
  t100_pct: number | null;
  bal_peak_24h: number | null;
  bal_trough_24h: number | null;
  bal_peak_7d: number | null;
  bal_trough_7d: number | null;
  bal_peak_30d: number | null;
  bal_trough_30d: number | null;
  /** Nansen holders count (tgm-holders-change.nofHoldersRecent) — authoritative when set. */
  nansen_holders: number | null;
  /** Nansen fresh-wallet SUPPLY share, percent 0-100 (gini stats) — authoritative when set. */
  nansen_fresh_pct: number | null;
  /** Nansen top-100 SUPPLY share, percent 0-100 (gini stats) — authoritative when set. */
  nansen_t100_pct: number | null;
  /** Nansen median holder balance, USD (gini stats) — authoritative when set. */
  nansen_median_usd: number | null;
  /** Token deploy time, epoch ms (essential-data.deployedTimestamp) — write-once. */
  deployed_at: number | null;
  /** T100 sliding max-drawdown multiple (t100Mdd) — paired with t100_pct. */
  t100_multiple: number | null;
  /** LF: the exchange chart's LEFTMOST balance (token units) — the float. */
  genesis_bal: number | null;
  /** Epoch ms of the max-drawdown PEAK (t100Mdd.peakAt) — NOT a genesis. */
  anchor_at: number | null;
  /** Token ticker from essential-data (e.g. "MINI") — as-is, FE uppercases. */
  symbol: string | null;
  /** Token logo URL (DexScreener icon sweep) — validated https + allowlisted host before write. */
  icon_url: string | null;
  fetched_at: number | null;
}

export interface SnapshotRow {
  id: number;
  ca: string;
  chain: Chain;
  taken_at: number;
  holders_json: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wallets (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  name TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  chain TEXT NOT NULL DEFAULT 'sol',
  source TEXT NOT NULL DEFAULT '',
  clan TEXT,
  UNIQUE(address, chain)
);
CREATE TABLE IF NOT EXISTS tracked_cas (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  chain TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  added_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  entry_usd REAL,
  UNIQUE(address, chain)
);
CREATE TABLE IF NOT EXISTS token_state (
  ca TEXT,
  chain TEXT,
  price REAL,
  holders INTEGER,
  volume24h REAL,
  buy_vol24h REAL,
  sell_vol24h REAL,
  vol_1h REAL,
  vol_24h_prev REAL,
  vol_24h_prev_at INTEGER,
  market_cap REAL,
  liquidity REAL,
  supply REAL,
  fresh_count INTEGER,
  fresh_rate REAL,
  top10_rate REAL,
  t100_pct REAL,
  bal_peak_24h REAL,
  bal_trough_24h REAL,
  bal_peak_7d REAL,
  bal_trough_7d REAL,
  bal_peak_30d REAL,
  bal_trough_30d REAL,
  icon_url TEXT,
  fetched_at INTEGER,
  PRIMARY KEY (ca, chain)
);
CREATE TABLE IF NOT EXISTS holder_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ca TEXT,
  chain TEXT,
  taken_at INTEGER,
  holders_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_snap_ca_time ON holder_snapshots(ca, chain, taken_at DESC);
CREATE TABLE IF NOT EXISTS wallet_token_state (
  wallet_id TEXT,
  ca TEXT,
  balance_usd REAL,
  token_amount REAL NOT NULL DEFAULT 0,
  chain TEXT NOT NULL DEFAULT 'sol',
  PRIMARY KEY (wallet_id, ca, chain),
  FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS wallet_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_id TEXT,
  ca TEXT,
  ts INTEGER,
  side TEXT CHECK(side IN ('buy','sell')),
  amount_usd REAL,
  price REAL,
  tx TEXT,
  source TEXT NOT NULL DEFAULT 'nansen',
  chain TEXT NOT NULL DEFAULT 'sol',
  UNIQUE(wallet_id, ca, chain, tx, side),
  FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_trades_ca ON wallet_trades(ca, side);

CREATE TABLE IF NOT EXISTS nansen_series (
  ca TEXT NOT NULL,
  chain TEXT NOT NULL,
  window TEXT NOT NULL,
  taken_at INTEGER NOT NULL,
  points_json TEXT NOT NULL,
  PRIMARY KEY (ca, chain, window)
);

-- Runtime-adjustable settings (key/value strings). Currently holds the Nansen
-- factor thresholds (freshMinPct/t100MinPct/lfMaxPct) that gate the X/3 score.
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Per-CA user tier (S+/S/A+/A/B+/B). Absent row = unrated. Keyed like tracked_cas.
CREATE TABLE IF NOT EXISTS token_tiers (
  ca TEXT NOT NULL,
  chain TEXT NOT NULL,
  tier TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (ca, chain)
);
`;

let instance: Database.Database | null = null;

export function open(path: string): void {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  instance = new Database(path);
  instance.pragma('journal_mode = WAL');
  instance.pragma('busy_timeout = 5000');
  instance.pragma('synchronous = NORMAL');
  // better-sqlite3 leaves foreign_keys OFF by default — the wallet FK cascades
  // (delete wallet -> trades/balances cleaned) depend on this.
  instance.pragma('foreign_keys = ON');
  instance.exec(SCHEMA);
  // Migration for DBs created before the balance-range columns (idempotent).
  const cols = (instance.pragma('table_info(token_state)') as { name: string }[]).map((c) => c.name);
  for (const col of ['vol_1h', 'vol_24h_prev', 'bal_peak_24h', 'bal_trough_24h', 'bal_peak_7d', 'bal_trough_7d', 'bal_peak_30d', 'bal_trough_30d', 'fresh_rate', 'nansen_holders', 'nansen_fresh_pct', 'nansen_t100_pct', 'nansen_median_usd', 't100_multiple', 'genesis_bal']) {
    if (!cols.includes(col)) instance.exec(`ALTER TABLE token_state ADD COLUMN ${col} REAL`);
  }
  // deployed_at/anchor_at store epoch ms — INTEGER affinity (separate from the REAL list above).
  if (!cols.includes('deployed_at')) instance.exec('ALTER TABLE token_state ADD COLUMN deployed_at INTEGER');
  if (!cols.includes('anchor_at')) instance.exec('ALTER TABLE token_state ADD COLUMN anchor_at INTEGER');
  if (!cols.includes('vol_24h_prev_at')) instance.exec('ALTER TABLE token_state ADD COLUMN vol_24h_prev_at INTEGER');
  // symbol is the ticker string — TEXT affinity.
  if (!cols.includes('symbol')) instance.exec('ALTER TABLE token_state ADD COLUMN symbol TEXT');
  // icon_url is the validated DexScreener logo URL — TEXT affinity too.
  if (!cols.includes('icon_url')) instance.exec('ALTER TABLE token_state ADD COLUMN icon_url TEXT');
  // tracked_cas.entry_usd (USD entry size — the minUsd signals gate), nullable.
  const trackedCols = (instance.pragma('table_info(tracked_cas)') as { name: string }[]).map((c) => c.name);
  if (!trackedCols.includes('entry_usd')) instance.exec('ALTER TABLE tracked_cas ADD COLUMN entry_usd REAL');
  // wallet_token_state.token_amount — the price-independent holdings source for
  // the Tracked by / Holding % columns (ALTER, never drop: prod rows survive).
  const walletTokenCols = (instance.pragma('table_info(wallet_token_state)') as { name: string }[]).map((c) => c.name);
  if (!walletTokenCols.includes('token_amount')) {
    instance.exec('ALTER TABLE wallet_token_state ADD COLUMN token_amount REAL NOT NULL DEFAULT 0');
  }
  // wallet_trades.source — which detector produced the row: 'nansen' (the
  // wp4t-transactions sweep, everything historical) or 'watch' (the Solana-RPC
  // wallet_watch daemon, user 2026-09-21). ALTER not DROP: existing rows belong
  // to the wp4t sweep, hence the default.
  const tradeCols = (instance.pragma('table_info(wallet_trades)') as { name: string }[]).map((c) => c.name);
  if (!tradeCols.includes('source')) {
    instance.exec("ALTER TABLE wallet_trades ADD COLUMN source TEXT NOT NULL DEFAULT 'nansen'");
  }
  // wallets.clan — display-only label rendered beside the wallet name (user
  // 2026-09-24: "clan chỉ là một cái tên bên cạnh name của wallet"). NOT a
  // filter/route key: nothing queries it. Existing wallets default to 'a'.
  const walletCols = (instance.pragma('table_info(wallets)') as { name: string }[]).map((c) => c.name);
  if (!walletCols.includes('clan')) {
    instance.exec('ALTER TABLE wallets ADD COLUMN clan TEXT');
    instance.exec("UPDATE wallets SET clan = 'a' WHERE clan IS NULL");
  }
  // T3 (evm-base-bsc): chain-aware wallet keys — SQLite can't drop UNIQUE/PK via
  // ALTER, so rebuild the 3 tables (copy with chain='sol') in ONE transaction
  // under foreign_keys=OFF (pragma is a no-op inside a transaction). Must run
  // after the ALTERs above so token_amount/source/clan exist to copy. Trigger:
  // pre-T3 DBs lack wallet_token_state.chain; fresh/re-opened DBs have it → no-op.
  const wtsHasChain = (instance.pragma('table_info(wallet_token_state)') as { name: string }[]).some(
    (c) => c.name === 'chain',
  );
  if (!wtsHasChain) {
    const db = instance;
    db.pragma('foreign_keys = OFF');
    try {
      const rebuildWalletTables = db.transaction(() => {
        db.exec(`
          CREATE TABLE wallets_new (
            id TEXT PRIMARY KEY,
            address TEXT NOT NULL,
            name TEXT NOT NULL,
            tags TEXT NOT NULL DEFAULT '[]',
            chain TEXT NOT NULL DEFAULT 'sol',
            source TEXT NOT NULL DEFAULT '',
            clan TEXT,
            UNIQUE(address, chain)
          );
          INSERT INTO wallets_new (id, address, name, tags, chain, source, clan)
            SELECT id, address, name, tags, COALESCE(chain, 'sol'), source, clan FROM wallets;
          DROP TABLE wallets;
          ALTER TABLE wallets_new RENAME TO wallets;

          CREATE TABLE wallet_token_state_new (
            wallet_id TEXT,
            ca TEXT,
            balance_usd REAL,
            token_amount REAL NOT NULL DEFAULT 0,
            chain TEXT NOT NULL DEFAULT 'sol',
            PRIMARY KEY (wallet_id, ca, chain),
            FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE
          );
          INSERT INTO wallet_token_state_new (wallet_id, ca, balance_usd, token_amount, chain)
            SELECT wallet_id, ca, balance_usd, token_amount, 'sol' FROM wallet_token_state;
          DROP TABLE wallet_token_state;
          ALTER TABLE wallet_token_state_new RENAME TO wallet_token_state;

          CREATE TABLE wallet_trades_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            wallet_id TEXT,
            ca TEXT,
            ts INTEGER,
            side TEXT CHECK(side IN ('buy','sell')),
            amount_usd REAL,
            price REAL,
            tx TEXT,
            source TEXT NOT NULL DEFAULT 'nansen',
            chain TEXT NOT NULL DEFAULT 'sol',
            UNIQUE(wallet_id, ca, chain, tx, side),
            FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE
          );
          INSERT INTO wallet_trades_new (id, wallet_id, ca, ts, side, amount_usd, price, tx, source, chain)
            SELECT id, wallet_id, ca, ts, side, amount_usd, price, tx, source, 'sol' FROM wallet_trades;
          DROP TABLE wallet_trades;
          ALTER TABLE wallet_trades_new RENAME TO wallet_trades;

          CREATE INDEX IF NOT EXISTS idx_trades_ca ON wallet_trades(ca, side);
        `);
      });
      rebuildWalletTables();
    } finally {
      db.pragma('foreign_keys = ON');
    }
    const fkViolations = db.pragma('foreign_key_check') as unknown[];
    if (fkViolations.length > 0) {
      throw new Error(`wallet chain migration: foreign_key_check found ${fkViolations.length} violation(s)`);
    }
  }
  // One-time LF re-resolve (user 2026-09-11): the LF rule became "the exchange
  // chart's LEFTMOST point", so every stored genesis_bal is stale — and stale is
  // self-locking, because refreshSeries only refetches while the column is NULL.
  // Clear it once (marker-gated, so a restart cannot wipe freshly resolved
  // values); the next hot/cold sweep refills it under the new rule. anchor_at
  // needs no reset: it is recomputed on every sweep.
  const LF_RULE = '2026-09-11-leftmost';
  if (getSetting('lfRule') !== LF_RULE) {
    instance.prepare('UPDATE token_state SET genesis_bal = NULL').run();
    setSetting('lfRule', LF_RULE);
  }
  // System deploy anchor (plan setup-fill-on-add T5): the setupSweep 12h phase
  // counts from THIS instant, not from process boot — restarts re-phase to the
  // same boundaries instead of drifting (the old i*20s stagger). Written once,
  // never overwritten: settings survives restarts AND table resets, so the
  // cadence phase is stable across both.
  if (getSetting('systemDeployAt') === undefined) setSetting('systemDeployAt', String(Date.now()));
}

export function getDb(): Database.Database {
  if (!instance) throw new Error('db not open — call open(path) first');
  return instance;
}

// --- wallets --------------------------------------------------------------

export interface WalletInput {
  address: string;
  name: string;
  tags: string[];
  chain: Chain;
  source: string;
  /** Display-only label (user 2026-09-24). Absent = unlabelled ('' stored). */
  clan?: string;
}

export function listWallets(): WalletRow[] {
  return getDb().prepare('SELECT * FROM wallets ORDER BY name').all() as WalletRow[];
}

/**
 * The (CA, wallet) pairs a CA set is `Tracked by` — a source='watch' BUY row, the
 * sole writer (signals.trackedByNames). This PAIR is the unit a holdings query
 * spends (user 2026-09-23: "query cặp CA-wallet chứ không query linh tinh"): the
 * caller asks the RPC for exactly that mint at that wallet, never the wallet's
 * whole token-account list.
 */
export function trackedByPairs(cas: readonly string[]): { ca: string; wallet: WalletRow }[] {
  if (cas.length === 0) return [];
  const ph = cas.map(() => '?').join(',');
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT t.ca AS ca, w.* FROM wallet_trades t
         JOIN wallets w ON w.id = t.wallet_id
        WHERE t.ca IN (${ph}) AND t.side = 'buy' AND t.source = 'watch'
        ORDER BY w.name, t.ca`,
    )
    .all(...cas) as ({ ca: string } & WalletRow)[];
  return rows.map(({ ca, ...wallet }) => ({ ca, wallet }));
}

/** The CAs to re-query for one wallet now: every still-tracked CA it has traded (BUY or
 *  SELL) — a sell-only wallet still refreshes its holding; it just is not a member
 *  (`Tracked by` stays BUY-only, see trackedByPairs). */
export function watchedCasForWallet(walletId: string): string[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT t.ca AS ca FROM wallet_trades t
        WHERE t.wallet_id = ? AND t.source = 'watch'
          AND t.ca IN (SELECT address FROM tracked_cas)`,
    )
    .all(walletId) as { ca: string }[];
  return rows.map((r) => r.ca);
}

/**
 * MAX(ts) of each CA's source='watch' trades — buy OR sell — inside the window,
 * restricted to MEMBER (wallet, CA) pairs (a wallet with ANY source='watch' buy —
 * membership is ever-bought, no time window, the trackedWalletStats rule). This is
 * the recency key that orders the dashboard: a member's SELL bumps its CA exactly
 * like a buy (user 2026-09-24). Activity from a non-member wallet is ignored, so a
 * CA with no tracked wallet of its own keeps the 0 sentinel and sinks.
 */
export function latestWatchTradeTsByCa(sinceTs: number): Map<string, number> {
  const rows = getDb()
    .prepare(
      `SELECT t.ca AS ca, MAX(t.ts) AS ts FROM wallet_trades t
        WHERE t.source = 'watch' AND t.ts >= @sinceTs
          AND EXISTS (SELECT 1 FROM wallet_trades b
                       WHERE b.wallet_id = t.wallet_id AND b.ca = t.ca
                         AND b.side = 'buy' AND b.source = 'watch')
        GROUP BY t.ca`,
    )
    .all({ sinceTs }) as { ca: string; ts: number }[];
  return new Map(rows.map((r) => [r.ca, r.ts]));
}

export function getWallet(id: string): WalletRow | undefined {
  return getDb().prepare('SELECT * FROM wallets WHERE id = ?').get(id) as WalletRow | undefined;
}

/** Identity key is (address, chain) — the same address on 2 chains = 2 wallets (T4). */
export function findWalletByAddress(address: string, chain: Chain): WalletRow | undefined {
  return getDb().prepare('SELECT * FROM wallets WHERE address = ? AND chain = ?').get(canonicalCa(address, chain), chain) as
    | WalletRow
    | undefined;
}

export function insertWallet(input: WalletInput): WalletRow {
  const id = randomUUID();
  const tags = JSON.stringify(input.tags);
  const address = canonicalCa(input.address, input.chain);
  getDb()
    .prepare('INSERT INTO wallets (id, address, name, tags, chain, source, clan) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, address, input.name, tags, input.chain, input.source, input.clan ?? '');
  return { id, address, name: input.name, tags, chain: input.chain, source: input.source, clan: input.clan ?? '' };
}

export function updateWallet(id: string, next: WalletInput): WalletRow | undefined {
  getDb()
    .prepare('UPDATE wallets SET address = ?, name = ?, tags = ?, chain = ?, source = ?, clan = ? WHERE id = ?')
    .run(canonicalCa(next.address, next.chain), next.name, JSON.stringify(next.tags), next.chain, next.source, next.clan ?? '', id);
  return getWallet(id);
}

export function deleteWallet(id: string): void {
  // FK ON DELETE CASCADE cleans wallet_token_state + wallet_trades.
  getDb().prepare('DELETE FROM wallets WHERE id = ?').run(id);
}

/** One CSV import row before validation (chain arrives as an arbitrary string). */
export interface ImportCandidate {
  address: string;
  name: string;
  tags: string[];
  chain: string;
  source: string;
  /** Display-only label (user 2026-09-24). Absent = unlabelled. */
  clan?: string;
}

export function isChain(v: unknown): v is Chain {
  return typeof v === 'string' && (CHAINS as readonly string[]).includes(v);
}

/**
 * Server-side CSV import: validates each row (boundary), dedupes by (address, chain)
 * via INSERT OR IGNORE. `row` = index in the input array (matches the frontend
 * ImportResult contract). Single transaction for the whole batch.
 */
export function importWallets(
  rows: readonly ImportCandidate[],
): { added: number; skipped: { row: number; reason: string }[] } {
  const db = getDb();
  const ins = db.prepare(
    'INSERT OR IGNORE INTO wallets (id, address, name, tags, chain, source, clan) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  let added = 0;
  const skipped: { row: number; reason: string }[] = [];
  const run = db.transaction((items: readonly ImportCandidate[]) => {
    items.forEach((r, i) => {
      const address = r.address.trim();
      if (!address) {
        skipped.push({ row: i, reason: 'address is empty' });
        return;
      }
      if (!isChain(r.chain)) {
        skipped.push({ row: i, reason: `invalid chain "${r.chain}" (expected one of ${CHAINS.join(', ')})` });
        return;
      }
      const res = ins.run(randomUUID(), address, r.name.trim(), JSON.stringify(r.tags), r.chain, r.source.trim(), (r.clan ?? '').trim());
      if (res.changes === 0) {
        skipped.push({ row: i, reason: 'duplicate address' });
      } else {
        added += 1;
      }
    });
  });
  run(rows);
  return { added, skipped };
}

// --- tracked_cas ----------------------------------------------------------

export interface TrackedCaInput {
  address: string;
  chain: Chain;
  note: string;
  entryUsd?: number;
}

export function listTrackedCas(): TrackedCaRow[] {
  return getDb().prepare('SELECT * FROM tracked_cas ORDER BY added_at DESC').all() as TrackedCaRow[];
}

/** A poll target — the (address, chain) pair the sweeps actually need. */
export interface CaTarget {
  address: string;
  chain: Chain;
}

/**
 * Tracked CAs whose essential core never landed. `supply` is the write-once LF
 * denominator, so NULL means the 24h essential pass has not reached the CA yet —
 * it paces 44min/CA, so a fresh CA would stay blank for hours. Bounded by
 * `withinMs`: a mint Nansen never indexes must not be retried forever (the 24h
 * pass still covers it).
 */
export function listCaTargetsMissingEssential(withinMs: number): CaTarget[] {
  const since = new Date(Date.now() - withinMs).toISOString();
  return getDb()
    .prepare(
      `SELECT t.address AS address, t.chain AS chain
         FROM tracked_cas t
         LEFT JOIN token_state s ON s.chain = t.chain AND s.ca = t.address
        WHERE s.supply IS NULL AND t.added_at >= ?
        ORDER BY t.added_at DESC`,
    )
    .all(since) as CaTarget[];
}

/**
 * Tracked CAs with no ticker yet. `symbol` never goes stale, and only
 * essential-data or this backfill ever writes it — but the backfill's getAsset
 * costs 10 DAS credits per call, so it is bounded by `withinMs`: a mint that
 * never resolves must not be retried forever (the 24h essential pass still
 * covers the CA). The dashboard renders "—" for every row in this set.
 */
export function listCaTargetsMissingSymbol(withinMs: number): CaTarget[] {
  const since = new Date(Date.now() - withinMs).toISOString();
  return getDb()
    .prepare(
      `SELECT t.address AS address, t.chain AS chain
         FROM tracked_cas t
         LEFT JOIN token_state s ON s.chain = t.chain AND s.ca = t.address
        WHERE (s.symbol IS NULL OR trim(s.symbol) = '') AND t.added_at >= ?
        ORDER BY t.added_at DESC`,
    )
    .all(since) as CaTarget[];
}

/**
 * Tracked CAs with no icon yet — the DexScreener sweep's target set. Same shape
 * as listCaTargetsMissingSymbol, but the window is generous instead of
 * credit-driven: one keyless batch call covers ≤30 CAs, so a mint that never
 * resolves (no DEX pair → no icon) costs a re-ask, not credits.
 */
export function listCaTargetsMissingIcon(withinMs: number): CaTarget[] {
  const since = new Date(Date.now() - withinMs).toISOString();
  return getDb()
    .prepare(
      `SELECT t.address AS address, t.chain AS chain
         FROM tracked_cas t
         LEFT JOIN token_state s ON s.chain = t.chain AND s.ca = t.address
        WHERE s.icon_url IS NULL AND t.added_at >= ?
        ORDER BY t.added_at DESC`,
    )
    .all(since) as CaTarget[];
}

export function findTrackedCa(address: string, chain: Chain): TrackedCaRow | undefined {
  return getDb()
    .prepare('SELECT * FROM tracked_cas WHERE address = ? AND chain = ?')
    .get(canonicalCa(address, chain), chain) as TrackedCaRow | undefined;
}

export function insertTrackedCa(input: TrackedCaInput): TrackedCaRow {
  const row: TrackedCaRow = {
    id: randomUUID(),
    address: canonicalCa(input.address, input.chain),
    chain: input.chain,
    note: input.note,
    added_at: new Date().toISOString(),
    status: 'queued',
    entry_usd: input.entryUsd ?? null,
  };
  getDb()
    .prepare('INSERT INTO tracked_cas (id, address, chain, note, added_at, status, entry_usd) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(row.id, row.address, row.chain, row.note, row.added_at, row.status, row.entry_usd);
  return row;
}

/**
 * Fills entry_usd for a CA whose entry value was unknown at insert time. Never
 * overwrites a known value — the `entry_usd IS NULL` guard enforces that in SQL.
 */
export function setTrackedCaEntryUsd(address: string, chain: Chain, usd: number): TrackedCaRow | undefined {
  getDb()
    .prepare('UPDATE tracked_cas SET entry_usd = ? WHERE address = ? AND chain = ? AND entry_usd IS NULL')
    .run(usd, canonicalCa(address, chain), chain);
  return findTrackedCa(address, chain);
}

export function deleteTrackedCa(id: string): void {
  getDb().prepare('DELETE FROM tracked_cas WHERE id = ?').run(id);
}

/**
 * "This tracked CA carries no user tier" — the guard EVERY auto-delete path must
 * carry. A CA the user rated is one they want kept, so the 48h inflow prune, the
 * tracked-by-none prune and the zero-score gate must all spare it (user 2026-09-28).
 * Defined once so the three paths cannot drift apart. Reads tracked_cas via the
 * alias `t`, which every candidate query below uses.
 */
const NOT_TIERED = `NOT EXISTS (SELECT 1 FROM token_tiers tt WHERE tt.ca = t.address AND tt.chain = t.chain)`;

/**
 * Deletes CA-scoped market data whose CA is no longer tracked. EVERY prune path
 * must call this: a prune that removes the tracked_cas row but skips this leaves
 * the CA's token_state and (worse) wallet_token_state rows behind. The latter has
 * no ca foreign key, so nothing cascades — 303 orphan rows had accumulated by
 * 2026-09-24, each one widening the unindexed `WHERE ca = ?` scans.
 */
function sweepOrphanedCaData(): void {
  const db = getDb();
  db.prepare(
    `DELETE FROM token_state WHERE NOT EXISTS (
       SELECT 1 FROM tracked_cas t WHERE t.address = token_state.ca AND t.chain = token_state.chain)`,
  ).run();
  // wallet_token_state IS chain-scoped (PK wallet_id, ca, chain) — match the same
  // (chain, ca) identity tracked_cas is unique on, otherwise a row for base:0xdup is
  // kept alive by an unrelated tracked CA that merely shares the address.
  db.prepare(
    `DELETE FROM wallet_token_state WHERE NOT EXISTS (
       SELECT 1 FROM tracked_cas t
        WHERE t.address = wallet_token_state.ca AND t.chain = wallet_token_state.chain)`,
  ).run();
  // token_tiers is deliberately NOT swept here: the address→tier map is permanent
  // ("nhớ lưu lại cái map address với tier lại, mỗi khi add mới CA thì check cái này").
  // A CA pruned and later re-added must come back with its tier intact, so a tier row
  // may outlive its tracked_cas row by design. Only an explicit PUT /api/tier with a
  // null tier clears one (deleteTier).
}

/**
 * Drop every tracked CA no tracked wallet interacts with: no wallet the CA is
 * `Tracked by` HOLDS it (wallet_token_state joined to a source='watch' BUY — the
 * holdings of an unlinked wallet are stale by construction, user 2026-09-23) AND
 * none BOUGHT it inside `windowMs`. The window runs
 * from the LAST inflow; a CA nothing ever bought falls back to `added_at`, so a
 * hand-added CA gets the full window before it can die (user 2026-09-20).
 * A wallet that bought and sold within seconds (GERI: a 26s flip) leaves
 * `trackedWallets` empty forever, so the row only clogs the table and the FE with no signal.
 *
 * "Xoá hoàn toàn" (user 2026-09-20): the drop also sweeps the CA's own market
 * data via sweepOrphanedCaData(). Wallet history (wallet_trades) is deliberately kept.
 *
 * Returns the dropped rows so the caller can log them — the DELETE is not undoable.
 * A CA with a stored user tier is never a candidate. Every clause is scoped to the
 * row's own (chain, ca) (user 2026-09-28): tracked_cas is UNIQUE(address, chain), so
 * a position or a buy on base must never keep bsc:0x… alive.
 */
export function pruneUntrackedCas(windowMs: number): TrackedCaRow[] {
  const db = getDb();
  const since = Date.now() - windowMs;
  // added_at is written as toISOString() (always 'YYYY-MM-DDTHH:mm:ss.sssZ'), so a
  // lexicographic compare against another ISO instant is a correct time compare.
  const cutoff = new Date(since).toISOString();
  const doomed = db
    .prepare(
        `SELECT t.* FROM tracked_cas t
        WHERE t.added_at <= ?
          AND ${NOT_TIERED}
          AND NOT EXISTS (SELECT 1 FROM wallet_token_state s
                           WHERE s.ca = t.address AND s.chain = t.chain AND s.token_amount > 0
                             AND EXISTS (SELECT 1 FROM wallet_trades wt
                                          WHERE wt.wallet_id = s.wallet_id AND wt.ca = s.ca AND wt.chain = s.chain
                                            AND wt.side = 'buy' AND wt.source = 'watch'))
          AND NOT EXISTS (SELECT 1 FROM wallet_trades w
                           WHERE w.ca = t.address AND w.chain = t.chain AND w.side = 'buy' AND w.ts >= ?)`,
    )
    .all(cutoff, since) as TrackedCaRow[];
  // Safe + deliberate: every token_state / wallet_token_state reader joins
  // tracked_cas, so a row whose CA is gone is unreachable, and the sweep is
  // unconditional to drain the old backlog too.
  db.transaction(() => {
    const del = db.prepare('DELETE FROM tracked_cas WHERE id = ?');
    for (const r of doomed) del.run(r.id);
    sweepOrphanedCaData();
  })();
  return doomed;
}

/**
 * Delete every tracked CA no wallet is `Tracked by` — exactly the trackedWalletStats
 * rule: a `source='watch'` BUY inside `withinMs`. Holding does NOT exempt a CA (a
 * wallet whose last buy is older is not a tracker), which is why pruneUntrackedCas
 * alone lets a backfilled `auto:BUY` row outlive its own window. `graceMs` spares a
 * just-added CA, since wallet_watch.py POSTs the CA a round-trip before its BUY.
 * A CA with a stored user tier is never a candidate.
 */
export function pruneTrackedByNone(withinMs: number, graceMs = 10 * 60_000): TrackedCaRow[] {
  const db = getDb();
  const since = Date.now() - withinMs;
  const cutoff = new Date(Date.now() - graceMs).toISOString();
  const doomed = db
    .prepare(
      `SELECT t.* FROM tracked_cas t
        WHERE t.added_at <= ?
          AND ${NOT_TIERED}
          AND NOT EXISTS (SELECT 1 FROM wallet_trades b
                           WHERE b.ca = t.address AND b.side = 'buy' AND b.source = 'watch' AND b.ts >= ?)`,
    )
    .all(cutoff, since) as TrackedCaRow[];
  db.transaction(() => {
    const del = db.prepare('DELETE FROM tracked_cas WHERE id = ?');
    for (const r of doomed) del.run(r.id);
    sweepOrphanedCaData();
  })();
  return doomed;
}

/** One tracked CA joined with the token_state columns the zero-score gate judges on. */
export interface CaScoreGateRow {
  id: string;
  address: string;
  chain: Chain;
  added_at: string;
  note: string;
  symbol: string | null;
  supply: number | null;
  price: number | null;
  nansen_fresh_pct: number | null;
  t100_multiple: number | null;
  genesis_bal: number | null;
  /** Report column only — never part of the delete decision. */
  volume24h: number | null;
}

/**
 * Every tracked CA with its gate-relevant token_state columns (NULL when no row landed yet),
 * EXCEPT those a tracked wallet still HOLDS (user 2026-09-25): a 0/3 symbol a `source='watch'`
 * wallet bought and never sold is not dead, and the CA is on the dashboard because of that
 * wallet. Dropping token_amount to 0 puts it back in the gate's scope on the next sweep.
 * Same holding rule as pruneUntrackedCas, scoped to the row's own (chain, ca).
 * A CA with a stored user tier is never a candidate.
 */
export function listCaScoreGateCandidates(): CaScoreGateRow[] {
  return getDb()
    .prepare(
      `SELECT t.id AS id, t.address AS address, t.chain AS chain, t.added_at AS added_at, t.note AS note,
              s.symbol AS symbol, s.supply AS supply, s.price AS price,
              s.nansen_fresh_pct AS nansen_fresh_pct, s.t100_multiple AS t100_multiple,
              s.genesis_bal AS genesis_bal, s.volume24h AS volume24h
         FROM tracked_cas t
         LEFT JOIN token_state s ON s.ca = t.address AND s.chain = t.chain
        WHERE NOT EXISTS (SELECT 1 FROM wallet_token_state wts
                           WHERE wts.ca = t.address AND wts.chain = t.chain AND wts.token_amount > 0
                             AND EXISTS (SELECT 1 FROM wallet_trades wt
                                          WHERE wt.wallet_id = wts.wallet_id AND wt.ca = wts.ca AND wt.chain = wts.chain
                                            AND wt.side = 'buy' AND wt.source = 'watch'))
          AND ${NOT_TIERED}`,
    )
    .all() as CaScoreGateRow[];
}

/**
 * Batch delete tracked CAs by id in ONE transaction, then run the same orphan
 * token_state cleanup pruneUntrackedCas uses (every token_state reader joins
 * tracked_cas, so a row whose CA is gone is unreachable forever). wallet_trades
 * history is deliberately kept. Returns the number of tracked_cas rows deleted.
 */
export function deleteTrackedCasByIds(ids: readonly string[]): number {
  if (ids.length === 0) return 0;
  const db = getDb();
  let deleted = 0;
  db.transaction(() => {
    const del = db.prepare('DELETE FROM tracked_cas WHERE id = ?');
    for (const id of ids) deleted += del.run(id).changes;
    db.prepare(
      `DELETE FROM token_state WHERE NOT EXISTS (
         SELECT 1 FROM tracked_cas t WHERE t.address = token_state.ca AND t.chain = token_state.chain)`,
    ).run();
  })();
  return deleted;
}

// --- token tiers ------------------------------------------------------------

/** One persisted user tier — keyed by canonical (ca, chain), like tracked_cas. */
export interface TierRow {
  ca: string;
  chain: Chain;
  tier: Tier;
  updated_at: number;
}

export function listTiers(): TierRow[] {
  return getDb().prepare('SELECT * FROM token_tiers').all() as TierRow[];
}

/** Upsert the user-set tier for a tracked CA (api.ts validates the tier value). */
export function setTier(ca: string, chain: Chain, tier: Tier): void {
  getDb()
    .prepare(
      `INSERT INTO token_tiers (ca, chain, tier, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(ca, chain) DO UPDATE SET tier = excluded.tier, updated_at = excluded.updated_at`,
    )
    .run(canonicalCa(ca, chain), chain, tier, Date.now());
}

/** Clearing a tier DELETES the row — absent row = unrated. */
export function deleteTier(ca: string, chain: Chain): void {
  getDb().prepare('DELETE FROM token_tiers WHERE ca = ? AND chain = ?').run(canonicalCa(ca, chain), chain);
}

// --- token_state ----------------------------------------------------------

export function getTokenState(ca: string, chain: Chain): TokenStateRow | undefined {
  return getDb()
    .prepare('SELECT * FROM token_state WHERE ca = ? AND chain = ?')
    .get(canonicalCa(ca, chain), chain) as TokenStateRow | undefined;
}

/**
 * Batched getTokenState for the /api/signals pass (N+1 fix): ONE full-table read
 * keyed `${chain}:${ca}` — the key shape the assembleSignals loop and tierByCa use.
 * Parity contract: tracked_cas addresses are canonical at insert and getTokenState
 * matches `ca = canonicalCa(input)` by string equality, so a lookup with a tracked
 * CA's `${chain}:${address}` resolves to the same row (or miss). Do NOT re-key.
 */
export function allTokenStates(): Map<string, TokenStateRow> {
  const rows = getDb().prepare('SELECT * FROM token_state').all() as TokenStateRow[];
  return new Map(rows.map((r) => [`${r.chain}:${r.ca}`, r]));
}

/** Newest fetched_at across token_state — health endpoint freshness signal. */
export function maxTokenFetchedAt(): number | null {
  const row = getDb().prepare('SELECT MAX(fetched_at) AS latest FROM token_state').get() as {
    latest: number | null;
  };
  return row.latest;
}

// --- holder_snapshots -----------------------------------------------------

export function latestSnapshot(ca: string, chain: Chain): SnapshotRow | undefined {
  return getDb()
    .prepare('SELECT * FROM holder_snapshots WHERE ca = ? AND chain = ? ORDER BY taken_at DESC LIMIT 1')
    .get(ca, chain) as SnapshotRow | undefined;
}

/** Newest snapshot at or before `cutoff` (the "previous" side of the T100 pairing). */
export function snapshotAtOrBefore(ca: string, chain: Chain, cutoff: number): SnapshotRow | undefined {
  return getDb()
    .prepare(
      'SELECT * FROM holder_snapshots WHERE ca = ? AND chain = ? AND taken_at <= ? ORDER BY taken_at DESC LIMIT 1',
    )
    .get(ca, chain, cutoff) as SnapshotRow | undefined;
}

/** All snapshots inside a lookback window, oldest first (balance-range aggregates). */
export function snapshotsSince(ca: string, chain: Chain, since: number): SnapshotRow[] {
  return getDb()
    .prepare('SELECT * FROM holder_snapshots WHERE ca = ? AND chain = ? AND taken_at >= ? ORDER BY taken_at ASC')
    .all(ca, chain, since) as SnapshotRow[];
}

// --- nansen_series cache ----------------------------------------------------

/** Chart cache point — mirrors crawl.ts BalancePoint (JSON round-trip keeps holders/inflow). */
export interface SeriesPoint {
  t: number | string;
  total: number;
  totalUsd?: number;
  holders?: number;
  inflow?: number;
}

export function getNansenSeries(ca: string, chain: Chain, window: string): SeriesPoint[] {
  const row = getDb()
    .prepare('SELECT points_json FROM nansen_series WHERE ca = ? AND chain = ? AND window = ?')
    .get(ca, chain, window) as { points_json: string } | undefined;
  if (!row) return [];
  return JSON.parse(row.points_json);
}

/** Epoch ms when the cached Nansen series was last crawled (undefined = never). */
export function nansenSeriesCachedAt(ca: string, chain: Chain, window: string): number | undefined {
  const row = getDb()
    .prepare('SELECT taken_at FROM nansen_series WHERE ca = ? AND chain = ? AND window = ?')
    .get(ca, chain, window) as { taken_at: number } | undefined;
  return row?.taken_at;
}

export function upsertNansenSeries(ca: string, chain: Chain, window: string, points: SeriesPoint[]): void {
  getDb()
    .prepare(
      `INSERT INTO nansen_series (ca, chain, window, taken_at, points_json) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(ca, chain, window) DO UPDATE SET taken_at = excluded.taken_at, points_json = excluded.points_json`,
    )
    .run(ca, chain, window, Date.now(), JSON.stringify(points));
}

/** Epoch ms of the oldest snapshot for a CA (coverage check) — undefined when none. */
export function earliestSnapshotAt(ca: string, chain: Chain): number | undefined {
  const row = getDb()
    .prepare('SELECT MIN(taken_at) AS t FROM holder_snapshots WHERE ca = ? AND chain = ?')
    .get(ca, chain) as { t: number | null };
  return row.t ?? undefined;
}

/** Retention prune: drop snapshots older than `cutoff` (SNAPSHOT_RETENTION_MS). */
export function deleteSnapshotsBefore(cutoff: number): void {
  getDb().prepare('DELETE FROM holder_snapshots WHERE taken_at < ?').run(cutoff);
}

// --- settings ---------------------------------------------------------------

/** Read one persisted setting (undefined = never set). Callers parse the value. */
export function getSetting(key: string): string | undefined {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

/** Upsert one setting (insert or overwrite by key). */
export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}

// --- seed (mock mode only) -------------------------------------------------

/** Mirrors frontend SEED_WALLETS (src/services/dataStore.ts): CT01..CT08. */
const SEED_WALLETS: WalletInput[] = [
  { address: 'Dk3rJ9sT5vN2qL8mW6xC1bY7hF4gZ5pA9eR2tS6uV8nM', name: 'CT01', tags: ['sniper', 'fresh-wallet'], chain: 'sol', source: 'gmgn' },
  { address: 'Hm7Qp2xL9vN4rT6sW1cJ8dF3gK5bZa2EyUs4jRtVn9Pw', name: 'CT02', tags: ['kol'], chain: 'sol', source: 'nansen' },
  { address: 'Fg9xK2mR7qT4vBn8cLd3Ws6Za1Py5Ue9HjA', name: 'CT03', tags: ['whale'], chain: 'sol', source: 'birdeye' },
  { address: '4Wn8Rt2vK5jP9xQ1mL3sD7fG6hB4yA2cN8eZ5uT3wV1r', name: 'CT04', tags: ['smart-money'], chain: 'sol', source: 'gmgn' },
  { address: 'Bs3Yk7Lm9Qp2XvN4wR8tF1jH6dG5cZ3eA9uS2bV7nM4x', name: 'CT05', tags: ['whale', 'kol'], chain: 'sol', source: 'birdeye' },
  { address: '8nQd4FxR7vJt2Kb9mL5sWc3Yp6Za1Ee4Hg7Du', name: 'CT06', tags: ['smart-money'], chain: 'sol', source: 'manual' },
  { address: '5TjW8nR3vQ9pL2xK7mD4sF6gH1bY5cN8eZ2aU4tV7wR9', name: 'CT07', tags: ['sniper', 'smart-money'], chain: 'sol', source: 'gmgn' },
  { address: 'Cw2Rn9tV5jK3xQ7mL1sP8dF4gZ6hB3yA9cN2eU7vT5wM', name: 'CT08', tags: ['fresh-wallet'], chain: 'sol', source: 'nansen' },
];

/**
 * Seeds demo data (8 wallets + 4 tracked CAs from MOCK_CA_POOL so the mock
 * provider's activity/balances correlate with tracked tokens). No-op outside
 * mock mode and on non-empty DBs.
 */
export function seedIfEmpty(): void {
  if (config.mode !== 'mock') return;
  const db = getDb();
  const walletCount = (db.prepare('SELECT COUNT(*) AS n FROM wallets').get() as { n: number }).n;
  const caCount = (db.prepare('SELECT COUNT(*) AS n FROM tracked_cas').get() as { n: number }).n;
  if (walletCount > 0 || caCount > 0) return;
  const run = db.transaction(() => {
    for (const w of SEED_WALLETS) insertWallet(w);
    for (const address of MOCK_CA_POOL.slice(0, 4)) {
      // entryUsd above the default MIN_USD gate so mock demo signals stay visible.
      insertTrackedCa({ address, chain: 'sol', note: 'mock seed', entryUsd: 60 });
    }
  });
  run();
}
