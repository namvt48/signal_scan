import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { open, getTokenState } = await import('../src/db.js');
const { updateTokenMetrics } = await import('../src/ingest.js');
const { loadSetupCache } = await import('../src/setup-cache.js');
const { refreshSeries, setPollerDeps } = await import('../src/poller.js');
const { NansenApiClient } = await import('../src/providers/nansen.js');
import type { MarketDataProvider } from '../src/providers/provider.js';
import type { Chain } from '../src/shared/chain.js';

const stub: MarketDataProvider = {
  name: 'stub-pa1',
  tokenInfo: async () => {
    throw new Error('unused');
  },
  metric: async () => ({}),
  walletTokenHoldings: async () => [],
};

const CA = 'bveCUi7gPHCKQWjc1ZgUf4rRSfkqsiUQeu5UuYoLooT';
const CHAIN: Chain = 'sol';
const DEP = Date.parse('2026-09-16T04:48:00Z');

open(':memory:');
loadSetupCache(join(mkdtempSync(join(tmpdir(), 'pa1-live-')), 'nansen-cache.json'));
updateTokenMetrics(CA, CHAIN, { supply: 1_000_000_000, deployedAt: DEP });
setPollerDeps(stub, new NansenApiClient(process.env.NANSEN_API_KEY ?? ''));

const t0 = Date.now();
await refreshSeries(CA, CHAIN);
const ms = Date.now() - t0;

const st = getTokenState(CA, CHAIN);
if (!st) throw new Error('no token_state row');
const expectMult = 181868765.89 / 108619497.37;
const expectAnchor = Date.parse('2026-09-16T00:00:00Z');
console.log('elapsed_ms      =', ms);
console.log('t100_multiple   =', st.t100_multiple, '(expect', expectMult.toFixed(4) + ')');
console.log('t100_pct        =', st.t100_pct);
console.log('anchor_at       =', st.anchor_at, '=', new Date(st.anchor_at ?? 0).toISOString());
console.log('genesis_bal     =', st.genesis_bal);
console.log('bal_trough_24h  =', st.bal_trough_24h, 'bal_peak_24h =', st.bal_peak_24h);
const okMult = st.t100_multiple != null && Math.abs(st.t100_multiple - expectMult) < 1e-6;
const okAnchor = st.anchor_at === expectAnchor;
console.log('VERDICT_PA1_LIVE =', okMult && okAnchor ? 'PASS' : 'FAIL');
