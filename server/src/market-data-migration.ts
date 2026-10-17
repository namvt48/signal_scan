import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { getDb } from './db.js';
import { log } from './log.js';

export interface LegacyMarketSource {
  id: 'a' | 'b';
  path: string;
}

const MERGED_TABLES = [
  { name: 'token_state', keys: ['ca', 'chain'], freshness: 'fetched_at' },
  { name: 'metric_poll_cache', keys: ['ca', 'chain', 'kind'], freshness: 'last_attempt_at' },
  { name: 'nansen_series', keys: ['ca', 'chain', 'window'], freshness: 'taken_at' },
] as const;

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function tableExists(db: Database.Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function columns(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${identifier(table)})`) as { name: string }[]).map((column) => column.name);
}

function mergeTable(
  source: Database.Database,
  destination: Database.Database,
  table: typeof MERGED_TABLES[number],
): number {
  if (!tableExists(source, table.name)) return 0;
  const sourceColumns = new Set(columns(source, table.name));
  const fields = columns(destination, table.name).filter((column) => sourceColumns.has(column));
  if (table.keys.some((key) => !fields.includes(key))) return 0;

  const names = fields.map(identifier).join(', ');
  const placeholders = fields.map(() => '?').join(', ');
  const keySet = new Set<string>(table.keys);
  const updates = fields
    .filter((field) => !keySet.has(field))
    .map((field) => `${identifier(field)} = COALESCE(excluded.${identifier(field)}, ${identifier(table.name)}.${identifier(field)})`)
    .join(', ');
  const conflict = table.keys.map(identifier).join(', ');
  const statement = destination.prepare(
    `INSERT INTO ${identifier(table.name)} (${names}) VALUES (${placeholders})
     ON CONFLICT (${conflict}) DO UPDATE SET ${updates}
     WHERE COALESCE(excluded.${identifier(table.freshness)}, 0) >= COALESCE(${identifier(table.name)}.${identifier(table.freshness)}, 0)`,
  );
  const rows = source.prepare(`SELECT ${names} FROM ${identifier(table.name)}`).all() as Record<string, unknown>[];
  for (const row of rows) statement.run(...fields.map((field) => row[field]));
  return rows.length;
}

function mergeHolderSnapshots(source: Database.Database, destination: Database.Database): number {
  if (!tableExists(source, 'holder_snapshots')) return 0;
  const sourceColumns = new Set(columns(source, 'holder_snapshots'));
  if (!['ca', 'chain', 'taken_at', 'holders_json'].every((field) => sourceColumns.has(field))) return 0;
  const rows = source.prepare(
    'SELECT ca, chain, taken_at, holders_json FROM holder_snapshots ORDER BY taken_at',
  ).all() as { ca: string | null; chain: string | null; taken_at: number | null; holders_json: string | null }[];
  const insert = destination.prepare(
    `INSERT INTO holder_snapshots (ca, chain, taken_at, holders_json)
     SELECT ?, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM holder_snapshots WHERE ca IS ? AND chain IS ? AND taken_at IS ? AND holders_json IS ?
     )`,
  );
  for (const row of rows) {
    insert.run(row.ca, row.chain, row.taken_at, row.holders_json, row.ca, row.chain, row.taken_at, row.holders_json);
  }
  return rows.length;
}

function mergeSystemAnchor(source: Database.Database, destination: Database.Database): void {
  if (!tableExists(source, 'settings')) return;
  const row = source.prepare("SELECT value FROM settings WHERE key = 'systemDeployAt'").get() as { value: string } | undefined;
  const candidate = Number(row?.value);
  if (!Number.isFinite(candidate) || candidate <= 0) return;
  const currentRow = destination.prepare("SELECT value FROM settings WHERE key = 'systemDeployAt'").get() as { value: string } | undefined;
  const current = Number(currentRow?.value);
  const anchor = Number.isFinite(current) && current > 0 ? Math.min(current, candidate) : candidate;
  destination.prepare("INSERT INTO settings (key, value) VALUES ('systemDeployAt', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(String(anchor));
}

/** Import only public market tables; private tracked lists, wallets, trades and holdings stay per instance. */
export function migrateLegacyMarketDatabases(
  sources: readonly LegacyMarketSource[],
  options: { force?: boolean } = {},
): number {
  const destination = getDb();
  destination.exec(`CREATE TABLE IF NOT EXISTS market_legacy_imports (source TEXT PRIMARY KEY, imported_at INTEGER NOT NULL)`);
  const mark = destination.prepare(
    'INSERT INTO market_legacy_imports (source, imported_at) VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET imported_at = excluded.imported_at',
  );
  let importedRows = 0;

  for (const source of sources) {
    if (!existsSync(source.path)) continue;
    const done = destination.prepare('SELECT 1 FROM market_legacy_imports WHERE source = ?').get(source.id);
    if (done !== undefined && !options.force) continue;
    const legacy = new Database(source.path, { readonly: true, fileMustExist: true });
    try {
      const importSource = destination.transaction(() => {
        let count = 0;
        for (const table of MERGED_TABLES) count += mergeTable(legacy, destination, table);
        count += mergeHolderSnapshots(legacy, destination);
        mergeSystemAnchor(legacy, destination);
        mark.run(source.id, Date.now());
        return count;
      });
      importedRows += importSource();
      log.info(`[market-data] ${options.force ? 'reconciled' : 'imported'} public rows from legacy instance ${source.id}`);
    } finally {
      legacy.close();
    }
  }
  return importedRows;
}
