import { getDb, listWallets, type WalletRow } from './db.js';
import { getTrackingSinceMs, listTrackedCasSinceDeploy } from './settings.js';
import type { WalletTokenHolding } from './providers/provider.js';
import type { Chain } from './shared/chain.js';

export interface DiscoveryWallet {
  wallet_id: string;
  address: string;
  chain: Chain;
  epoch: number;
  frontier: number;
  retry_at: number;
  attempts: number;
  last_served: number;
}

export interface DiscoveryTarget {
  ca: string;
  revision: number;
}

export interface DiscoveryBatch {
  wallet: DiscoveryWallet;
  targets: DiscoveryTarget[];
  frontier: number;
}

type LegacyJob = {
  wallet_id: string;
  address: string;
  chain: string;
  cas: string;
  done: string;
  generation: number;
  retry_at: number;
  attempts: number;
};

const initialized = new WeakSet<object>();
const RETRY_MS = 30_000;

function nextRevision(): number {
  const row = getDb().prepare("UPDATE wallet_discovery_meta SET value=value+1 WHERE key='revision' RETURNING value").get() as
    { value: number } | undefined;
  if (!row) throw new Error('wallet discovery revision counter is missing');
  return row.value;
}

function parseStringArray(value: string): string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item): item is string => typeof item === 'string') ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Create the durable queue and migrate legacy per-wallet CA lists exactly once per DB connection. */
export function initializeDiscoveryState(): void {
  const db = getDb();
  if (initialized.has(db)) return;

  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS wallet_discovery_meta (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO wallet_discovery_meta(key, value) VALUES ('revision', 0);
      CREATE TABLE IF NOT EXISTS wallet_discovery_targets (
        chain TEXT NOT NULL,
        ca TEXT NOT NULL,
        revision INTEGER NOT NULL,
        PRIMARY KEY(chain, ca)
      );
      CREATE INDEX IF NOT EXISTS idx_wallet_discovery_targets_revision
        ON wallet_discovery_targets(chain, revision);
      CREATE TABLE IF NOT EXISTS wallet_discovery_wallets (
        wallet_id TEXT PRIMARY KEY REFERENCES wallets(id) ON DELETE CASCADE,
        address TEXT NOT NULL,
        chain TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        frontier INTEGER NOT NULL,
        retry_at INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_served INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS wallet_discovery_exceptions (
        wallet_id TEXT NOT NULL REFERENCES wallet_discovery_wallets(wallet_id) ON DELETE CASCADE,
        chain TEXT NOT NULL,
        ca TEXT NOT NULL,
        retry_at INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        completed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(wallet_id, chain, ca)
      );
    `);

    const legacyExists = Boolean(db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='wallet_holdings_discovery'",
    ).get());
    const legacy = legacyExists
      ? db.prepare('SELECT * FROM wallet_holdings_discovery').all() as LegacyJob[]
      : [];

    const targetExists = db.prepare('SELECT 1 FROM wallet_discovery_targets WHERE chain=? AND ca=?');
    const insertTarget = db.prepare('INSERT OR IGNORE INTO wallet_discovery_targets(chain, ca, revision) VALUES (?, ?, ?)');
    for (const ca of listTrackedCasSinceDeploy()) {
      if (targetExists.get(ca.chain, ca.address)) continue;
      insertTarget.run(ca.chain, ca.address, nextRevision());
    }

    const wallets = new Map(listWallets().map((wallet) => [wallet.id, wallet] as const));
    const insertWallet = db.prepare(`
      INSERT INTO wallet_discovery_wallets(wallet_id, address, chain, epoch, frontier)
      VALUES (?, ?, ?, 1, 0)
      ON CONFLICT(wallet_id) DO NOTHING
    `);
    for (const wallet of wallets.values()) insertWallet.run(wallet.id, wallet.address, wallet.chain);

    const putTarget = db.prepare('INSERT OR IGNORE INTO wallet_discovery_targets(chain, ca, revision) VALUES (?, ?, ?)');
    const setFrontier = db.prepare('UPDATE wallet_discovery_wallets SET frontier=0 WHERE wallet_id=?');
    const putException = db.prepare(`
      INSERT OR REPLACE INTO wallet_discovery_exceptions(wallet_id, chain, ca, retry_at, attempts, completed)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const getRevision = db.prepare('SELECT revision FROM wallet_discovery_targets WHERE chain=? AND ca=?');

    for (const job of legacy) {
      const wallet = wallets.get(job.wallet_id);
      if (!wallet || job.address !== wallet.address || job.chain !== wallet.chain) continue;
      const scopedCas = parseStringArray(job.cas);
      const completedCas = parseStringArray(job.done);
      if (!scopedCas || !completedCas) continue;

      const scope = [...new Set(scopedCas)];
      for (const ca of scope) {
        if (targetExists.get(wallet.chain, ca)) continue;
        putTarget.run(wallet.chain, ca, nextRevision());
      }
      const completed = new Set(completedCas);
      for (const ca of scope) {
        if (!getRevision.get(wallet.chain, ca)) continue;
        putException.run(
          wallet.id,
          wallet.chain,
          ca,
          completed.has(ca) ? 0 : job.retry_at ?? 0,
          completed.has(ca) ? 0 : job.attempts ?? 0,
          completed.has(ca) ? 1 : 0,
        );
      }
      setFrontier.run(wallet.id);
    }

    db.exec(`
      DELETE FROM wallet_discovery_wallets
       WHERE NOT EXISTS (SELECT 1 FROM wallets w WHERE w.id = wallet_discovery_wallets.wallet_id);
      DROP TABLE IF EXISTS wallet_holdings_discovery;
    `);
  });

  migrate();
  initialized.add(db);
}

