// Entry: open db -> seed (mock only) -> build provider -> start poller -> listen.
// All live data comes from Nansen since 2026-09-09 (GMGN retired).

import { config, gatewayClientFromConfig } from './config.js';
import { log } from './log.js';
import { listTrackedCas, open, seedIfEmpty, sharedAlertMetricImportCursor } from './db.js';
import { MockProvider } from './providers/mock.js';
import { GmgnMarketProvider } from './providers/gmgn.js';
import { CompositeProvider } from './providers/composite.js';
import { NansenApiClient, NansenMarketProvider, doorEndpointFor } from './providers/nansen.js';
import { GW_MARKET_ALERT_ACK_PATH, GW_MARKET_SUBSCRIPTIONS_PATH, GW_NANSEN_DOOR_PATH } from './gateway-client.js';
import { parseDoorClassification, type DoorClassification } from './shared/nansen-door.js';
import type { MarketDataProvider } from './providers/provider.js';
import { startPoller } from './poller.js';
import { cacheKey, loadSetupCache, pruneSetupCache } from './setup-cache.js';
import { createApp } from './api.js';
import { cohortLabelIndex } from './cohort-labels.js';

open(config.dbPath, config.marketDbPath);
if (config.marketDbPath === '') seedIfEmpty();

if (config.marketDbPath === '') {
  const setupCache = loadSetupCache();
  const setupPruned = pruneSetupCache(Date.now(), new Set(listTrackedCas().map((r) => cacheKey(r.address, r.chain))));
  log.info(`[setup-cache] loaded ${setupCache.size} entries from ${config.setupCacheFile} (pruned ${setupPruned})`);
}

// Provider egress (todo 14). The gateway client is built from config IFF
// `GATEWAY_URL` is set (non-empty) — REGARDLESS of NANSEN_API_KEY / GMGN_API_KEY,
// because the gateway injects the real key after the credential move (todo 6).
// With `GATEWAY_URL` unset the gateway client is null and the legacy key-gated
// path applies: key present -> legacy client, key absent -> null.
const gateway = gatewayClientFromConfig();

// Credit API client: first-add token-information (1cr) + non-sol wallet balances.
// Gateway-configured -> always built (the gateway owns the key). Legacy path ->
// absent key skips the credit paths (the free app-question metrics still run).
const nansenApi =
  gateway !== null
    ? new NansenApiClient(config.nansenApiKey, gateway)
    : config.nansenApiKey
      ? new NansenApiClient(config.nansenApiKey)
      : null;
// The gateway injects GMGN's key (todo 13), so the provider is built
// unconditionally; the gateway client is threaded through when configured.
const gmgnApi = new GmgnMarketProvider(config.gmgnApiKey, gateway ?? undefined);

// The free app-questions door rides the gateway too: the api process never builds
// a DoorPool, it POSTs the question to the gateway's door route.
async function doorPostJson(url: string, body: unknown, signal?: AbortSignal): Promise<{ status: number; json: unknown; classification: DoorClassification | null }> {
  const endpoint = doorEndpointFor(url);
  if (endpoint === null) throw new Error(`[index] unknown nansen door url ${url}`);
  if (gateway === null) throw new Error('[index] GATEWAY_URL unset: the nansen door requires the gateway');
  const env = await gateway.call(GW_NANSEN_DOOR_PATH, { endpoint, body }, signal);
  return {
    status: env.status,
    json: env.body === null ? null : (JSON.parse(env.body) as unknown),
    classification: parseDoorClassification(env.headers['x-nansen-door-classification']),
  };
}

function buildProvider(): MarketDataProvider {
  if (config.mode === 'mock') return new MockProvider();
  const nansen = new NansenMarketProvider(doorPostJson, nansenApi, listTrackedCas);
  if (config.mode !== 'gmgn') return nansen;
  return new CompositeProvider(gmgnApi, nansen);
}

const provider = buildProvider();

if (config.marketDbPath === '') {
  startPoller(
    provider,
    nansenApi,
    undefined,
    'all',
    config.mode !== 'mock' && gateway !== null ? gmgnApi : undefined,
  );
} else {
  if (gateway === null) throw new Error('MARKET_DB_PATH requires GATEWAY_URL');
  startPoller(provider, nansenApi, undefined, 'wallets');
  const syncMarketTargets = async (): Promise<void> => {
    await gateway.call(GW_MARKET_SUBSCRIPTIONS_PATH, {
      tokens: listTrackedCas().map(({ address, chain }) => ({ ca: address, chain })),
    });
    await gateway.call(GW_MARKET_ALERT_ACK_PATH, { throughId: sharedAlertMetricImportCursor() });
  };
  const syncTimer = setInterval(() => {
    void syncMarketTargets().catch((error: unknown) => log.warn('[market-data] subscription sync failed', error));
  }, 30_000);
  syncTimer.unref();
  void syncMarketTargets().catch((error: unknown) => log.warn('[market-data] initial subscription sync failed', error));
}
cohortLabelIndex.start(
  (error) => log.warn('[cohort-labels] refresh failed', error),
  (wallets) => log.info(`[cohort-labels] refreshed ${wallets} wallet labels`),
);

createApp(provider.name).listen(config.port, () => {
  log.info(
    `[index] listening on :${config.port} mode=${config.mode} provider=${provider.name}` +
      ` nansenApi=${nansenApi ? 'on' : 'off'} gmgnApi=${gmgnApi ? 'on' : 'off'} gateway=${gateway ? 'on' : 'off'}` +
      ` chartSweep=${config.crawlEnabled ? 'on' : 'off'} db=${config.dbPath}`,
  );
});
