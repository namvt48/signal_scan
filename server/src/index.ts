// Entry: open db -> seed (mock only) -> build provider -> start poller -> listen.
// All live data comes from Nansen since 2026-09-09 (GMGN retired).

import { config } from './config.js';
import { log } from './log.js';
import { listTrackedCas, open, seedIfEmpty } from './db.js';
import { MockProvider } from './providers/mock.js';
import { GmgnMarketProvider } from './providers/gmgn.js';
import { CompositeProvider } from './providers/composite.js';
import { NansenApiClient, NansenMarketProvider, doorEndpointFor } from './providers/nansen.js';
import { gatewayClientFromEnv, GW_NANSEN_DOOR_PATH } from './gateway-client.js';
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
// The gateway injects GMGN's key (todo 13), so the provider is built unconditionally.
const gmgnApi = new GmgnMarketProvider(config.gmgnApiKey);

// The free app-questions door rides the gateway too: the api process never builds
// a DoorPool, it POSTs the question to the gateway's door route.
const gateway = gatewayClientFromEnv();
async function doorPostJson(url: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const endpoint = doorEndpointFor(url);
  if (endpoint === null) throw new Error(`[index] unknown nansen door url ${url}`);
  const env = await gateway.call(GW_NANSEN_DOOR_PATH, { endpoint, body });
  return { status: env.status, json: env.body === null ? null : (JSON.parse(env.body) as unknown) };
}

function buildProvider(): MarketDataProvider {
  if (config.mode === 'mock') return new MockProvider();
  const nansen = new NansenMarketProvider(doorPostJson, nansenApi, listTrackedCas);
  if (config.mode !== 'gmgn') return nansen;
  return new CompositeProvider(gmgnApi, nansen);
}

const provider = buildProvider();

startPoller(provider, nansenApi);

createApp(provider.name).listen(config.port, () => {
  log.info(
    `[index] listening on :${config.port} mode=${config.mode} provider=${provider.name}` +
      ` nansenApi=${nansenApi ? 'on' : 'off'} gmgnApi=on` +
      ` chartSweep=${config.crawlEnabled ? 'on' : 'off'} db=${config.dbPath}`,
  );
});
