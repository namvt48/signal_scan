// SQLite persistence (better-sqlite3, WAL). Read-side typed helpers + schema +
// mock seed live here; the write seam lives in ingest.ts; signal aggregation
// queries live in signals.ts. Everything else goes through these helpers.

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { CHAINS, EVM_ADDRESS, EVM_CHAINS, canonicalCa, isSolanaAddress, type Chain } from './shared/chain.js';
import { type Tier } from './shared/tier.js';
import { config } from './config.js';
import { MOCK_CA_POOL } from './providers/mock.js';
import type { AlertMetric, AlertMetricObservation, AlertMetricSnapshot } from './alert-feed.js';

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
  /** User-authored dashboard note; tracking provenance remains in note. */
  user_note: string;
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
  /** X (Twitter) handle (GMGN token/info) — bare handle, validated charset before write. */
  x_handle: string | null;
  /** Epoch ms of successful Fresh ingestion, independent of general fetched_at (not upstream measurement time). */
  fresh_updated_at: number | null;
  /** JSON-encoded {t,value} snapshots from successful existing Fresh metric updates. */
  fresh_history_json: string | null;
  /** JSON-encoded {t,value} samples from successful T100 analytics refreshes. */
  t100_history_json: string | null;
  /** JSON-encoded {t,value} samples of the displayed holder count. */
  holders_history_json: string | null;
  /** JSON-encoded {t,value} market-cap samples from existing metric updates. */
  market_cap_history_json: string | null;
  fetched_at: number | null;
}
export type MetricPollRetryClass = 'legacy_probe' | 'transient' | 'permanent' | null;
export interface MetricPollCacheRow {
  ca: string;
  chain: Chain;
  kind: string;
  last_attempt_at: number;
  response_at: number | null;
  next_allowed_at: number;
  failure_count: number;
  response_json: string | null;
  retry_class: MetricPollRetryClass;
}

