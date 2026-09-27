// Standalone zero-score CA gate over the whole tracked_cas table.
//   npx tsx scripts/prune-zero-score-cas.ts          -> dry-run: report only, NO writes
//   npx tsx scripts/prune-zero-score-cas.ts --apply  -> delete exactly the reported set
// DB path resolves from the app's own config (DB_PATH env, default ./data/signal_scan.db).
import { existsSync } from 'node:fs';
import { config } from '../src/config.js';
import { deleteTrackedCasByIds, getTokenState, listCaScoreGateCandidates, listTrackedCas, open } from '../src/db.js';
import { getThresholds } from '../src/settings.js';
import { nansenScore } from '../src/signals.js';

function main(): void {
  if (!existsSync(config.dbPath)) {
    console.error(`[prune-zero-score] DB not found at ${config.dbPath} — set DB_PATH or run from the server dir`);
    process.exitCode = 1;
    return;
  }
  open(config.dbPath);
  const apply = process.argv.includes('--apply');
  const th = getThresholds();
  const rows = listCaScoreGateCandidates();
  const table: Record<string, string | number | boolean | null>[] = [];
  const doomedIds: string[] = [];
  let incomplete = 0;
  for (const r of rows) {
    const s = nansenScore(getTokenState(r.address, r.chain), th);
    if (!s.complete) incomplete += 1;
    if (s.complete && s.score === 0) doomedIds.push(r.id);
    table.push({
      ca: r.address,
      chain: r.chain,
      symbol: r.symbol,
      vol24h: r.volume24h,
      fresh: s.fresh ?? null,
      t100: s.t100Multiple ?? null,
      lf: s.lf ?? null,
      score: s.score,
      complete: s.complete,
      added_at: r.added_at,
      note: r.note,
    });
  }
  console.table(table);
  if (apply) {
    const deleted = deleteTrackedCasByIds(doomedIds);
    console.log(`deleted ${deleted} tracked CAs`);
    console.log(`remaining tracked CAs: ${listTrackedCas().length}`);
  } else {
    console.log(`would delete ${doomedIds.length} of ${rows.length} tracked CAs`);
    console.log(`incomplete (kept): ${incomplete}`);
  }
}

try {
  main();
} catch (e) {
  console.error('[prune-zero-score] failed:', e);
  process.exitCode = 1;
}