/** Append new targets; refreshExisting creates a new revision only for explicit reactivation/refresh. */
export function syncDiscoveryTargets(
  cas: readonly { address: string; chain: Chain }[],
  refreshExisting = false,
): number {
  initializeDiscoveryState();
  const db = getDb();
  let changed = 0;
  const sync = db.transaction(() => {
    const getTarget = db.prepare('SELECT revision FROM wallet_discovery_targets WHERE chain=? AND ca=?');
    const putTarget = db.prepare(`
      INSERT INTO wallet_discovery_targets(chain, ca, revision) VALUES (?, ?, ?)
      ON CONFLICT(chain, ca) DO UPDATE SET revision=excluded.revision
    `);
    const clearExceptions = db.prepare('DELETE FROM wallet_discovery_exceptions WHERE chain=? AND ca=?');
    const uniqueTargets = new Map(cas.map((target) => [`${target.chain}:${target.address}`, target] as const));

    for (const target of uniqueTargets.values()) {
      const existing = getTarget.get(target.chain, target.address);
      if (existing && !refreshExisting) continue;
      putTarget.run(target.chain, target.address, nextRevision());
      if (existing) clearExceptions.run(target.chain, target.address);
      changed++;
    }
  });
  sync();
  return changed;
}

/** Remove discovery targets for CAs outside the deployment boundary or now inactive. */
export function pruneDiscoveryTargets(): void {
  initializeDiscoveryState();
  const db = getDb();
  const prune = db.transaction(() => {
    const cutoff = new Date(getTrackingSinceMs()).toISOString();
    const removeOldExceptions = db.prepare(`
      DELETE FROM wallet_discovery_exceptions
       WHERE NOT EXISTS (
         SELECT 1 FROM tracked_cas t
          WHERE t.chain = wallet_discovery_exceptions.chain
            AND t.address = wallet_discovery_exceptions.ca
            AND t.status != 'inactive'
            AND t.added_at >= ?
       )
    `);
    const removeOldTargets = db.prepare(`
      DELETE FROM wallet_discovery_targets
       WHERE NOT EXISTS (
         SELECT 1 FROM tracked_cas t
          WHERE t.chain = wallet_discovery_targets.chain
            AND t.address = wallet_discovery_targets.ca
            AND t.status != 'inactive'
            AND t.added_at >= ?
       )
    `);
    removeOldExceptions.run(cutoff);
    removeOldTargets.run(cutoff);
  });
  prune();
}

export function ensureDiscoveryWallet(wallet: WalletRow, reset = false): DiscoveryWallet {
  initializeDiscoveryState();
  const db = getDb();
  const current = db.prepare('SELECT * FROM wallet_discovery_wallets WHERE wallet_id=?').get(wallet.id) as
    DiscoveryWallet | undefined;

  if (!current) {
    db.prepare(`
      INSERT INTO wallet_discovery_wallets(wallet_id, address, chain, epoch, frontier)
      VALUES (?, ?, ?, 1, 0)
    `).run(wallet.id, wallet.address, wallet.chain);
  } else if (reset || current.address !== wallet.address || current.chain !== wallet.chain) {
    const update = db.transaction(() => {
      db.prepare(`
        UPDATE wallet_discovery_wallets
           SET address=?, chain=?, epoch=epoch+1, frontier=0, retry_at=0, attempts=0
         WHERE wallet_id=?
      `).run(wallet.address, wallet.chain, wallet.id);
      db.prepare('DELETE FROM wallet_discovery_exceptions WHERE wallet_id=?').run(wallet.id);
    });
    update();
  }

  return db.prepare('SELECT * FROM wallet_discovery_wallets WHERE wallet_id=?').get(wallet.id) as DiscoveryWallet;
}