export interface MetricPollReservation {
  claimed: boolean;
  row: MetricPollCacheRow | undefined;
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
  user_note TEXT NOT NULL DEFAULT '',
  added_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  entry_usd REAL,
  UNIQUE(address, chain)
);
CREATE TABLE IF NOT EXISTS market_subscriptions (
  caller TEXT NOT NULL CHECK(caller IN ('a', 'b')),
  ca TEXT NOT NULL,
  chain TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (caller, ca, chain)
);
CREATE INDEX IF NOT EXISTS idx_market_subscriptions_expiry ON market_subscriptions(expires_at);
CREATE TABLE IF NOT EXISTS market_alert_delivery_cursors (
  caller TEXT PRIMARY KEY CHECK(caller IN ('a', 'b')),
  acknowledged_id INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO market_alert_delivery_cursors (caller, acknowledged_id) VALUES ('a', 0), ('b', 0);
CREATE TABLE IF NOT EXISTS market_legacy_imports (
  source TEXT PRIMARY KEY,
  imported_at INTEGER NOT NULL
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
  x_handle TEXT,
  fetched_at INTEGER,
  fresh_updated_at INTEGER,
  fresh_history_json TEXT,
  t100_history_json TEXT,
  holders_history_json TEXT,
  market_cap_history_json TEXT,
  PRIMARY KEY (ca, chain)
);
CREATE TABLE IF NOT EXISTS t100_first_observations (
  ca TEXT NOT NULL,
  chain TEXT NOT NULL,
  first_multiple REAL NOT NULL,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (ca, chain)
);
CREATE TABLE IF NOT EXISTS metric_poll_cache (
  ca TEXT NOT NULL,
  chain TEXT NOT NULL,
  kind TEXT NOT NULL,
  last_attempt_at INTEGER NOT NULL,
  response_at INTEGER,
  next_allowed_at INTEGER NOT NULL,
  failure_count INTEGER NOT NULL DEFAULT 0,
  response_json TEXT,
  retry_class TEXT,
  PRIMARY KEY (ca, chain, kind)
);
CREATE INDEX IF NOT EXISTS idx_metric_poll_due ON metric_poll_cache(kind, next_allowed_at);
CREATE TABLE IF NOT EXISTS alert_metric_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ca TEXT NOT NULL,
  chain TEXT NOT NULL,
  metric TEXT NOT NULL CHECK(metric IN ('fresh', 't100', 'trackerBuy')),
  value REAL NOT NULL,
  response_at INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alert_metric_observations_feed ON alert_metric_observations(id);
CREATE TABLE IF NOT EXISTS alert_metric_feed_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  acknowledged_id INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO alert_metric_feed_state (singleton, acknowledged_id) VALUES (1, 0);
CREATE TABLE IF NOT EXISTS shared_alert_metric_import_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  imported_id INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO shared_alert_metric_import_state (singleton, imported_id) VALUES (1, 0);
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

-- Per-CA user tier (S+/S/A+/A/B+/B/P). Absent row = unrated. Keyed like tracked_cas.
CREATE TABLE IF NOT EXISTS token_tiers (
  ca TEXT NOT NULL,
  chain TEXT NOT NULL,
  tier TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (ca, chain)
);

-- Permanently blocked CAs (Pass tombstone). NEVER re-added, NEVER re-rated, NEVER cleared.
CREATE TABLE IF NOT EXISTS blocked_cas (
  address TEXT NOT NULL,
  chain TEXT NOT NULL,
  reason TEXT NOT NULL,
  blocked_at INTEGER NOT NULL,
  PRIMARY KEY (address, chain)
);

-- FOMO watch-list: a second, FOMO-specific set of tracked users beside wallets.
-- Both tables are born here (CREATE TABLE IF NOT EXISTS), so a DB created before
-- this change gains them on the next open() with no ALTER/rebuild — the guard for
-- an existing DB is the IF NOT EXISTS itself (nothing to migrate: no prior shape).
CREATE TABLE IF NOT EXISTS fomo_users (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL,
  user_id TEXT,
  name TEXT NOT NULL DEFAULT '',
  clan TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  wallet_solana TEXT,
  wallet_evm TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fomo_users_handle ON fomo_users(handle);
CREATE INDEX IF NOT EXISTS idx_fomo_users_user_id ON fomo_users(user_id);

-- FOMO buy/sell alerts. event_id is the idempotency key (unique across the
-- 102-alert capture). ca is CANONICALIZED (canonicalCa) so \${chain}:\${ca} keys line up
-- with tracked_cas/allTokenStates. usd_value is TYPE-DEPENDENT: for a buy it is
-- the post-fill position size, for a sell it is signed realised PnL — never sum
-- or compare across types. trade_usd is the USD ACTUALLY TRADED (both directions)
-- and is the only basis for a Buy-$ SUM: usd_value is a STOCK, so summing it
-- multiplies the error once per buy (user 2026-10-01). type CHECK is a loud
-- backstop: perp/thesis/listing are dropped BEFORE insert, so only buy/sell reach.
CREATE TABLE IF NOT EXISTS fomo_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fomo_user_id TEXT NOT NULL REFERENCES fomo_users(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  ca TEXT NOT NULL,
  chain TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('buy','sell')),
  usd_value REAL,
  trade_usd REAL,
  price REAL,
  token TEXT,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'fomo',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fomo_trades_event_id ON fomo_trades(event_id);
CREATE INDEX IF NOT EXISTS idx_fomo_trades_ca_chain_ts ON fomo_trades(ca, chain, ts);
CREATE INDEX IF NOT EXISTS idx_fomo_trades_user_ts ON fomo_trades(fomo_user_id, ts);

-- FOMO user wallets: MANY per user (one trader acts from several wallets across
-- chains). Resolved opportunistically from an alert's txHash (EVM
-- eth_getTransactionByHash.from / Solana SPL-transfer owner) — a FOMO table, NOT
-- wallet state: never joined to/inserted into the wallets table. address is canonicalized
-- (canonicalCa) so EVM lookups fold like the rest of the store.
CREATE TABLE IF NOT EXISTS fomo_user_wallets (
  id TEXT PRIMARY KEY,
  fomo_user_id TEXT NOT NULL REFERENCES fomo_users(id) ON DELETE CASCADE,
  chain TEXT NOT NULL,
  address TEXT NOT NULL,
  source TEXT,
  tx_hash TEXT,
  first_seen_ts INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fomo_user_wallets_identity ON fomo_user_wallets(fomo_user_id, chain, address);
CREATE INDEX IF NOT EXISTS idx_fomo_user_wallets_user_chain ON fomo_user_wallets(fomo_user_id, chain);

-- Per (user, CA, chain) measured holding: Σ token amount across the user's wallets
-- on that chain (token units) and its share of total supply. pct is NULL when
-- supply is unknown/0 (never a fabricated %). ca is canonicalized like fomo_trades.
CREATE TABLE IF NOT EXISTS fomo_holdings (
  fomo_user_id TEXT NOT NULL REFERENCES fomo_users(id) ON DELETE CASCADE,
  ca TEXT NOT NULL,
  chain TEXT NOT NULL,
  wallet TEXT NOT NULL,
  amount REAL,
  pct REAL,
  measured_at INTEGER NOT NULL,
  PRIMARY KEY (fomo_user_id, ca, chain)
);
CREATE INDEX IF NOT EXISTS idx_fomo_holdings_ca_chain ON fomo_holdings(ca, chain);

-- API balance rows are separate from RPC measurements; marker survives empty,
-- incomplete and failed snapshots so scheduled refreshes stay within budget.
CREATE TABLE IF NOT EXISTS fomo_api_holdings (
  fomo_user_id TEXT NOT NULL REFERENCES fomo_users(id) ON DELETE CASCADE,
  ca TEXT NOT NULL,
  chain TEXT NOT NULL,
  amount REAL NOT NULL,
  pct REAL,
  captured_at INTEGER NOT NULL,
  PRIMARY KEY (fomo_user_id, ca, chain)
);
CREATE INDEX IF NOT EXISTS idx_fomo_api_holdings_ca_chain ON fomo_api_holdings(ca, chain);
CREATE TABLE IF NOT EXISTS fomo_api_balance_snapshots (
  fomo_user_id TEXT PRIMARY KEY REFERENCES fomo_users(id) ON DELETE CASCADE,
  checked_at INTEGER NOT NULL,
  captured_at INTEGER,
  complete INTEGER NOT NULL,
  truncated INTEGER NOT NULL,
  available INTEGER NOT NULL
);

-- Per (user, CA, chain) position straight from the FOMO API — the AUTHORITATIVE
-- spend. cost_basis_usd is the money actually paid, where fomo_trades.usd_value is
-- the position's mark-to-market VALUE (a stock): reading the latter as money made
-- the dash report a 59.8K spend as 70.7K (user 2026-10-01). amount/price_usd come
-- from the same call and back the holding column. ca is canonicalized (fomo_trades).
CREATE TABLE IF NOT EXISTS fomo_positions (
  fomo_user_id TEXT NOT NULL REFERENCES fomo_users(id) ON DELETE CASCADE,
  ca TEXT NOT NULL,
  chain TEXT NOT NULL,
  trade_id TEXT,
  status TEXT,
  amount REAL,
  cost_basis_usd REAL,
  avg_entry_price REAL,
  price_usd REAL,
  realized_pnl_usd REAL,
  unrealized_pnl_usd REAL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (fomo_user_id, ca, chain)
);
CREATE INDEX IF NOT EXISTS idx_fomo_positions_ca_chain ON fomo_positions(ca, chain);

-- Last successful user-level positions refresh; enforces the on-alert cooldown across
-- restarts, including users whose response contained no positions.
CREATE TABLE IF NOT EXISTS fomo_position_snapshots (
  fomo_user_id TEXT PRIMARY KEY REFERENCES fomo_users(id) ON DELETE CASCADE,
  checked_at INTEGER NOT NULL
);

-- Zero-holding tracking: records when a wallet (instance A) or FOMO user (instance B)
-- first hit 0% holding of a CA. After 24h at zero holding, the member is removed from Tracked by / FOMO by.
CREATE TABLE IF NOT EXISTS zero_holdings (
  member_type TEXT NOT NULL CHECK(member_type IN ('wallet', 'fomo')),
  member_id TEXT NOT NULL,
  ca TEXT NOT NULL,
  chain TEXT NOT NULL,
  zero_at INTEGER NOT NULL,
  PRIMARY KEY (member_type, member_id, ca, chain)
);
CREATE INDEX IF NOT EXISTS idx_zero_holdings_lookup ON zero_holdings(member_type, ca, chain, zero_at);
`;

let instance: Database.Database | null = null;

let sharedMarketAttached = false;
export function open(path: string, sharedMarketPath = ''): void {
  sharedMarketAttached = sharedMarketPath !== '';
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  instance = new Database(path);
  instance.pragma('journal_mode = WAL');
  instance.pragma('busy_timeout = 5000');
  instance.pragma('synchronous = NORMAL');
  // better-sqlite3 leaves foreign_keys OFF by default — the wallet FK cascades
  // (delete wallet -> trades/balances cleaned) depend on this.
  instance.pragma('foreign_keys = ON');
  instance.exec(SCHEMA);
  const metricPollCols = (instance.pragma('table_info(metric_poll_cache)') as { name: string }[]).map((c) => c.name);
  if (!metricPollCols.includes('retry_class')) instance.exec('ALTER TABLE metric_poll_cache ADD COLUMN retry_class TEXT');
  instance.exec(`
    CREATE TABLE IF NOT EXISTS token_avatar_cache (
      chain TEXT NOT NULL,
      ca TEXT NOT NULL,
      source_url TEXT,
      attempt_url TEXT,
      retry_at INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0,
      image BLOB NOT NULL,
      PRIMARY KEY (chain, ca)
    );
  `);
  instance.exec(`
    CREATE TABLE IF NOT EXISTS fomo_api_request_state (
      fomo_user_id TEXT NOT NULL,
      endpoint TEXT NOT NULL CHECK(endpoint IN ('positions', 'swaps')),
      last_attempt_at INTEGER NOT NULL,
      next_eligible_at INTEGER NOT NULL,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_outcome TEXT NOT NULL,
      PRIMARY KEY (fomo_user_id, endpoint),
      FOREIGN KEY (fomo_user_id) REFERENCES fomo_users(id) ON DELETE CASCADE
    );
  `);
  const alertTable = instance.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'alert_metric_observations'",
  ).get() as { sql: string } | undefined;
  if (alertTable !== undefined && !alertTable.sql.includes("'trackerBuy'")) {
    const migrateAlertMetric = instance.transaction(() => {
      const oldSequence = instance!.prepare(
        "SELECT seq FROM sqlite_sequence WHERE name = 'alert_metric_observations'",
      ).get() as { seq: number } | undefined;
      const oldMaxId = instance!.prepare(
        'SELECT COALESCE(MAX(id), 0) AS id FROM alert_metric_observations',
      ).get() as { id: number };
      const highWatermark = Math.max(oldSequence?.seq ?? 0, oldMaxId.id);
      instance!.exec(`
        DROP INDEX IF EXISTS idx_alert_metric_observations_feed;
        ALTER TABLE alert_metric_observations RENAME TO alert_metric_observations_old;
        CREATE TABLE alert_metric_observations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ca TEXT NOT NULL,
          chain TEXT NOT NULL,
          metric TEXT NOT NULL CHECK(metric IN ('fresh', 't100', 'trackerBuy')),
          value REAL NOT NULL,
          response_at INTEGER NOT NULL,
          snapshot_json TEXT NOT NULL
        );
        INSERT INTO alert_metric_observations SELECT * FROM alert_metric_observations_old;
        DROP TABLE alert_metric_observations_old;
        CREATE INDEX idx_alert_metric_observations_feed ON alert_metric_observations(id);
      `);
      const newSequence = instance!.prepare(
        "SELECT seq FROM sqlite_sequence WHERE name = 'alert_metric_observations'",
      ).get() as { seq: number } | undefined;
      if (highWatermark > (newSequence?.seq ?? 0)) {
        if (newSequence === undefined) {
          instance!.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run('alert_metric_observations', highWatermark);
        } else {
          instance!.prepare('UPDATE sqlite_sequence SET seq = ? WHERE name = ?').run(highWatermark, 'alert_metric_observations');
        }
      }
    });
    migrateAlertMetric();
  }
  // Migration for DBs created before the balance-range columns (idempotent).
  const cols = (instance.pragma('table_info(token_state)') as { name: string }[]).map((c) => c.name);
  for (const col of ['vol_1h', 'vol_24h_prev', 'bal_peak_24h', 'bal_trough_24h', 'bal_peak_7d', 'bal_trough_7d', 'bal_peak_30d', 'bal_trough_30d', 'fresh_rate', 'nansen_holders', 'nansen_fresh_pct', 'nansen_t100_pct', 'nansen_median_usd', 't100_multiple', 'genesis_bal']) {
    if (!cols.includes(col)) instance.exec(`ALTER TABLE token_state ADD COLUMN ${col} REAL`);
  }
  if (!cols.includes('fresh_updated_at')) instance.exec('ALTER TABLE token_state ADD COLUMN fresh_updated_at INTEGER');
  if (!cols.includes('fresh_history_json')) instance.exec('ALTER TABLE token_state ADD COLUMN fresh_history_json TEXT');
  if (!cols.includes('t100_history_json')) instance.exec('ALTER TABLE token_state ADD COLUMN t100_history_json TEXT');
  if (!cols.includes('market_cap_history_json')) instance.exec('ALTER TABLE token_state ADD COLUMN market_cap_history_json TEXT');
  if (!cols.includes('holders_history_json')) instance.exec('ALTER TABLE token_state ADD COLUMN holders_history_json TEXT');

  // deployed_at/anchor_at store epoch ms — INTEGER affinity (separate from the REAL list above).
  if (!cols.includes('deployed_at')) instance.exec('ALTER TABLE token_state ADD COLUMN deployed_at INTEGER');
  if (!cols.includes('anchor_at')) instance.exec('ALTER TABLE token_state ADD COLUMN anchor_at INTEGER');
  if (!cols.includes('vol_24h_prev_at')) instance.exec('ALTER TABLE token_state ADD COLUMN vol_24h_prev_at INTEGER');
  // symbol is the ticker string — TEXT affinity.
  if (!cols.includes('symbol')) instance.exec('ALTER TABLE token_state ADD COLUMN symbol TEXT');
  // icon_url is the validated DexScreener logo URL — TEXT affinity too.
  if (!cols.includes('icon_url')) instance.exec('ALTER TABLE token_state ADD COLUMN icon_url TEXT');
  // x_handle is the token's bare X handle (GMGN token/info) — TEXT affinity.
  if (!cols.includes('x_handle')) instance.exec('ALTER TABLE token_state ADD COLUMN x_handle TEXT');
  // Auto-migrate any tier 'P' into blocked_cas (idempotent)
  instance.exec(`
    INSERT OR IGNORE INTO blocked_cas (address, chain, reason, blocked_at)
    SELECT ca, chain, 'pass', updated_at FROM token_tiers WHERE tier = 'P';
  `);
  // tracked_cas.entry_usd (USD entry size — the minUsd signals gate), nullable.
  const trackedCols = (instance.pragma('table_info(tracked_cas)') as { name: string }[]).map((c) => c.name);
  if (!trackedCols.includes('entry_usd')) instance.exec('ALTER TABLE tracked_cas ADD COLUMN entry_usd REAL');
  if (!trackedCols.includes('user_note')) {
    const migrationDb = instance;
    migrationDb.transaction(() => {
      migrationDb.exec("ALTER TABLE tracked_cas ADD COLUMN user_note TEXT NOT NULL DEFAULT ''");
      // Preserve saved text and keep legacy scanner labels only as tracking provenance.
      migrationDb.exec("UPDATE tracked_cas SET user_note = note WHERE note NOT IN ('wallet-trade', 'fomo') AND note NOT GLOB 'auto:BUY by *' AND note NOT GLOB 'auto:SELL by *'");
    })();
  }
  // Repair labels copied by the first user-note migration, once only. Edited
  // notes differ from provenance; later explicit saves must survive restarts.
  if (getSetting('userNoteAutoLabelsRepaired') !== '1') {
    const migrationDb = instance;
    migrationDb.transaction(() => {
      migrationDb.prepare(`UPDATE tracked_cas SET user_note = ''
        WHERE user_note = note AND (note GLOB 'auto:BUY by *' OR note GLOB 'auto:SELL by *')`).run();
      setSetting('userNoteAutoLabelsRepaired', '1');
    })();
  }
  // A FOMO user known only by handle shows that handle as its name (user 2026-10-01):
  // rows created before this rule carry an empty name. Idempotent (0 rows after run 1).
  instance.exec("UPDATE fomo_users SET name = handle WHERE name = ''");
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
  // fomo_trades.trade_usd — the USD actually traded. Absent on ~72% of alerts (the
  // feed resolves it on-chain), so it is nullable and Buy-$ falls back (user 2026-10-01).
  const fomoTradeCols = (instance.pragma('table_info(fomo_trades)') as { name: string }[]).map((c) => c.name);
  if (!fomoTradeCols.includes('trade_usd')) instance.exec('ALTER TABLE fomo_trades ADD COLUMN trade_usd REAL');
  // fomo_users.tags — parity with wallets.tags (user 2026-10-02): a JSON array of
  // display-only labels the FE renders as chips (and 'Unicon' → rainbow name).
  // Never filters/routes; DEFAULT '[]' so pre-existing rows read as untagged.
  const fomoUserCols = (instance.pragma('table_info(fomo_users)') as { name: string }[]).map((c) => c.name);
  if (!fomoUserCols.includes('tags')) {
    instance.exec("ALTER TABLE fomo_users ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
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
  instance.exec('CREATE INDEX IF NOT EXISTS idx_wallet_token_state_chain_ca ON wallet_token_state(chain, ca)');
  // Created after the wallet-table rebuild: on a pre-T3 database the legacy
  // wallet_trades has no `chain` column, so these cannot live in SCHEMA (exec'd
  // before migration). Keeping them here covers both fresh and migrated shapes.
  instance.exec(`
    CREATE INDEX IF NOT EXISTS idx_trades_wallet_ca_side ON wallet_trades(wallet_id, chain, ca, side, source);
    CREATE INDEX IF NOT EXISTS idx_trades_source_ts ON wallet_trades(source, ts);
    CREATE INDEX IF NOT EXISTS idx_trades_wallet_ca_side_src ON wallet_trades(wallet_id, ca, side, source);
    CREATE INDEX IF NOT EXISTS idx_trades_wallet_chain_ca_src_ts ON wallet_trades(wallet_id, chain, ca, source, ts);
  `);
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
  // System deploy anchor (plan setup-fill-on-add T5): setupSweep cadence phase
  // counts from THIS instant, not from process boot — restarts re-phase to the
  // same boundaries instead of drifting (the old i*20s stagger). Written once,
  // never overwritten: settings survives restarts AND table resets, so the
  // cadence phase is stable across both.
  if (getSetting('systemDeployAt') === undefined) setSetting('systemDeployAt', String(Date.now()));
  if (config.showFomo) {
    // Keep historical rows, but permanently stop them entering B's active CA queue.
    instance.prepare("UPDATE tracked_cas SET status = 'inactive' WHERE chain = 'sol' AND status != 'inactive'").run();
    backfillFomoEvmWalletGroups(instance);
  }
  if (sharedMarketPath !== '') {
    instance.prepare('ATTACH DATABASE ? AS market_data').run(sharedMarketPath);
    instance.exec(`
      CREATE TEMP VIEW token_state AS SELECT * FROM market_data.token_state;
      CREATE TEMP VIEW metric_poll_cache AS SELECT * FROM market_data.metric_poll_cache;
      CREATE TEMP VIEW holder_snapshots AS SELECT * FROM market_data.holder_snapshots;
      CREATE TEMP VIEW nansen_series AS SELECT * FROM market_data.nansen_series;
    `);
  }
}
function backfillFomoEvmWalletGroups(db: Database.Database): void {
  const rows = db
    .prepare(`SELECT * FROM wallets WHERE chain IN (${EVM_CHAINS.map(() => '?').join(',')})
      ORDER BY CASE chain WHEN 'base' THEN 0 WHEN 'bsc' THEN 1 ELSE 2 END`)
    .all(...EVM_CHAINS) as WalletRow[];
  const groups = new Map<string, WalletRow[]>();
  for (const row of rows) {
    if (!EVM_ADDRESS.test(row.address)) continue;
    const key = row.address.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  if (groups.size === 0) return;
  const insert = db.prepare(
    'INSERT INTO wallets (id, address, name, tags, chain, source, clan) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  db.transaction(() => {
    for (const [address, members] of groups) {
      const template = members[0];
      if (!template) continue;
      const present = new Set(members.map((row) => row.chain));
      for (const chain of EVM_CHAINS) {
        if (present.has(chain)) continue;
        insert.run(randomUUID(), address, template.name, template.tags, chain, template.source, template.clan ?? '');
      }
    }
  })();
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
  const sql = config.showFomo
    ? "SELECT * FROM wallets WHERE chain != 'sol' ORDER BY name"
    : 'SELECT * FROM wallets ORDER BY name';
  return getDb().prepare(sql).all() as WalletRow[];
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

export function findEvmWalletGroup(address: string): WalletRow[] {
  return getDb()
    .prepare(`SELECT * FROM wallets WHERE lower(address) = ? AND chain IN (${EVM_CHAINS.map(() => '?').join(',')})
      ORDER BY CASE chain WHEN 'base' THEN 0 WHEN 'bsc' THEN 1 ELSE 2 END`)
    .all(address.trim().toLowerCase(), ...EVM_CHAINS) as WalletRow[];
}

type EvmWalletInput = Omit<WalletInput, 'chain'>;

function insertEvmWalletRow(db: Database.Database, input: EvmWalletInput, address: string, chain: Chain): WalletRow {
  const row: WalletRow = {
    id: randomUUID(),
    address,
    name: input.name,
    tags: JSON.stringify(input.tags),
    chain,
    source: input.source,
    clan: input.clan ?? '',
  };
  db.prepare('INSERT INTO wallets (id, address, name, tags, chain, source, clan) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(row.id, row.address, row.name, row.tags, row.chain, row.source, row.clan);
  return row;
}

function insertEvmWalletRows(db: Database.Database, input: EvmWalletInput, address: string): WalletRow[] {
  return EVM_CHAINS.map((chain) => insertEvmWalletRow(db, input, address, chain));
}

/** Atomically add one EVM address to all supported networks; undefined means duplicate. */
export function insertEvmWalletGroup(input: EvmWalletInput): WalletRow[] | undefined {
  const address = input.address.trim().toLowerCase();
  if (!EVM_ADDRESS.test(address)) throw new Error('invalid EVM address');
  const db = getDb();
  return db.transaction(() => {
    if (findEvmWalletGroup(address).length) return undefined;
    return insertEvmWalletRows(db, input, address);
  })();
}

/** Update shared metadata/address for all chain members without changing wallet IDs. */
export function updateEvmWalletGroupById(
  id: string,
  input: EvmWalletInput,
): WalletRow[] | 'duplicate' | undefined {
  const db = getDb();
  const current = getWallet(id);
  if (!current || current.chain === 'sol') return undefined;
  const address = input.address.trim().toLowerCase();
  if (!EVM_ADDRESS.test(address)) throw new Error('invalid EVM address');
  const previous = current.address.toLowerCase();
  return db.transaction(() => {
    if (address !== previous && findEvmWalletGroup(address).length) return 'duplicate';
    db.prepare(`UPDATE wallets SET address = ?, name = ?, tags = ?, source = ?, clan = ?
      WHERE lower(address) = ? AND chain IN (${EVM_CHAINS.map(() => '?').join(',')})`)
      .run(address, input.name, JSON.stringify(input.tags), input.source, input.clan ?? '', previous, ...EVM_CHAINS);
    const existing = findEvmWalletGroup(address);
    const present = new Set(existing.map((row) => row.chain));
    for (const chain of EVM_CHAINS) {
      if (!present.has(chain)) insertEvmWalletRow(db, input, address, chain);
    }
    return findEvmWalletGroup(address);
  })();
}

/** Delete the whole EVM group; wallet trade/holding rows cascade by wallet id. */
export function deleteEvmWalletGroupById(id: string): boolean {
  const current = getWallet(id);
  if (!current || current.chain === 'sol') return false;
  getDb().prepare(`DELETE FROM wallets WHERE lower(address) = ? AND chain IN (${EVM_CHAINS.map(() => '?').join(',')})`)
    .run(current.address.toLowerCase(), ...EVM_CHAINS);
  return true;
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
      if (config.showFomo && r.chain === 'sol') {
        skipped.push({ row: i, reason: 'Solana wallets are disabled on FOMO instance' });
        return;
      }
      if (!address) {
        skipped.push({ row: i, reason: 'address is empty' });
        return;
      }
      if (r.chain === 'evm') {
        if (!config.showFomo) {
          skipped.push({ row: i, reason: 'invalid chain "evm" (expected one of sol, base, bsc, robinhood)' });
          return;
        }
        const canonicalAddress = address.toLowerCase();
        if (!EVM_ADDRESS.test(canonicalAddress)) {
          skipped.push({ row: i, reason: 'invalid EVM address (expected 0x + 40 hex characters)' });
          return;
        }
        if (findEvmWalletGroup(canonicalAddress).length) {
          skipped.push({ row: i, reason: 'duplicate address' });
          return;
        }
        insertEvmWalletRows(db, {
          address: canonicalAddress,
          name: r.name.trim(),
          tags: r.tags,
          source: r.source.trim(),
          clan: (r.clan ?? '').trim(),
        }, canonicalAddress);
        added += 1;
        return;
      }
      if (!isChain(r.chain)) {
        skipped.push({ row: i, reason: `invalid chain "${r.chain}" (expected one of ${CHAINS.join(', ')})` });
        return;
      }
      // A non-base58 sol address poisons the wallet-watch ws shard (Helius
      // rejects the WHOLE logsSubscribe batch) — keep it out of the DB.
      if (r.chain === 'sol' && !isSolanaAddress(address)) {
        skipped.push({ row: i, reason: 'invalid sol address (base58, 32 bytes)' });
        return;
      }
      const res = ins.run(randomUUID(), canonicalCa(address, r.chain), r.name.trim(), JSON.stringify(r.tags), r.chain, r.source.trim(), (r.clan ?? '').trim());
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

export function listTrackedCas(includeInactive = false): TrackedCaRow[] {
  if (config.showFomo) {
    const activeFilter = includeInactive ? '' : " AND status != 'inactive'";
    return getDb().prepare(`SELECT * FROM tracked_cas WHERE chain != 'sol'${activeFilter} ORDER BY added_at DESC`).all() as TrackedCaRow[];
  }
  if (includeInactive) {
    return getDb().prepare('SELECT * FROM tracked_cas ORDER BY added_at DESC').all() as TrackedCaRow[];
  }
  return getDb().prepare("SELECT * FROM tracked_cas WHERE status != 'inactive' ORDER BY added_at DESC").all() as TrackedCaRow[];
}

/** A poll target — the (address, chain) pair the sweeps actually need. */
export interface CaTarget {
  address: string;
  chain: Chain;
}

/** Replace one instance's active CA subscription snapshot in the gateway database. */
export function replaceMarketSubscriptions(
  caller: 'a' | 'b',
  targets: readonly CaTarget[],
  now = Date.now(),
  ttlMs = 90_000,
): CaTarget[] {
  const db = getDb();
  const clean = [...new Map(targets.map((target) => {
    const address = canonicalCa(target.address, target.chain);
    return [`${target.chain}:${address}`, { address, chain: target.chain }] as const;
  })).values()];
  const replace = db.transaction(() => {
    db.prepare('DELETE FROM market_subscriptions WHERE expires_at <= ?').run(now);
    db.prepare('DELETE FROM market_subscriptions WHERE caller = ?').run(caller);
    const insert = db.prepare(
      'INSERT INTO market_subscriptions (caller, ca, chain, expires_at) VALUES (?, ?, ?, ?)',
    );
    for (const target of clean) insert.run(caller, target.address, target.chain, now + ttlMs);
    return reconcileMarketTrackedCas(now);
  });
  return replace();
}

/** Expire disconnected callers and return newly active tokens for an early poll. */
export function expireMarketSubscriptions(now = Date.now()): CaTarget[] {
  const db = getDb();
  return db.transaction(() => {
    db.prepare('DELETE FROM market_subscriptions WHERE expires_at <= ?').run(now);
    return reconcileMarketTrackedCas(now);
  })();
}

function reconcileMarketTrackedCas(now: number): CaTarget[] {
  const db = getDb();
  const desired = db.prepare(
    'SELECT DISTINCT ca AS address, chain FROM market_subscriptions WHERE expires_at > ?',
  ).all(now) as CaTarget[];
  const current = db.prepare(
    "SELECT address, chain FROM tracked_cas WHERE note = 'shared-market'",
  ).all() as CaTarget[];
  const currentKeys = new Set(current.map((target) => `${target.chain}:${target.address}`));
  const desiredKeys = new Set(desired.map((target) => `${target.chain}:${target.address}`));
  const added: CaTarget[] = [];
  const insert = db.prepare(
    `INSERT INTO tracked_cas (id, address, chain, note, added_at, status)
     VALUES (?, ?, ?, 'shared-market', ?, 'queued')
     ON CONFLICT(address, chain) DO UPDATE SET status = 'queued'`,
  );
  for (const target of desired) {
    const key = `${target.chain}:${target.address}`;
    if (!currentKeys.has(key)) {
      insert.run(randomUUID(), target.address, target.chain, new Date(now).toISOString());
      added.push(target);
    }
  }
  const remove = db.prepare("DELETE FROM tracked_cas WHERE address = ? AND chain = ? AND note = 'shared-market'");
  for (const target of current) {
    if (!desiredKeys.has(`${target.chain}:${target.address}`)) remove.run(target.address, target.chain);
  }
  return added;
}

/**
 * Tracked CAs whose essential core never landed. `supply` is the write-once LF
 * denominator, so NULL means the essential pass has not reached the CA yet — it
 * paces the whole queue, so a fresh CA would stay blank for hours. No age window:
 * a CA keeps being re-asked each gap tick until its core lands; too-new mints are
 * filtered by the caller (isTooNewToken).
 */
export function listCaTargetsMissingEssential(): CaTarget[] {
  return getDb()
    .prepare(
      `SELECT t.address AS address, t.chain AS chain
         FROM tracked_cas t
         LEFT JOIN token_state s ON s.chain = t.chain AND s.ca = t.address
        WHERE t.status != 'inactive' AND s.supply IS NULL
        ORDER BY t.added_at DESC`,
    )
    .all() as CaTarget[];
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
        WHERE t.status != 'inactive' AND (s.symbol IS NULL OR trim(s.symbol) = '') AND t.added_at >= ?
        ORDER BY t.added_at DESC`,
    )
    .all(since) as CaTarget[];
}

