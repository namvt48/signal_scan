import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { getDb, open } from './db.js';
import { log } from './log.js';
import { migrateLegacyMarketDatabases } from './market-data-migration.js';

function main(): void {
  if (process.argv.length !== 3 || process.argv[2] !== '--force') {
    throw new Error('explicit --force is required for legacy market reconciliation');
  }
  const sources = [
    { id: 'a' as const, path: process.env.MARKET_LEGACY_A_DB_PATH ?? '/legacy-a/signal_scan.db' },
    { id: 'b' as const, path: process.env.MARKET_LEGACY_B_DB_PATH ?? '/legacy-b/signal_scan.db' },
  ];
  const missing = sources.filter((source) => !existsSync(source.path));
  if (missing.length > 0) {
    throw new Error(`legacy database files missing for instance(s): ${missing.map((source) => source.id).join(', ')}`);
  }

  open(config.dbPath);
  try {
    const processedRows = migrateLegacyMarketDatabases(sources, { force: true });
    log.info(`[market-data] final legacy reconciliation completed; public rows processed=${processedRows}`);
  } finally {
    getDb().close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
