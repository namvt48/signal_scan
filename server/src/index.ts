// Entry: open db -> seed (mock only) -> build provider -> start poller -> listen.
// All live data comes from Nansen since 2026-09-09 (GMGN retired).

import { config } from './config.js';
import { log } from './log.js';
import { listTrackedCas, open, seedIfEmpty } from './db.js';
import { MockProvider } from './providers/mock.js';
import { GmgnMarketProvider } from './providers/gmgn.js';
import { CompositeProvider } from './providers/composite.js';
import { NansenApiClient, NansenMarketProvider } from './providers/nansen.js';
import { browserPostJson } from './crawl.js';
import type { MarketDataProvider } from './providers/provider.js';
import { startPoller } from './poller.js';
import { cacheKey, loadSetupCache, pruneSetupCache } from './setup-cache.js';
import { createApp } from './api.js';

open(config.dbPath);
seedIfEmpty();

// Setup file cache (plan setup-fill-on-add §4): load ONCE at startup before any
// sweep can consult or write it, then drop entries whose CA left the queue
// (pruneSetupCache's empty-set guard keeps a just-reset DB from wiping the file).
const setupCache = loadSetupCache();
const setupPruned = pruneSetupCache(Date.now(), new Set(listTrackedCas().map((r) => cacheKey(r.address, r.chain))));
log.info(`[setup-cache] loaded ${setupCache.size} entries from ${config.setupCacheFile} (pruned ${setupPruned})`);

// Credit API client: first-add token-information (1cr) + non-sol wallet balances.
// Absent key -> the free app-question metrics still run; the credit paths are skipped.
const nansenApi = config.nansenApiKey ? new NansenApiClient(config.nansenApiKey) : null;
const gmgnApi = config.gmgnApiKey ? new GmgnMarketProvider(config.gmgnApiKey) : null;

function buildProvider(): MarketDataProvider {
  if (config.mode === 'mock') return new MockProvider();
  // app-questions door rides the browser transport (CF blocks non-browser TLS).
  const nansen = new NansenMarketProvider((url, body) => browserPostJson(url, body), nansenApi, listTrackedCas);
  if (config.mode !== 'gmgn') return nansen;
  if (!gmgnApi) {
    log.warn('[index] MODE=gmgn but GMGN_API_KEY unset → nansen only');
    return nansen;
  }
  return new CompositeProvider(gmgnApi, nansen);
}

const provider = buildProvider();

startPoller(provider, nansenApi);

createApp(provider.name).listen(config.port, () => {
  log.info(
    `[index] listening on :${config.port} mode=${config.mode} provider=${provider.name}` +
      ` nansenApi=${nansenApi ? 'on' : 'off'} gmgnApi=${gmgnApi ? 'on' : 'off'}` +
      ` chartSweep=${config.crawlEnabled ? 'on' : 'off'} db=${config.dbPath}`,
  );
});