/**
 * Active tracked CAs without an icon. Eligibility never expires: missing logos
 * may become available upstream later, and metric_poll_cache controls retry cadence.
 */
export function listCaTargetsMissingIcon(): CaTarget[] {
  return getDb()
    .prepare(
      `SELECT t.address AS address, t.chain AS chain
         FROM tracked_cas t
         LEFT JOIN token_state s ON s.chain = t.chain AND s.ca = t.address
        WHERE t.status != 'inactive' AND (s.icon_url IS NULL OR trim(s.icon_url) = '')
        ORDER BY t.added_at DESC`,
    )
    .all() as CaTarget[];
}

export function findTrackedCa(address: string, chain: Chain, includeInactive = false): TrackedCaRow | undefined {
  const canon = canonicalCa(address, chain);
  if (includeInactive) {
    return getDb()
      .prepare('SELECT * FROM tracked_cas WHERE address = ? AND chain = ?')
      .get(canon, chain) as TrackedCaRow | undefined;
  }
  return getDb()
    .prepare("SELECT * FROM tracked_cas WHERE address = ? AND chain = ? AND status != 'inactive'")
    .get(canon, chain) as TrackedCaRow | undefined;
}

/** Update a user note without overwriting the chain-scoped tracking provenance. */
export function setTrackedCaNote(address: string, chain: Chain, note: string): TrackedCaRow | undefined {
  const ca = canonicalCa(address, chain);
  const result = getDb().prepare('UPDATE tracked_cas SET user_note = ? WHERE address = ? AND chain = ?').run(note, ca, chain);
  return result.changes ? findTrackedCa(ca, chain, true) : undefined;
}