export function listDueDiscoveryWallets(now: number): DiscoveryWallet[] {
  initializeDiscoveryState();
  return getDb().prepare(`
    SELECT w.*
      FROM wallet_discovery_wallets w
     WHERE w.retry_at <= ?
       AND (
         EXISTS (
           SELECT 1
             FROM wallet_discovery_targets t
             LEFT JOIN wallet_discovery_exceptions e
               ON e.wallet_id=w.wallet_id AND e.chain=t.chain AND e.ca=t.ca
            WHERE t.chain=w.chain AND t.revision>w.frontier
              AND (e.completed IS NULL OR (e.completed=0 AND e.retry_at<=?))
         )
         OR EXISTS (
           SELECT 1 FROM wallet_discovery_exceptions e
            WHERE e.wallet_id=w.wallet_id AND e.completed=0 AND e.retry_at<=?
         )
       )
     ORDER BY w.last_served, w.wallet_id
  `).all(now, now, now) as DiscoveryWallet[];
}

export function readDiscoveryBatch(walletId: string, now: number, limit: number): DiscoveryBatch | undefined {
  initializeDiscoveryState();
  const db = getDb();
  const wallet = db.prepare('SELECT * FROM wallet_discovery_wallets WHERE wallet_id=?').get(walletId) as
    DiscoveryWallet | undefined;
  if (!wallet) return undefined;

  const limitClause = limit === Infinity ? '' : 'LIMIT ?';
  const parameters = [walletId, wallet.chain, wallet.frontier, now, now];
  if (limit !== Infinity) parameters.push(Math.max(0, limit));
  const targets = db.prepare(`
    SELECT t.ca, t.revision
      FROM wallet_discovery_targets t
      LEFT JOIN wallet_discovery_exceptions e
        ON e.wallet_id=? AND e.chain=t.chain AND e.ca=t.ca
     WHERE t.chain=?
       AND (t.revision>? OR (e.completed=0 AND e.retry_at<=?))
       AND (e.ca IS NULL OR e.completed=0)
       AND (e.retry_at IS NULL OR e.retry_at<=?)
     ORDER BY t.revision
     ${limitClause}
  `).all(...parameters) as DiscoveryTarget[];
  if (targets.length === 0) return undefined;

  const newTargetRevisions = targets.filter((target) => target.revision > wallet.frontier).map((target) => target.revision);
  return {
    wallet,
    targets,
    frontier: Math.max(wallet.frontier, ...newTargetRevisions),
  };
}

