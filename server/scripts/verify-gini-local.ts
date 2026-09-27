// Live verify of the gini-stats card set through the REAL repo code path.
//   npx tsx scripts/verify-gini-local.ts                     -> sidecar transport (prod path)
//   npx tsx scripts/verify-gini-local.ts --print-bodies [CA] -> exact request bodies (paste into a CF-cleared browser)
//   npx tsx scripts/verify-gini-local.ts --parse g.json b.json [CA] -> run prod parsers over saved responses
import { readFileSync } from 'node:fs';
import { browserPostJson } from '../src/crawl.js';
import {
  NANSEN_HOLDERS_BALANCES_URL,
  NANSEN_HOLDERS_GINI_URL,
  holdersBalancesBody,
  holdersBalancesToHolderRows,
  holdersGiniBody,
  parseGiniStats,
} from '../src/providers/nansen.js';

const pos = process.argv.slice(2).filter((a) => !a.startsWith('--') && !a.endsWith('.json') && !a.includes('/'));
const CA = pos[0] ?? 'zj1jpp7QMveWHLs61vL9KMZf254KvW7j4AAmBF8ry2k';
const CHAIN = 'sol';

function report(giniJson: unknown, balJson: unknown): void {
  const stats = parseGiniStats(giniJson);
  const rows = holdersBalancesToHolderRows(balJson);
  console.log(
    JSON.stringify(
      {
        ca: CA,
        chain: CHAIN,
        holders: stats.holders,
        t100SupplyPct: stats.t100SupplyPct,
        freshSupplyPct: stats.freshSupplyPct,
        medianBalanceUsd: stats.medianBalanceUsd,
        top100Rows: rows.length,
        sumPercentOwnershipPct: +(rows.reduce((a, r) => a + r.amountPct, 0) * 100).toFixed(4),
      },
      null,
      2,
    ),
  );
  const ok =
    stats.holders > 0 &&
    stats.freshSupplyPct >= 0 &&
    stats.freshSupplyPct <= 100 &&
    stats.t100SupplyPct !== undefined &&
    stats.medianBalanceUsd !== undefined &&
    rows.length >= 50;
  console.log(ok ? 'VERIFY OK' : 'VERIFY FAIL');
  process.exit(ok ? 0 : 1);
}

if (process.argv.includes('--print-bodies')) {
  console.log(
    JSON.stringify({ giniUrl: NANSEN_HOLDERS_GINI_URL, gini: holdersGiniBody(CA, CHAIN), balUrl: NANSEN_HOLDERS_BALANCES_URL, bal: holdersBalancesBody(CA, CHAIN) }, null, 2),
  );
  process.exit(0);
}

const jsonArgs = process.argv.slice(2).filter((a) => a.endsWith('.json'));
if (process.argv.includes('--parse')) {
  report(JSON.parse(readFileSync(jsonArgs[0]!, 'utf8')), JSON.parse(readFileSync(jsonArgs[1]!, 'utf8')));
}

const gini = await browserPostJson(NANSEN_HOLDERS_GINI_URL, holdersGiniBody(CA, CHAIN));
if (gini.status !== 200) {
  console.error('gini HTTP', gini.status);
  process.exit(1);
}
const bal = await browserPostJson(NANSEN_HOLDERS_BALANCES_URL, holdersBalancesBody(CA, CHAIN));
report(gini.json, bal.json);