export function insertTrackedCa(input: TrackedCaInput): TrackedCaRow {
  const address = canonicalCa(input.address, input.chain);
  if (isPassTier(address, input.chain)) {
    throw new Error(`cannot track CA ${address} on ${input.chain}: tier is Pass`);
  }
  const existing = findTrackedCa(address, input.chain, true);
  if (existing) {
    if (existing.status === 'inactive') {
      return reactivateTrackedCa(address, input.chain, input.note, input.entryUsd) ?? existing;
    }
    return existing;
  }
  const row: TrackedCaRow = {
    id: randomUUID(),
    address,
    chain: input.chain,
    note: input.note,
    user_note: '',
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
 * Fills entry_usd for a CA whose entry value was unknown at insert time (NULL),
 * or upgrades a sub-threshold entry (< minUsd) when a larger trade arrives.
 * A qualifying entry (>= minUsd) is a historical fact and is never overwritten.
 */
export function setTrackedCaEntryUsd(
  address: string,
  chain: Chain,
  usd: number,
  minUsd: number = 0,
): TrackedCaRow | undefined {
  getDb()
    .prepare(
      `UPDATE tracked_cas
       SET entry_usd = ?
       WHERE address = ? AND chain = ?
         AND (entry_usd IS NULL OR (entry_usd < ? AND ? > entry_usd))`,
    )
    .run(usd, canonicalCa(address, chain), chain, minUsd, usd);
  return findTrackedCa(address, chain, true);
}

/** Reactivate an inactive tracked CA when new buy inflow arrives. */
export function reactivateTrackedCa(
  address: string,
  chain: Chain,
  note?: string,
  entryUsd?: number,
): TrackedCaRow | undefined {
  const db = getDb();
  if (config.showFomo && chain === 'sol') return undefined;
  const canon = canonicalCa(address, chain);
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE tracked_cas
       SET status = 'queued',
           added_at = ?,
           note = COALESCE(?, note),
           entry_usd = COALESCE(?, entry_usd)
     WHERE address = ? AND chain = ?
  `).run(now, note ?? null, entryUsd ?? null, canon, chain);
  return findTrackedCa(canon, chain, true);
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
const NOT_TIERED = `NOT EXISTS (SELECT 1 FROM token_tiers tt WHERE tt.ca = t.address AND tt.chain = t.chain AND tt.tier != 'P')`;
/**
 * "A FOMO user BOUGHT this CA inside the window" — a BUY, never a lone SELL. This
 * mirrors the dash's own membership rule exactly (signals.fomoUserStatsByCa lists a
 * user only on a type='buy' row), so a CA whose captured alerts are ALL sells has no
 * member to display and renders `none` in the FOMO column — a row with no signal,
 * pruned as noise (user 2026-10-01). A SELL therefore does NOT spare a CA; the
 * earlier buy-OR-sell version kept 29 sell-only CAs that read `none` on the dash.
 * Reads tracked_cas via the alias `t`; binds ONE window param, like the wallet clauses.
 */
const FOMO_ACTIVE = `EXISTS (SELECT 1 FROM fomo_trades f
                      WHERE f.ca = t.address AND f.chain = t.chain
                        AND f.type = 'buy' AND f.ts >= ?)`;

/**
 * Deletes CA-scoped market data whose CA is no longer tracked. EVERY prune path
 * must call this: a prune that removes the tracked_cas row but skips this leaves
 * the CA's token_state and (worse) wallet_token_state rows behind. The latter has
 * no ca foreign key, so nothing cascades — 303 orphan rows had accumulated by
 * 2026-09-24, each one widening the unindexed `WHERE ca = ?` scans.
 */
function sweepOrphanedCaData(): void {
  const db = getDb();
  if (!sharedMarketAttached) {
    // In shared mode token_state is a gateway-owned TEMP VIEW, not an API-owned table.
    db.prepare(
      `DELETE FROM token_state WHERE NOT EXISTS (
         SELECT 1 FROM tracked_cas t WHERE t.address = token_state.ca AND t.chain = token_state.chain)`,
    ).run();
  }
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
 * A FOMO user's BUY inside `windowMs` also keeps the CA (user 2026-10-01): the FOMO
 * dash carries no wallet watch data, so the wallet clauses alone would drain it.
 * A lone SELL does NOT (same date, second call): the dash lists members off BUY rows
 * only, so a sell-only CA shows `none` and is noise.
 */
export function pruneUntrackedCas(windowMs: number, now: number = Date.now()): TrackedCaRow[] {
  const db = getDb();
  const since = now - windowMs;
  const cutoff = new Date(since).toISOString();

  // Rule 1: Pass tier / blocked_cas (hard delete and data wipe)
  const passDoomed = db
    .prepare(
      `SELECT t.* FROM tracked_cas t
        WHERE EXISTS (SELECT 1 FROM token_tiers tt WHERE tt.ca = t.address AND tt.chain = t.chain AND tt.tier = 'P')
           OR EXISTS (SELECT 1 FROM blocked_cas b WHERE b.address = t.address AND b.chain = t.chain)`,
    )
    .all() as TrackedCaRow[];

  // Rule 2: Older than 48h and no new buy inflow in the last 48h (soft deactivate, NEVER wiped!)
  const inactiveDoomed = db
    .prepare(
      `SELECT t.* FROM tracked_cas t
        WHERE t.added_at <= ?
          AND t.status != 'inactive'
          AND ${NOT_TIERED}
          AND NOT EXISTS (SELECT 1 FROM wallet_trades w
                           WHERE w.ca = t.address AND w.chain = t.chain AND w.side = 'buy' AND w.ts >= ?)
          AND NOT ${FOMO_ACTIVE}`,
    )
    .all(cutoff, since, since) as TrackedCaRow[];

  db.transaction(() => {
    // Pass tier: hard delete and sweep
    const del = db.prepare('DELETE FROM tracked_cas WHERE id = ?');
    for (const r of passDoomed) del.run(r.id);
    if (passDoomed.length > 0) sweepOrphanedCaData();

    // 48h no inflow: soft deactivate ONLY. Keep all data intact!
    const deact = db.prepare("UPDATE tracked_cas SET status = 'inactive' WHERE id = ?");
    for (const r of inactiveDoomed) deact.run(r.id);
  })();
  return [...passDoomed, ...inactiveDoomed];
}

/**
 * Delete every tracked CA no wallet is `Tracked by` — exactly the trackedWalletStats
 * rule: a `source='watch'` BUY inside `withinMs`. Holding does NOT exempt a CA (a
 * wallet whose last buy is older is not a tracker), which is why pruneUntrackedCas
 * alone lets a backfilled `auto:BUY` row outlive its own window. `graceMs` spares a
 * just-added CA, since wallet_watch.py POSTs the CA a round-trip before its BUY.
 * A CA with a stored user tier is never a candidate.
 *
 * A FOMO user's BUY inside `withinMs` also counts as `Tracked by` (user 2026-10-01):
 * a FOMO alert enqueues the CA (api.ts) so it shows on the dash, but it has no wallet
 * watch-buy by construction — without this the CA is deleted one sweep later. BUY only:
 * a lone SELL leaves the dash's FOMO column reading `none` (membership is buy-based), so
 * a sell must NOT spare the CA — 29 such sell-only rows were pruning as noise (2026-10-01).
 */
export function pruneTrackedByNone(withinMs: number, graceMs = 10 * 60_000): TrackedCaRow[] {
  const db = getDb();
  const since = Date.now() - withinMs;
  const cutoff = new Date(Date.now() - graceMs).toISOString();

  // 1. Pass tier CAs (hard delete + blocked_cas tombstone + sweep)
  const passDoomed = db
    .prepare(
      `SELECT t.* FROM tracked_cas t
        WHERE EXISTS (SELECT 1 FROM token_tiers tt WHERE tt.ca = t.address AND tt.chain = t.chain AND tt.tier = 'P')
           OR EXISTS (SELECT 1 FROM blocked_cas b WHERE b.address = t.address AND b.chain = t.chain)`,
    )
    .all() as TrackedCaRow[];

  // 2. Untiered active CAs with no tracker (soft deactivate, NEVER wiped!)
  const inactiveDoomed = db
    .prepare(
      `SELECT t.* FROM tracked_cas t
        WHERE t.added_at <= ?
          AND t.status != 'inactive'
          AND ${NOT_TIERED}
          AND NOT EXISTS (SELECT 1 FROM wallet_trades b
                           WHERE b.ca = t.address AND b.side = 'buy' AND b.source = 'watch' AND b.ts >= ?)
          AND NOT ${FOMO_ACTIVE}`,
    )
    .all(cutoff, since, since) as TrackedCaRow[];

  db.transaction(() => {
    // Pass tier: hard delete and sweep
    const del = db.prepare('DELETE FROM tracked_cas WHERE id = ?');
    for (const r of passDoomed) del.run(r.id);
    if (passDoomed.length > 0) sweepOrphanedCaData();

    // Untracked: soft deactivate ONLY. Keep all data intact!
    const deact = db.prepare("UPDATE tracked_cas SET status = 'inactive' WHERE id = ?");
    for (const r of inactiveDoomed) deact.run(r.id);
  })();

  return [...passDoomed, ...inactiveDoomed];
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
          AND t.status != 'inactive'
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
/**
 * Batch deactivate tracked CAs by id in ONE transaction (status = 'inactive').
 * Data in token_state, wallet_trades, etc. is PRESERVED completely.
 */
export function deactivateTrackedCasByIds(ids: readonly string[]): number {
  if (ids.length === 0) return 0;
  const db = getDb();
  let deactivated = 0;
  db.transaction(() => {
    const upd = db.prepare("UPDATE tracked_cas SET status = 'inactive' WHERE id = ?");
    for (const id of ids) deactivated += upd.run(id).changes;
  })();
  return deactivated;
}

/** Hard delete tracked CAs by id (used for test teardown or explicit purging). */
export function deleteTrackedCasByIds(ids: readonly string[]): number {
  if (ids.length === 0) return 0;
  const db = getDb();
  let deleted = 0;
  db.transaction(() => {
    const del = db.prepare('DELETE FROM tracked_cas WHERE id = ?');
    for (const id of ids) deleted += del.run(id).changes;
    sweepOrphanedCaData();
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

/** Retrieve a persisted tier row by canonical (ca, chain), or undefined if unrated. */
export function getTier(ca: string, chain: Chain): TierRow | undefined {
  return getDb()
    .prepare('SELECT * FROM token_tiers WHERE ca = ? AND chain = ?')
    .get(canonicalCa(ca, chain), chain) as TierRow | undefined;
}

/** Check if a CA has been marked tier 'P' (Pass) — tombstoned forever. */
export function isPassTier(ca: string, chain: Chain): boolean {
  const canon = canonicalCa(ca, chain);
  const blocked = getDb()
    .prepare('SELECT 1 FROM blocked_cas WHERE address = ? AND chain = ?')
    .get(canon, chain);
  if (blocked) return true;
  const row = getDb()
    .prepare('SELECT tier FROM token_tiers WHERE ca = ? AND chain = ?')
    .get(canon, chain) as { tier: string } | undefined;
  return row?.tier === 'P';
}

/** Delete a tracked CA by canonical address and chain, cascading to orphan token/holding data. */
export function deleteTrackedCaByAddress(address: string, chain: Chain): boolean {
  const db = getDb();
  const canon = canonicalCa(address, chain);
  const row = db.prepare('SELECT id FROM tracked_cas WHERE address = ? AND chain = ?').get(canon, chain) as { id: string } | undefined;
  if (!row) return false;
  db.transaction(() => {
    db.prepare('DELETE FROM tracked_cas WHERE id = ?').run(row.id);
    db.prepare('DELETE FROM zero_holdings WHERE ca = ? AND chain = ?').run(canon, chain);
    sweepOrphanedCaData();
  })();
  return true;
}

/** Upsert user tier. Pass ('P') creates an immutable tombstone in blocked_cas and drops from tracking. */
export function setTier(ca: string, chain: Chain, tier: Tier): void {
  const canon = canonicalCa(ca, chain);
  if (isPassTier(canon, chain) && tier !== 'P') {
    throw new Error(`cannot re-rate CA ${canon} on ${chain}: permanently blocked as Pass`);
  }
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO token_tiers (ca, chain, tier, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(ca, chain) DO UPDATE SET tier = excluded.tier, updated_at = excluded.updated_at`,
    ).run(canon, chain, tier, Date.now());

    if (tier === 'P') {
      db.prepare(
        `INSERT INTO blocked_cas (address, chain, reason, blocked_at) VALUES (?, ?, 'pass', ?)
         ON CONFLICT(address, chain) DO NOTHING`,
      ).run(canon, chain, Date.now());
      deleteTrackedCaByAddress(canon, chain);
    } else {
      // Ensure CA is active when tiered
      db.prepare("UPDATE tracked_cas SET status = 'queued' WHERE address = ? AND chain = ? AND status = 'inactive'").run(canon, chain);
    }
  })();
}