/** Apply the database write and advance progress atomically, rejecting stale identities/revisions. */
export function commitDiscoveryBatch(
  batch: DiscoveryBatch,
  rows: readonly WalletTokenHolding[],
  apply: (validRows: WalletTokenHolding[]) => void,
  now: number,
): boolean {
  initializeDiscoveryState();
  const db = getDb();
  let accepted = false;
  const commit = db.transaction(() => {
    const wallet = db.prepare('SELECT * FROM wallet_discovery_wallets WHERE wallet_id=?').get(batch.wallet.wallet_id) as
      DiscoveryWallet | undefined;
    const identity = db.prepare('SELECT address,chain FROM wallets WHERE id=?').get(batch.wallet.wallet_id) as
      { address: string; chain: Chain } | undefined;
    if (
      !wallet || !identity || wallet.epoch !== batch.wallet.epoch ||
      wallet.address !== batch.wallet.address || wallet.chain !== batch.wallet.chain ||
      identity.address !== wallet.address || identity.chain !== wallet.chain
    ) return;

    const getRevision = db.prepare('SELECT revision FROM wallet_discovery_targets WHERE chain=? AND ca=?');
    const currentTargets = batch.targets.filter((target) => {
      const current = getRevision.get(wallet.chain, target.ca) as { revision: number } | undefined;
      return current?.revision === target.revision;
    });
    const requested = new Set(currentTargets.map((target) => target.ca));
    const validRows = new Map<string, WalletTokenHolding>();
    for (const row of rows) {
      if (requested.has(row.ca) && Number.isFinite(row.amount) && row.amount >= 0 && !validRows.has(row.ca)) {
        validRows.set(row.ca, row);
      }
    }

    apply([...validRows.values()]);
    const clearException = db.prepare(`
      DELETE FROM wallet_discovery_exceptions
       WHERE wallet_id=? AND chain=? AND ca=?
    `);
    const markRetry = db.prepare(`
      INSERT INTO wallet_discovery_exceptions(wallet_id, chain, ca, retry_at, attempts, completed)
      VALUES (?, ?, ?, ?, 1, 0)
      ON CONFLICT(wallet_id, chain, ca)
      DO UPDATE SET retry_at=excluded.retry_at, attempts=wallet_discovery_exceptions.attempts+1, completed=0
    `);

    for (const target of currentTargets) {
      if (validRows.has(target.ca)) clearException.run(wallet.wallet_id, wallet.chain, target.ca);
      else markRetry.run(wallet.wallet_id, wallet.chain, target.ca, now + RETRY_MS);
    }
    db.prepare(`
      UPDATE wallet_discovery_wallets
         SET frontier=MAX(frontier, ?), retry_at=0, attempts=0, last_served=?
       WHERE wallet_id=? AND epoch=?
    `).run(batch.frontier, now, wallet.wallet_id, wallet.epoch);
    db.prepare(`
      DELETE FROM wallet_discovery_exceptions
       WHERE wallet_id=? AND chain=? AND completed=1
         AND EXISTS (
           SELECT 1 FROM wallet_discovery_targets t
            WHERE t.chain=wallet_discovery_exceptions.chain
              AND t.ca=wallet_discovery_exceptions.ca
              AND t.revision<=?
         )
    `).run(wallet.wallet_id, wallet.chain, batch.frontier);
    accepted = true;
  });
  commit();
  return accepted;
}

export function failDiscoveryBatch(batch: DiscoveryBatch, now: number, retryMs: number): void {
  initializeDiscoveryState();
  getDb().prepare(`
    UPDATE wallet_discovery_wallets
       SET retry_at=?, attempts=attempts+1
     WHERE wallet_id=? AND epoch=? AND address=? AND chain=?
       AND EXISTS (
         SELECT 1 FROM wallets w
          WHERE w.id=wallet_discovery_wallets.wallet_id
            AND w.address=? AND w.chain=?
       )
  `).run(
    now + retryMs,
    batch.wallet.wallet_id,
    batch.wallet.epoch,
    batch.wallet.address,
    batch.wallet.chain,
    batch.wallet.address,
    batch.wallet.chain,
  );
}

export function pendingDiscoveryPairs(): Set<string> {
  initializeDiscoveryState();
  pruneDiscoveryTargets();
  const rows = getDb().prepare(`
    SELECT DISTINCT t.chain || ':' || t.ca AS pair
      FROM wallet_discovery_targets t
      JOIN wallet_discovery_wallets w ON w.chain=t.chain
     WHERE (t.revision>w.frontier
       AND NOT EXISTS (
         SELECT 1 FROM wallet_discovery_exceptions e
          WHERE e.wallet_id=w.wallet_id AND e.chain=t.chain
            AND e.ca=t.ca AND e.completed=1
       ))
        OR EXISTS (
         SELECT 1 FROM wallet_discovery_exceptions e
          WHERE e.wallet_id=w.wallet_id AND e.chain=t.chain
            AND e.ca=t.ca AND e.completed=0
       )
  `).all() as { pair: string }[];
  return new Set(rows.map(({ pair }) => pair));
}

export function nextDiscoveryRunAt(): number | undefined {
  initializeDiscoveryState();
  const row = getDb().prepare(`
    SELECT MIN(MAX(w.retry_at, COALESCE(e.retry_at, 0))) AS at
      FROM wallet_discovery_wallets w
      JOIN wallet_discovery_targets t ON t.chain=w.chain
      LEFT JOIN wallet_discovery_exceptions e
        ON e.wallet_id=w.wallet_id AND e.chain=t.chain AND e.ca=t.ca
     WHERE (t.revision>w.frontier OR (e.completed=0 AND e.ca IS NOT NULL))
       AND (e.completed IS NULL OR e.completed=0)
  `).get() as { at: number | null };
  return row.at ?? undefined;
}