/** Record that a member's holding of a CA reached 0%. Preserves earliest zero timestamp. */
export function recordZeroHolding(
  memberType: 'wallet' | 'fomo',
  memberId: string,
  ca: string,
  chain: Chain,
  zeroAt: number = Date.now(),
): void {
  const canon = canonicalCa(ca, chain);
  getDb()
    .prepare(`
      INSERT INTO zero_holdings (member_type, member_id, ca, chain, zero_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(member_type, member_id, ca, chain) DO NOTHING
    `)
    .run(memberType, memberId, canon, chain, zeroAt);
}

/** Clear zero holding record when a member's holding becomes > 0%. */
export function clearZeroHolding(
  memberType: 'wallet' | 'fomo',
  memberId: string,
  ca: string,
  chain: Chain,
): void {
  const canon = canonicalCa(ca, chain);
  getDb()
    .prepare(`
      DELETE FROM zero_holdings
       WHERE member_type = ? AND member_id = ? AND ca = ? AND chain = ?
    `)
    .run(memberType, memberId, canon, chain);
}

/** Clearing a tier DELETES the row — absent row = unrated. Fails if permanently blocked. */
export function deleteTier(ca: string, chain: Chain): void {
  const canon = canonicalCa(ca, chain);
  if (isPassTier(canon, chain)) {
    throw new Error(`cannot clear tier for CA ${canon} on ${chain}: permanently blocked as Pass`);
  }
  getDb().prepare('DELETE FROM token_tiers WHERE ca = ? AND chain = ?').run(canon, chain);
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

/** Cached provider payload and durable query gate for one (CA, chain, dataset). */
export function getMetricPollCache(ca: string, chain: Chain, kind: string): MetricPollCacheRow | undefined {
  return getDb()
    .prepare('SELECT * FROM metric_poll_cache WHERE ca = ? AND chain = ? AND kind = ?')
    .get(canonicalCa(ca, chain), chain, kind) as MetricPollCacheRow | undefined;
}

/** Retry interval shared by stale legacy FW gates and transient Door challenges. */
export const METRIC_RECOVERY_RETRY_MS = 5 * 60_000;

/** Effective gate for successful reads and recoverable FW failures.
 * Legacy failures get one bounded probe so persisted exponential gates cannot
 * strand CAs after deployment; classified permanent failures keep their backoff. */
export function metricPollNextAllowedAt(row: MetricPollCacheRow, intervalMs: number): number {
  const hasUnreservedSuccess =
    row.kind === 'gini' &&
    row.failure_count === 0 &&
    row.response_at !== null &&
    row.last_attempt_at <= row.response_at;
  if (hasUnreservedSuccess) return Math.min(row.next_allowed_at, row.response_at! + intervalMs);
  const recoverableFailure =
    row.kind === 'gini' &&
    (row.retry_class === 'transient' ||
      row.retry_class === 'legacy_probe' ||
      (row.failure_count > 0 && row.retry_class === null));
  return recoverableFailure
    ? Math.min(row.next_allowed_at, row.last_attempt_at + METRIC_RECOVERY_RETRY_MS)
    : row.next_allowed_at;
}

/** Reserve a due query atomically before network I/O; repeated callers cannot burst. */
export function reserveMetricPoll(
  ca: string,
  chain: Chain,
  kind: string,
  now: number,
  intervalMs: number,
): MetricPollReservation {
  const canon = canonicalCa(ca, chain);
  const db = getDb();
  return db.transaction(() => {
    const row = db
      .prepare('SELECT * FROM metric_poll_cache WHERE ca = ? AND chain = ? AND kind = ?')
      .get(canon, chain, kind) as MetricPollCacheRow | undefined;
    if (row && now < metricPollNextAllowedAt(row, intervalMs)) return { claimed: false, row };
    db.prepare(
      `INSERT INTO metric_poll_cache
         (ca, chain, kind, last_attempt_at, next_allowed_at, failure_count, retry_class)
       VALUES (?, ?, ?, ?, ?, 0, NULL)
       ON CONFLICT(ca, chain, kind) DO UPDATE SET
         last_attempt_at = excluded.last_attempt_at,
         next_allowed_at = excluded.next_allowed_at,
         retry_class = CASE
           WHEN metric_poll_cache.kind = 'gini'
             AND metric_poll_cache.failure_count > 0
             AND metric_poll_cache.retry_class IS NULL
           THEN 'legacy_probe'
           ELSE metric_poll_cache.retry_class
         END`,
    ).run(canon, chain, kind, now, now + intervalMs);
    return { claimed: true, row };
  })();
}

/** Commit successful responses and Fresh observations atomically. */
export function saveMetricPollResponse(
  ca: string,
  chain: Chain,
  kind: string,
  responseAt: number,
  nextAllowedAt: number,
  response: unknown,
): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO metric_poll_cache
         (ca, chain, kind, last_attempt_at, response_at, next_allowed_at, failure_count, response_json, retry_class)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL)
       ON CONFLICT(ca, chain, kind) DO UPDATE SET
         last_attempt_at = excluded.last_attempt_at,
         response_at = excluded.response_at,
         next_allowed_at = excluded.next_allowed_at,
         failure_count = 0,
         response_json = excluded.response_json,
         retry_class = NULL`,
    ).run(canonicalCa(ca, chain), chain, kind, responseAt, responseAt, nextAllowedAt, JSON.stringify(response));
    const fresh = kind === 'gini' ? freshValue(response) : undefined;
    if (fresh !== undefined) appendAlertMetricObservation(db, ca, chain, 'fresh', fresh, responseAt);
  })();
}

function freshValue(response: unknown): number | undefined {
  if (typeof response !== 'object' || response === null || Array.isArray(response)) return undefined;
  const value = Reflect.get(response, 'nansenFreshPct');
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : undefined;
}

function earliestT100Multiple(raw: string | null): number | null {
  if (raw === null) return null;
  try {
    const history: unknown = JSON.parse(raw);
    if (!Array.isArray(history)) return null;
    const first = history[0] as { value?: unknown } | undefined;
    return typeof first?.value === 'number' && Number.isFinite(first.value) && first.value > 0
      ? first.value
      : null;
  } catch {
    return null;
  }
}

export function appendAlertMetricObservation(
  db: Database.Database,
  ca: string,
  chain: Chain,
  metric: AlertMetric,
  value: number,
  responseAt: number,
  trackerBuyer?: { name: string; address?: string },
): void {
  const canonical = canonicalCa(ca, chain);
  const state = db.prepare(`
    SELECT symbol, market_cap, market_cap_history_json, supply, holders, nansen_holders,
           nansen_fresh_pct, t100_multiple, t100_history_json, genesis_bal
    FROM token_state WHERE ca = ? AND chain = ?
  `).get(canonical, chain) as {
    symbol: string | null;
    market_cap: number | null;
    market_cap_history_json: string | null;
    supply: number | null;
    holders: number | null;
    nansen_holders: number | null;
    nansen_fresh_pct: number | null;
    t100_multiple: number | null;
    t100_history_json: string | null;
    genesis_bal: number | null;
  } | undefined;
  const holdings = db.prepare(`
    SELECT COALESCE(SUM(s.token_amount), 0) AS amount
    FROM wallet_token_state s
    WHERE s.ca = ? AND s.chain = ?
      AND EXISTS (
        SELECT 1 FROM wallet_trades t
        WHERE t.wallet_id = s.wallet_id AND t.ca = s.ca AND t.chain = s.chain
          AND t.side = 'buy' AND t.source = 'watch'
      )
  `).get(canonical, chain) as { amount: number };
  let marketCapAt: number | null = null;
  if (state?.market_cap != null && state.market_cap_history_json !== null) {
    try {
      const history: unknown = JSON.parse(state.market_cap_history_json);
      if (Array.isArray(history)) {
        const last = history[history.length - 1] as { t?: unknown; value?: unknown } | undefined;
        if (last !== undefined && last.value === state.market_cap && typeof last.t === 'number' && Number.isSafeInteger(last.t)) {
          marketCapAt = last.t;
        }
      }
    } catch {
      marketCapAt = null;
    }
  }
  const holderCount = state?.holders != null && state.holders > 0
    ? state.holders
    : state?.nansen_holders != null && state.nansen_holders > 0
      ? state.nansen_holders
      : null;
  const firstT100Row = metric === 't100'
    ? db.prepare(
      'SELECT first_multiple FROM t100_first_observations WHERE ca = ? AND chain = ?',
    ).get(canonical, chain) as { first_multiple: number } | undefined
    : undefined;
  const firstT100 = metric === 't100'
    ? firstT100Row?.first_multiple ??
      earliestT100Multiple(state?.t100_history_json ?? null) ??
      (Number.isFinite(value) && value > 0 ? value : null)
    : null;
  if (firstT100 !== null && firstT100Row === undefined) {
    db.prepare(`
      INSERT OR IGNORE INTO t100_first_observations (ca, chain, first_multiple, recorded_at)
      VALUES (?, ?, ?, ?)
    `).run(canonical, chain, firstT100, Date.now());
  }
  const snapshot: AlertMetricSnapshot = {
    capturedAt: Date.now(),
    symbol: state?.symbol ?? null,
    marketCap: state?.market_cap ?? null,
    marketCapAt,
    freshPct: metric === 'fresh' ? value : state?.nansen_fresh_pct ?? null,
    t100Multiple: metric === 't100' ? value : state?.t100_multiple ?? null,
    ...(holderCount === null ? {} : { holders: holderCount }),
    ...(firstT100 === null ? {} : { t100First: firstT100 }),
    lf: state?.genesis_bal ?? null,
    trackedHoldingPct: state === undefined
      ? null
      : state.supply != null && state.supply > 0
        ? (holdings.amount / state.supply) * 100
        : 0,
    ...(metric === 'trackerBuy' && trackerBuyer
      ? {
        trackerBuyer: {
          name: trackerBuyer.name.slice(0, 128),
          ...(trackerBuyer.address === undefined ? {} : { address: trackerBuyer.address.slice(0, 128) }),
        },
      }
      : {}),
  };
  db.prepare(`
    INSERT INTO alert_metric_observations (ca, chain, metric, value, response_at, snapshot_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(canonical, chain, metric, value, responseAt, JSON.stringify(snapshot));
}

export function getLatestAlertMetricObservationId(): number {
  const row = getDb().prepare('SELECT COALESCE(MAX(id), 0) AS id FROM alert_metric_observations').get() as { id: number };
  return row.id;
}
/** Ordered, durable metric observations consumed by the central Monitor. */
export function getAlertMetricObservations(afterId: number, limit: number): AlertMetricObservation[] {
  const rows = getDb().prepare(`
    SELECT id, ca, chain, metric, value, response_at, snapshot_json
    FROM alert_metric_observations WHERE id > ? ORDER BY id LIMIT ?
  `).all(afterId, limit) as {
    id: number;
    ca: string;
    chain: Chain;
    metric: AlertMetric;
    value: number;
    response_at: number;
    snapshot_json: string;
  }[];
  return rows.map((row) => ({
    id: row.id,
    ca: row.ca,
    chain: row.chain,
    metric: row.metric,
    value: row.value,
    responseAt: row.response_at,
    snapshot: JSON.parse(row.snapshot_json) as AlertMetricSnapshot,
  }));
}

/** Import shared Fresh/T100 events into this instance's independently acked feed. */
export function importSharedAlertMetricObservations(limit = 500): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error('shared alert import limit must be an integer from 1 to 1000');
  }
  const db = getDb();
  const attached = db.pragma('database_list') as { name: string }[];
  if (!attached.some((database) => database.name === 'market_data')) return 0;
  return db.transaction(() => {
    const cursor = db.prepare(
      'SELECT imported_id FROM shared_alert_metric_import_state WHERE singleton = 1',
    ).get() as { imported_id: number };
    const rows = db.prepare(`
      SELECT id, ca, chain, metric, value, response_at
      FROM market_data.alert_metric_observations
      WHERE id > ? ORDER BY id LIMIT ?
    `).all(cursor.imported_id, limit) as {
      id: number;
      ca: string;
      chain: string;
      metric: string;
      value: number;
      response_at: number;
    }[];
    const last = rows.at(-1);
    if (last === undefined) return 0;
    let imported = 0;
    for (const row of rows) {
      if ((row.metric !== 'fresh' && row.metric !== 't100') ||
          !CHAINS.includes(row.chain as Chain) || !Number.isFinite(row.value)) continue;
      appendAlertMetricObservation(
        db, row.ca, row.chain as Chain, row.metric, row.value, row.response_at,
      );
      imported++;
    }
    db.prepare(
      'UPDATE shared_alert_metric_import_state SET imported_id = ? WHERE singleton = 1',
    ).run(last.id);
    return imported;
  })();
}

export function sharedAlertMetricImportCursor(): number {
  return (getDb().prepare(
    'SELECT imported_id FROM shared_alert_metric_import_state WHERE singleton = 1',
  ).get() as { imported_id: number }).imported_id;
}

export type MarketAlertCaller = 'a' | 'b';

/** Each dashboard has an independent source cursor; compact only after both import. */
export function acknowledgeMarketAlertDelivery(caller: MarketAlertCaller, throughId: number): boolean {
  if ((caller !== 'a' && caller !== 'b') || !Number.isSafeInteger(throughId) || throughId < 0) return false;
  const db = getDb();
  return db.transaction(() => {
    const current = db.prepare(
      'SELECT acknowledged_id FROM market_alert_delivery_cursors WHERE caller = ?',
    ).get(caller) as { acknowledged_id: number } | undefined;
    if (current === undefined || throughId < current.acknowledged_id) return false;
    if (throughId === current.acknowledged_id) return true;
    const highWatermark = db.prepare(
      'SELECT COALESCE(MAX(id), 0) AS id FROM alert_metric_observations',
    ).get() as { id: number };
    if (throughId > highWatermark.id) return false;
    db.prepare(
      'UPDATE market_alert_delivery_cursors SET acknowledged_id = ? WHERE caller = ?',
    ).run(throughId, caller);
    const minimum = db.prepare(
      'SELECT MIN(acknowledged_id) AS id FROM market_alert_delivery_cursors',
    ).get() as { id: number };
    db.prepare('DELETE FROM alert_metric_observations WHERE id <= ?').run(minimum.id);
    return true;
  })();
}

/** Ack only after Monitor has durably committed its cursor and outbox. */
export function acknowledgeAlertMetricObservations(throughId: number): boolean {
  const db = getDb();
  return db.transaction(() => {
    const highWatermark = db.prepare(
      'SELECT COALESCE(MAX(id), 0) AS id FROM alert_metric_observations',
    ).get() as { id: number };
    const acknowledged = db.prepare(
      'SELECT acknowledged_id FROM alert_metric_feed_state WHERE singleton = 1',
    ).get() as { acknowledged_id: number };
    if (!Number.isSafeInteger(throughId) || throughId < acknowledged.acknowledged_id) return false;
    if (throughId === acknowledged.acknowledged_id) return true;
    if (throughId > highWatermark.id) return false;
    db.prepare('UPDATE alert_metric_feed_state SET acknowledged_id = ? WHERE singleton = 1').run(throughId);
    db.prepare('DELETE FROM alert_metric_observations WHERE id <= ?').run(throughId);
    return true;
  })();
}

/** Record failure/backoff without replacing the last successful response. */
export function failMetricPoll(
  ca: string,
  chain: Chain,
  kind: string,
  nextAllowedAt: number,
  retryClass: Exclude<MetricPollRetryClass, null | 'legacy_probe'> = 'permanent',
): void {
  getDb()
    .prepare(
      `UPDATE metric_poll_cache
       SET next_allowed_at = ?, failure_count = failure_count + 1, retry_class = ?
       WHERE ca = ? AND chain = ? AND kind = ?`,
    )
    .run(nextAllowedAt, retryClass, canonicalCa(ca, chain), chain, kind);
}

/** Defer a transient failure without increasing the exponential backoff counter. */
export function deferMetricPoll(ca: string, chain: Chain, kind: string, nextAllowedAt: number): void {
  getDb()
    .prepare(
      `UPDATE metric_poll_cache SET next_allowed_at = ?, retry_class = 'transient'
       WHERE ca = ? AND chain = ? AND kind = ?`,
    )
    .run(nextAllowedAt, canonicalCa(ca, chain), chain, kind);
}

/** One read for the signal DTO and fair poll ordering. */
export function listMetricPollCache(kind?: string): MetricPollCacheRow[] {
  if (kind === undefined) {
    return getDb().prepare('SELECT * FROM metric_poll_cache').all() as MetricPollCacheRow[];
  }
  return getDb()
    .prepare('SELECT * FROM metric_poll_cache WHERE kind = ?')
    .all(kind) as MetricPollCacheRow[];
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

export function upsertNansenSeries(ca: string, chain: Chain, window: string, points: SeriesPoint[], takenAt: number): void {
  getDb()
    .prepare(
      `INSERT INTO nansen_series (ca, chain, window, taken_at, points_json) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(ca, chain, window) DO UPDATE SET taken_at = excluded.taken_at, points_json = excluded.points_json`,
    )
    .run(ca, chain, window, takenAt, JSON.stringify(points));
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

// --- fomo watch-list --------------------------------------------------------
// A second watch-list beside wallets: FOMO users + their captured buy/sell alerts.

export interface FomoUserRow {
  id: string;
  handle: string;
  /** Learned from the stream or seeded from CSV — NULL until known. */
  user_id: string | null;
  name: string;
  /** Display-only label beside the name (mirrors wallets.clan). Never filters/routes. */
  clan: string | null;
  /** JSON string[] of display chips (mirrors wallets.tags); '[]' when untagged. */
  tags: string;
  wallet_solana: string | null;
  wallet_evm: string | null;
  source: string;
  created_at: number;
}

export interface FomoUserInput {
  handle: string;
  user_id?: string | null;
  name?: string;
  clan?: string | null;
  tags?: string[];
  wallet_solana?: string | null;
  wallet_evm?: string | null;
  source?: string;
}

export interface FomoTradeInput {
  fomo_user_id: string;
  /** FOMO's stable event id — the idempotency key (ON CONFLICT DO NOTHING). */
  event_id: string;
  /** Raw contract address — canonicalized (canonicalCa) before storing. */
  ca: string;
  chain: Chain;
  /** FOMO's alertType, narrowed to the only two we persist (perp/thesis/listing dropped upstream). */
  type: 'buy' | 'sell';
  /** TYPE-DEPENDENT: buy → post-fill position size, sell → signed realised PnL. Never sum across types. */
  usd_value?: number | null;
  /** USD actually traded (both directions). The Buy-$ basis; NULL when the feed could not resolve the fill. */
  trade_usd?: number | null;
  price?: number | null;
  /** Ticker symbol. */
  token?: string | null;
  /** FOMO's publish time, epoch ms. */
  ts: number;
  source?: string;
}
export interface FomoTradeEnrichmentTarget {
  ca: string;
  chain: Chain;
  type: 'buy' | 'sell';
  ts: number;
  trade_usd: number | null;
}


export function listFomoUsers(): FomoUserRow[] {
  return getDb().prepare('SELECT * FROM fomo_users ORDER BY name').all() as FomoUserRow[];
}

export function findFomoUserByHandle(handle: string): FomoUserRow | undefined {
  return getDb().prepare('SELECT * FROM fomo_users WHERE handle = ?').get(handle) as FomoUserRow | undefined;
}

export function findFomoUserByUserId(userId: string): FomoUserRow | undefined {
  return getDb().prepare('SELECT * FROM fomo_users WHERE user_id = ?').get(userId) as FomoUserRow | undefined;
}

export function insertFomoUser(input: FomoUserInput): FomoUserRow {
  const row: FomoUserRow = {
    id: randomUUID(),
    handle: input.handle,
    user_id: input.user_id ?? null,
    name: nameOrHandle(input.name, input.handle),
    clan: input.clan ?? null,
    tags: JSON.stringify(input.tags ?? []),
    wallet_solana: input.wallet_solana ?? null,
    wallet_evm: input.wallet_evm ?? null,
    source: input.source ?? 'manual',
    created_at: Date.now(),
  };
  getDb()
    .prepare(
      'INSERT INTO fomo_users (id, handle, user_id, name, clan, tags, wallet_solana, wallet_evm, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(row.id, row.handle, row.user_id, row.name, row.clan, row.tags, row.wallet_solana, row.wallet_evm, row.source, row.created_at);
  return row;
}

/**
 * PATCH by id: only the provided fields are written (column names are literals,
 * values bound — no injection). Returns the row after the update, or undefined if
 * the id does not exist. A no-op `next` leaves the row untouched.
 */
export function updateFomoUser(id: string, next: Partial<FomoUserInput>): FomoUserRow | undefined {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  if (next.handle !== undefined) { sets.push('handle = ?'); values.push(next.handle); }
  if (next.user_id !== undefined) { sets.push('user_id = ?'); values.push(next.user_id); }
  if (next.name !== undefined) { sets.push('name = ?'); values.push(next.name); }
  if (next.clan !== undefined) { sets.push('clan = ?'); values.push(next.clan); }
  if (next.tags !== undefined) { sets.push('tags = ?'); values.push(JSON.stringify(next.tags)); }
  if (next.wallet_solana !== undefined) { sets.push('wallet_solana = ?'); values.push(next.wallet_solana); }
  if (next.wallet_evm !== undefined) { sets.push('wallet_evm = ?'); values.push(next.wallet_evm); }
  if (next.source !== undefined) { sets.push('source = ?'); values.push(next.source); }
  if (sets.length > 0) {
    getDb().prepare(`UPDATE fomo_users SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  }
  return getDb().prepare('SELECT * FROM fomo_users WHERE id = ?').get(id) as FomoUserRow | undefined;
}

export function deleteFomoUser(id: string): void {
  // FK ON DELETE CASCADE cleans fomo_trades.
  getDb().prepare('DELETE FROM fomo_users WHERE id = ?').run(id);
}

/** Shared import report. `updated` is ADDITIVE: only the fomo upsert import sets
 *  it; importWallets keeps returning {added, skipped} exactly as before. */
export interface ImportResult {
  added: number;
  skipped: { row: number; reason: string }[];
  /** Rows that matched an existing handle and enriched at least one field. */
  updated?: number;
}

/** The columns a fomo re-import may enrich, read back for the changed-field check. */
interface FomoUserEnrichable {
  user_id: string | null;
  name: string;
  clan: string | null;
  tags: string | null;
  wallet_solana: string | null;
  wallet_evm: string | null;
}

const nonEmpty = (v: string | null | undefined): string | null => {
  const s = (v ?? '').trim();
  return s === '' ? null : s;
};

/** A FOMO user known only by handle displays that handle as its name (user 2026-10-01). */
const nameOrHandle = (name: string | null | undefined, handle: string): string => nonEmpty(name) ?? handle;

/**
 * Server-side CSV import, staged: fomo CSVs arrive in batches and a LATER batch
 * (e.g. itsalita_following.csv, which carries userId) must ENRICH a handle an
 * EARLIER batch (leaderboard_24h.csv, no userId column) already created. So this
 * is a real upsert: on a duplicate handle it fills user_id/name/clan/wallet_*
 * from non-empty incoming values and NEVER blanks an existing value with an empty
 * one (COALESCE(NULLIF(excluded,''), col) — NULL and '' both mean "not provided").
 * source/id/created_at belong to the first insert and are never overwritten.
 * `row` = index in the input array (the importWallets ImportResult contract).
 * Single transaction for the whole batch.
 */
export function importFomoUsers(rows: readonly FomoUserInput[]): ImportResult {
  const db = getDb();
  const prev = db.prepare(
    'SELECT user_id, name, clan, tags, wallet_solana, wallet_evm FROM fomo_users WHERE handle = ?',
  );
  const upsert = db.prepare(
    `INSERT INTO fomo_users (id, handle, user_id, name, clan, tags, wallet_solana, wallet_evm, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(handle) DO UPDATE SET
       user_id = COALESCE(NULLIF(excluded.user_id, ''), fomo_users.user_id),
       name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE fomo_users.name END,
       clan = COALESCE(NULLIF(excluded.clan, ''), fomo_users.clan),
       tags = CASE WHEN excluded.tags <> '[]' THEN excluded.tags ELSE fomo_users.tags END,
       wallet_solana = COALESCE(NULLIF(excluded.wallet_solana, ''), fomo_users.wallet_solana),
       wallet_evm = COALESCE(NULLIF(excluded.wallet_evm, ''), fomo_users.wallet_evm)`,
  );
  let added = 0;
  let updated = 0;
  const skipped: { row: number; reason: string }[] = [];
  const run = db.transaction((items: readonly FomoUserInput[]) => {
    const now = Date.now();
    items.forEach((r, i) => {
      const handle = (r.handle ?? '').trim();
      if (!handle) {
        skipped.push({ row: i, reason: 'handle is empty' });
        return;
      }
      const next: FomoUserEnrichable = {
        user_id: nonEmpty(r.user_id),
        name: (r.name ?? '').trim(),
        clan: nonEmpty(r.clan),
        tags: r.tags && r.tags.length > 0 ? JSON.stringify(r.tags) : null,
        wallet_solana: nonEmpty(r.wallet_solana),
        wallet_evm: nonEmpty(r.wallet_evm),
      };
      const before = prev.get(handle) as FomoUserEnrichable | undefined;
      upsert.run(
        randomUUID(),
        handle,
        next.user_id,
        next.name,
        next.clan,
        next.tags ?? '[]',
        next.wallet_solana,
        next.wallet_evm,
        (r.source ?? '').trim() || 'manual',
        now,
      );
      if (!before) {
        added += 1;
        return;
      }
      const changed =
        (next.user_id !== null && next.user_id !== before.user_id) ||
        (next.name !== '' && next.name !== before.name) ||
        (next.clan !== null && next.clan !== before.clan) ||
        (next.tags !== null && next.tags !== before.tags) ||
        (next.wallet_solana !== null && next.wallet_solana !== before.wallet_solana) ||
        (next.wallet_evm !== null && next.wallet_evm !== before.wallet_evm);
      if (changed) {
        updated += 1;
      } else {
        skipped.push({ row: i, reason: 'duplicate handle (no new fields)' });
      }
    });
  });
  run(rows);
  return { added, updated, skipped };
}

/**
 * Idempotent on event_id via ON CONFLICT(event_id) DO NOTHING: a replayed alert is
 * a no-op. NOT `OR IGNORE` — that also swallows CHECK/NOT-NULL violations and would
 * mute the type CHECK backstop; DO NOTHING on event_id keeps the replay no-op while
 * a bad `type` still throws. Returns whether a row was actually created (false =
 * the event_id already existed). ca is canonicalized so it keys like the rest of
 * the store.
 */
export function insertFomoTrade(input: FomoTradeInput): boolean {
  const tradeUsd =
    input.type === 'buy' && input.trade_usd != null &&
      (!Number.isFinite(input.trade_usd) || input.trade_usd <= 0)
      ? null
      : input.trade_usd ?? null;
  const res = getDb()
    .prepare(
      `INSERT INTO fomo_trades (fomo_user_id, event_id, ca, chain, type, usd_value, trade_usd, price, token, ts, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO NOTHING`,
    )
    .run(
      input.fomo_user_id,
      input.event_id,
      canonicalCa(input.ca, input.chain),
      input.chain,
      input.type,
      input.usd_value ?? null,
      tradeUsd,
      input.price ?? null,
      input.token ?? null,
      input.ts,
      input.source ?? 'fomo',
      Date.now(),
    );
  return res.changes > 0;
}

export function getFomoTradeEnrichmentTarget(fomoUserId: string, eventId: string): FomoTradeEnrichmentTarget | undefined {
  return getDb()
    .prepare(
      `SELECT ca, chain, type, ts, trade_usd
         FROM fomo_trades
        WHERE fomo_user_id = ? AND event_id = ?`,
    )
    .get(fomoUserId, eventId) as FomoTradeEnrichmentTarget | undefined;
}

/** Fill only a still-unknown BUY amount; alert-provided tradeUsd stays authoritative. */
export function updateFomoTradeUsd(fomoUserId: string, eventId: string, amount: number): boolean {
  if (!Number.isFinite(amount) || amount <= 0) return false;
  const db = getDb();
  return db.transaction(() => {
    const res = db.prepare(
      `UPDATE fomo_trades
          SET trade_usd = ?
        WHERE fomo_user_id = ? AND event_id = ? AND type = 'buy' AND trade_usd IS NULL`,
    ).run(amount, fomoUserId, eventId);
    if (res.changes === 0) return false;
    const trade = db.prepare(`
      SELECT t.ca, t.chain, t.ts, u.handle
      FROM fomo_trades t JOIN fomo_users u ON u.id = t.fomo_user_id
      WHERE t.fomo_user_id = ? AND t.event_id = ?
    `).get(fomoUserId, eventId) as { ca: string; chain: Chain; ts: number; handle: string };
    appendAlertMetricObservation(db, trade.ca, trade.chain, 'trackerBuy', amount, trade.ts, {
      name: trade.handle,
    });
    return true;
  })();
}

// --- fomo wallet holdings ---------------------------------------------------

export interface FomoUserWalletRow {
  id: string;
  fomo_user_id: string;
  chain: Chain;
  address: string;
  source: string | null;
  tx_hash: string | null;
  first_seen_ts: number | null;
  created_at: number;
}

export interface FomoUserWalletInput {
  fomo_user_id: string;
  chain: Chain;
  address: string;
  source?: string | null;
  tx_hash?: string | null;
  first_seen_ts?: number | null;
}

/** A user can act from MANY wallets. Identity is (user, chain, address): an
 *  already-known wallet re-resolved from a later tx is a strict no-op. address is
 *  canonicalized so an EVM lookup folds like everywhere else. */
export function insertFomoUserWallet(input: FomoUserWalletInput): boolean {
  const res = getDb()
    .prepare(
      `INSERT INTO fomo_user_wallets (id, fomo_user_id, chain, address, source, tx_hash, first_seen_ts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(fomo_user_id, chain, address) DO NOTHING`,
    )
    .run(
      randomUUID(),
      input.fomo_user_id,
      input.chain,
      canonicalCa(input.address, input.chain),
      input.source ?? null,
      input.tx_hash ?? null,
      input.first_seen_ts ?? null,
      Date.now(),
    );
  return res.changes > 0;
}

export function findFomoUserWallet(fomoUserId: string, chain: Chain, address: string): FomoUserWalletRow | undefined {
  return getDb()
    .prepare('SELECT * FROM fomo_user_wallets WHERE fomo_user_id = ? AND chain = ? AND address = ?')
    .get(fomoUserId, chain, canonicalCa(address, chain)) as FomoUserWalletRow | undefined;
}

export function listFomoWalletsForUser(fomoUserId: string, chain: Chain): FomoUserWalletRow[] {
  return getDb()
    .prepare('SELECT * FROM fomo_user_wallets WHERE fomo_user_id = ? AND chain = ? ORDER BY created_at')
    .all(fomoUserId, chain) as FomoUserWalletRow[];
}



export interface FomoHoldingInput {
  fomo_user_id: string;
  ca: string;
  chain: Chain;
  /** The wallet whose measurement produced this row (display/provenance). */
  wallet: string;
  /** Σ token units across the user's wallets on this chain; NULL when never measured. */
  amount: number | null;
  /** amount / total supply × 100; NULL when supply is unknown/0. */
  pct: number | null;
  measured_at: number;
}

/** ONE row per (user, ca, chain) — a re-measure overwrites. ca/wallet canonicalized. */
export function upsertFomoHolding(input: FomoHoldingInput): void {
  getDb()
    .prepare(
      `INSERT INTO fomo_holdings (fomo_user_id, ca, chain, wallet, amount, pct, measured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(fomo_user_id, ca, chain) DO UPDATE SET
         wallet = excluded.wallet, amount = excluded.amount, pct = excluded.pct, measured_at = excluded.measured_at`,
    )
    .run(
      input.fomo_user_id,
      canonicalCa(input.ca, input.chain),
      input.chain,
      canonicalCa(input.wallet, input.chain),
      input.amount,
      input.pct,
      input.measured_at,
    );
  if (input.amount != null && input.amount > 0) {
    clearZeroHolding('fomo', input.fomo_user_id, input.ca, input.chain);
  } else if (input.amount != null && input.amount <= 0) {
    recordZeroHolding('fomo', input.fomo_user_id, input.ca, input.chain, input.measured_at);
  }
}
export interface FomoPositionInput {
  fomo_user_id: string;
  ca: string;
  chain: Chain;
  trade_id: string | null;
  status: string | null;
  /** Token units held (authoritative — same call as cost_basis_usd). */
  amount: number | null;
  /** Money actually spent. NOT the alert's usdValue (a mark-to-market stock). */
  cost_basis_usd: number | null;
  avg_entry_price: number | null;
  price_usd: number | null;
  realized_pnl_usd: number | null;
  unrealized_pnl_usd: number | null;
  fetched_at: number;
}

/** Upsert one position; unknown API fields preserve the last known value. */
export function upsertFomoPosition(input: FomoPositionInput): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO fomo_positions (fomo_user_id, ca, chain, trade_id, status, amount, cost_basis_usd,
                                 avg_entry_price, price_usd, realized_pnl_usd, unrealized_pnl_usd, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(fomo_user_id, ca, chain) DO UPDATE SET
       trade_id = COALESCE(excluded.trade_id, fomo_positions.trade_id),
       status = COALESCE(excluded.status, fomo_positions.status),
       amount = COALESCE(excluded.amount, fomo_positions.amount),
       cost_basis_usd = COALESCE(excluded.cost_basis_usd, fomo_positions.cost_basis_usd),
       avg_entry_price = COALESCE(excluded.avg_entry_price, fomo_positions.avg_entry_price),
       price_usd = COALESCE(excluded.price_usd, fomo_positions.price_usd),
       realized_pnl_usd = COALESCE(excluded.realized_pnl_usd, fomo_positions.realized_pnl_usd),
       unrealized_pnl_usd = COALESCE(excluded.unrealized_pnl_usd, fomo_positions.unrealized_pnl_usd),
       fetched_at = excluded.fetched_at
     WHERE COALESCE(excluded.trade_id, fomo_positions.trade_id) IS NOT fomo_positions.trade_id
        OR COALESCE(excluded.status, fomo_positions.status) IS NOT fomo_positions.status
        OR COALESCE(excluded.amount, fomo_positions.amount) IS NOT fomo_positions.amount
        OR COALESCE(excluded.cost_basis_usd, fomo_positions.cost_basis_usd) IS NOT fomo_positions.cost_basis_usd
        OR COALESCE(excluded.avg_entry_price, fomo_positions.avg_entry_price) IS NOT fomo_positions.avg_entry_price
        OR COALESCE(excluded.price_usd, fomo_positions.price_usd) IS NOT fomo_positions.price_usd
        OR COALESCE(excluded.realized_pnl_usd, fomo_positions.realized_pnl_usd) IS NOT fomo_positions.realized_pnl_usd
        OR COALESCE(excluded.unrealized_pnl_usd, fomo_positions.unrealized_pnl_usd) IS NOT fomo_positions.unrealized_pnl_usd`,
  ).run(
    input.fomo_user_id,
    canonicalCa(input.ca, input.chain),
    input.chain,
    input.trade_id,
    input.status,
    input.amount,
    input.cost_basis_usd,
    input.avg_entry_price,
    input.price_usd,
    input.realized_pnl_usd,
    input.unrealized_pnl_usd,
    input.fetched_at,
  );
  if (input.amount != null && input.amount > 0) {
    clearZeroHolding('fomo', input.fomo_user_id, input.ca, input.chain);
  } else if ((input.amount != null && input.amount <= 0) || input.status === 'closed') {
    recordZeroHolding('fomo', input.fomo_user_id, input.ca, input.chain, input.fetched_at);
  }
}

export interface FomoPositionTarget {
  ca: string;
  chain: Chain;
}

/** CAs the dashboard currently lists for one user, before the active-CAs filter. */
export function listFomoPositionTargets(fomoUserId: string, now = Date.now()): FomoPositionTarget[] {
  return getDb().prepare(
    `SELECT DISTINCT targets.ca, targets.chain
       FROM (
         SELECT ca, chain FROM fomo_trades WHERE fomo_user_id = ? AND type = 'buy'
         UNION
         SELECT ca, chain FROM fomo_positions WHERE fomo_user_id = ? AND (cost_basis_usd > 0 OR amount > 0)
       ) targets
      WHERE NOT EXISTS (
        SELECT 1 FROM zero_holdings zh
         WHERE zh.member_type = 'fomo' AND zh.member_id = ?
           AND zh.ca = targets.ca AND zh.chain = targets.chain
           AND zh.zero_at <= ?
      )`,
  ).all(fomoUserId, fomoUserId, fomoUserId, now - 86_400_000) as FomoPositionTarget[];
}

/** Apply one complete per-user positions response to tracked dashboard pairs. */
export function syncFomoPositionsSnapshot(
  fomoUserId: string,
  positions: readonly FomoPositionInput[],
  checkedAt: number,
): void {
  const db = getDb();
  const run = db.transaction(() => {
    const dashboardCas = new Set(listTrackedCas().map((ca) => `${ca.chain}:${ca.address}`));
    const incoming = new Map<string, FomoPositionInput>();
    for (const position of positions) {
      const ca = canonicalCa(position.ca, position.chain);
      if (!dashboardCas.has(`${position.chain}:${ca}`)) continue;
      incoming.set(`${position.chain}:${ca}`, { ...position, ca, fomo_user_id: fomoUserId });
    }
    const targets = new Map<string, FomoPositionTarget>();
    for (const target of listFomoPositionTargets(fomoUserId, checkedAt)) {
      const ca = canonicalCa(target.ca, target.chain);
      if (dashboardCas.has(`${target.chain}:${ca}`)) targets.set(`${target.chain}:${ca}`, { ...target, ca });
    }
    for (const [key, position] of incoming) {
      targets.set(key, { chain: position.chain, ca: position.ca });
    }
    for (const [key, target] of targets) {
      const position = incoming.get(key);
      upsertFomoPosition(position ?? {
        fomo_user_id: fomoUserId,
        ca: target.ca,
        chain: target.chain,
        trade_id: null,
        status: 'closed',
        amount: 0,
        cost_basis_usd: null,
        avg_entry_price: null,
        price_usd: null,
        realized_pnl_usd: null,
        unrealized_pnl_usd: null,
        fetched_at: checkedAt,
      });
    }
    upsertFomoPositionSnapshot({ fomo_user_id: fomoUserId, checked_at: checkedAt });
  });
  run();
}

export interface FomoPositionSnapshot {
  fomo_user_id: string;
  checked_at: number;
}

export function upsertFomoPositionSnapshot(input: FomoPositionSnapshot): void {
  getDb().prepare(
    `INSERT INTO fomo_position_snapshots (fomo_user_id, checked_at)
     VALUES (?, ?)
     ON CONFLICT(fomo_user_id) DO UPDATE SET checked_at=excluded.checked_at`,
  ).run(input.fomo_user_id, input.checked_at);
}
export function getFomoPositionSnapshot(fomoUserId: string): FomoPositionSnapshot | undefined {
  return getDb()
    .prepare('SELECT fomo_user_id, checked_at FROM fomo_position_snapshots WHERE fomo_user_id = ?')
    .get(fomoUserId) as FomoPositionSnapshot | undefined;
}

export type FomoApiRequestEndpoint = 'positions' | 'swaps';
export interface FomoApiRequestState {
  fomo_user_id: string;
  endpoint: FomoApiRequestEndpoint;
  last_attempt_at: number;
  next_eligible_at: number;
  consecutive_failures: number;
  last_outcome: string;
}

export function getFomoApiRequestState(
  fomoUserId: string,
  endpoint: FomoApiRequestEndpoint,
): FomoApiRequestState | undefined {
  return getDb()
    .prepare('SELECT * FROM fomo_api_request_state WHERE fomo_user_id = ? AND endpoint = ?')
    .get(fomoUserId, endpoint) as FomoApiRequestState | undefined;
}

export function saveFomoApiRequestState(input: FomoApiRequestState): void {
  getDb().prepare(`
    INSERT INTO fomo_api_request_state
      (fomo_user_id, endpoint, last_attempt_at, next_eligible_at, consecutive_failures, last_outcome)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(fomo_user_id, endpoint) DO UPDATE SET
      last_attempt_at = excluded.last_attempt_at,
      next_eligible_at = excluded.next_eligible_at,
      consecutive_failures = excluded.consecutive_failures,
      last_outcome = excluded.last_outcome
  `).run(
    input.fomo_user_id,
    input.endpoint,
    input.last_attempt_at,
    input.next_eligible_at,
    input.consecutive_failures,
    input.last_outcome,
  );
}


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
  if (config.showFomo) return;
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
