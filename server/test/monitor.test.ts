import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMonitorApp } from '../src/monitor/app.js';
import { readMonitorConfig } from '../src/monitor/config.js';
import { DiscordBot } from '../src/monitor/discord.js';
import { MonitorNotifications } from '../src/monitor/notifications.js';
import { MonitorStore } from '../src/monitor/store.js';
import type { MetricSample, ServiceSample } from '../src/monitor/types.js';
import { MonitorCollector } from '../src/monitor/collector.js';
import type { MonitorConfig } from '../src/monitor/config.js';

function config(overrides: NodeJS.ProcessEnv = {}): MonitorConfig {
  return readMonitorConfig({
    MONITOR_API_TOKEN: 'monitor-api-test-token',
    MONITOR_TIMEZONE: 'UTC',
    ...overrides,
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body) ?? 'null', {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function metric(
  provider: string,
  key: string,
  used: number,
  remaining: number | null,
  limit: number | null,
  status: MetricSample['status'],
  unit = 'credits',
  threshold: number | null = null,
): MetricSample {
  return {
    provider, key, label: `${provider} ${key}`, unit, used, remaining, limit, threshold,
    status, source: 'deterministic test fixture', updatedAt: null,
  };
}

function captureDiscord(configuration: MonitorConfig): { bot: DiscordBot; messages: string[] } {
  const messages: string[] = [];
  const bot = new DiscordBot(configuration.discordBotToken, configuration.discordChannelId, async (_url, init) => {
    const rawBody = init?.body;
    const body: unknown = JSON.parse(typeof rawBody === 'string' ? rawBody : '{}');
    if (typeof body === 'object' && body !== null && 'content' in body && typeof body.content === 'string') {
      messages.push(body.content);
    }
    return new Response(null, { status: 204 });
  });
  return { bot, messages };
}

test('monitor store persists usage deltas, counter resets, services, and history across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'signal-scan-monitor-'));
  const path = join(directory, 'monitor.sqlite3');
  const start = Date.UTC(2026, 0, 2, 9);
  const service: ServiceSample = {
    id: 'api-a', name: 'API A', scope: 'API', status: 'healthy',
    checkedAt: new Date(start).toISOString(), latencyMs: 12, detail: 'HTTP OK',
  };
  try {
    const store = new MonitorStore(path);
    store.recordServices([service], start);
    store.recordMetrics([metric('FOMO', 'account', 10, 90, 100, 'ok')], start);
    store.recordMetrics([metric('FOMO', 'account', 15, 85, 100, 'ok')], start + 60_000);
    store.recordMetrics([metric('FOMO', 'account', 2, 98, 100, 'ok')], start + 120_000);
    assert.deepEqual(store.history(1, start + 120_000).series[0]?.points.map((point) => point.value), [0, 5, 7]);
    store.close();

    const reopened = new MonitorStore(path);
    try {
      const snapshot = reopened.snapshot(start + 120_000, 1_000);
      assert.equal(snapshot.credits[0]?.used, 2);
      assert.equal(snapshot.credits[0]?.status, 'ok');
      assert.equal(snapshot.services[0]?.status, 'unknown');
      assert.deepEqual(reopened.usageBetween(start, start + 120_001).map((row) => row.amount), [7]);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('monitor store merges legacy Nansen caller history into one shared series', () => {
  const store = new MonitorStore(':memory:');
  const start = Date.UTC(2026, 0, 2, 9);
  try {
    store.recordMetrics([
      metric('Nansen', 'caller-a', 3, 47, 50, 'ok'),
      metric('Nansen', 'caller-b', 5, 45, 50, 'ok'),
    ], start);
    store.recordMetrics([
      metric('Nansen', 'caller-a', 5, 45, 50, 'ok'),
      metric('Nansen', 'caller-b', 6, 44, 50, 'ok'),
    ], start + 60_000);
    store.recordMetrics([
      metric('Nansen', 'shared-daily', 12, 88, 100, 'ok'),
    ], start + 120_000);

    const snapshotRows = store.snapshot(start + 120_000, 300_000).credits
      .filter((row) => row.provider === 'Nansen');
    assert.equal(snapshotRows.length, 1);
    assert.equal(snapshotRows[0]?.key, 'shared-daily');
    assert.equal(snapshotRows[0]?.used, 12);

    const historyRows = store.history(1, start + 120_000).series
      .filter((row) => row.provider === 'Nansen');
    assert.equal(historyRows.length, 1);
    assert.deepEqual(historyRows[0]?.points.map((point) => point.value), [0, 3, 4]);
    assert.equal(store.usageBetween(start, start + 120_001)
      .filter((row) => row.provider === 'Nansen').length, 1);
    assert.equal(store.usageBetween(start, start + 120_001)
      .find((row) => row.provider === 'Nansen')?.amount, 4);
  } finally {
    store.close();
  }
});

test('monitor store hides legacy Solana rows after merged RPC inventory cutover', () => {
  const store = new MonitorStore(':memory:');
  const start = Date.UTC(2026, 0, 2, 9);
  try {
    store.recordMetrics([
      metric('Solana RPC', 'legacy-api-a', 8, null, null, 'unknown', 'requests'),
      metric('Solana RPC', 'legacy-api-b', 5, null, null, 'unknown', 'requests'),
    ], start);
    store.recordMetrics(Array.from({ length: 6 }, (_, index) =>
      metric('Solana RPC', `solana-rpc-${index + 1}`, 0, null, null, 'unknown', 'requests'),
    ), start + 60_000);

    const snapshotRows = store.snapshot(start + 60_000, 300_000).credits
      .filter((row) => row.provider === 'Solana RPC');
    const historyRows = store.history(1, start + 60_000).series
      .filter((row) => row.provider === 'Solana RPC');
    const usageRows = store.usageBetween(start, start + 60_001)
      .filter((row) => row.provider === 'Solana RPC');
    assert.equal(snapshotRows.length, 6);
    assert.equal(historyRows.length, 6);
    assert.equal(usageRows.length, 6);
    assert.equal(snapshotRows.some((row) => row.key.startsWith('legacy-')), false);
  } finally {
    store.close();
  }
});


test('monitor app serves dashboard APIs publicly, leaves healthz public, and bounds history queries', async () => {
  const configuration = config();
  const store = new MonitorStore(':memory:');
  const notifications = new MonitorNotifications(store, new DiscordBot('', ''), configuration);
  const server = createMonitorApp({ config: configuration, store, notifications }).listen(0);
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('monitor test server has no TCP address');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('www-authenticate'), null);
    assert.match(await page.text(), /System monitor/);
    const snapshot = await fetch(`${base}/api/snapshot`);
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.headers.get('www-authenticate'), null);
    assert.equal((await fetch(`${base}/api/history?hours=721`)).status, 400);
    assert.equal((await fetch(`${base}/api/history?hours=24`)).status, 200);
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
    store.close();
  }
});

test('Discord bot sends bounded content with bot auth and mentions disabled', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const bot = new DiscordBot('test-discord-token', '12345678901234567', async (url, init) => {
    requestUrl = String(url);
    requestInit = init;
    return new Response(null, { status: 204 });
  });
  await bot.send(`${'x'.repeat(2_100)} @everyone`);
  assert.equal(new URL(requestUrl).pathname, '/api/v10/channels/12345678901234567/messages');
  assert.equal(new Headers(requestInit?.headers).get('Authorization'), 'Bot test-discord-token');
  const payload: unknown = JSON.parse(String(requestInit?.body));
  let content: unknown;
  let allowedMentions: unknown;
  if (typeof payload === 'object' && payload !== null) {
    if ('content' in payload) content = payload.content;
    if ('allowed_mentions' in payload) allowedMentions = payload.allowed_mentions;
  }
  assert.equal(typeof content, 'string');
  if (typeof content !== 'string') throw new Error('Discord content was not a string');
  assert.equal(content.length, 2_000);
  assert.deepEqual(allowedMentions, { parse: [] });
});

test('low-credit alerts deduplicate, then re-arm after the balance recovers', async () => {
  const configuration = config({
    MONITOR_DAILY_REPORT_HOUR: '23',
    DISCORD_BOT_TOKEN: 'test-discord-token',
    DISCORD_CHANNEL_ID: '12345678901234567',
  });
  const store = new MonitorStore(':memory:');
  const { bot, messages } = captureDiscord(configuration);
  let now = Date.UTC(2026, 0, 2, 12);
  const notifications = new MonitorNotifications(store, bot, configuration, () => now);
  try {
    store.recordMetrics([metric('FOMO', 'account', 95, 5, 100, 'low', 'credits', 10)], now);
    await notifications.tick();
    await notifications.tick();
    assert.equal(messages.length, 1);
    assert.match(messages[0] ?? '', /Credit thấp/);

    now += 60_000;
    store.recordMetrics([metric('FOMO', 'account', 50, 50, 100, 'ok', 'credits', 10)], now);
    await notifications.tick();
    now += 60_000;
    store.recordMetrics([metric('FOMO', 'account', 95, 5, 100, 'low', 'credits', 10)], now);
    await notifications.tick();
    assert.equal(messages.length, 2);
  } finally {
    store.close();
  }
});

test('daily report uses observed per-provider deltas and persists once-per-day deduplication', async () => {
  const configuration = config({
    MONITOR_DAILY_REPORT_HOUR: '8',
    DISCORD_BOT_TOKEN: 'test-discord-token',
    DISCORD_CHANNEL_ID: '12345678901234567',
  });
  const store = new MonitorStore(':memory:');
  const { bot, messages } = captureDiscord(configuration);
  const sampleAt = Date.UTC(2026, 0, 2, 9);
  const rowsBefore = [
    metric('Nansen', 'caller-a', 1, 99, 100, 'ok'),
    metric('FOMO', 'account', 5, 95, 100, 'ok', 'credits', 10),
    metric('GMGN', 'key-1', 0, null, null, 'unknown', 'requests'),
    metric('EVM RPC · base', 'api-a-application-evm-base-0', 0, null, null, 'unknown', 'requests'),
  ];
  const rowsAfter = [
    metric('Nansen', 'caller-a', 4, 96, 100, 'ok'),
    metric('FOMO', 'account', 8, 92, 100, 'ok', 'credits', 10),
    metric('GMGN', 'key-1', 7, null, null, 'unknown', 'requests'),
    metric('EVM RPC · base', 'api-a-application-evm-base-0', 2, null, null, 'unknown', 'requests'),
  ];
  try {
    store.recordServices([{
      id: 'api-a', name: 'API A', scope: 'API', status: 'healthy',
      checkedAt: new Date(sampleAt).toISOString(), latencyMs: 12, detail: 'HTTP OK',
    }], sampleAt);
    store.recordMetrics(rowsBefore, sampleAt - 60_000);
    store.recordMetrics(rowsAfter, sampleAt);
    const clock = sampleAt + 1;
    await new MonitorNotifications(store, bot, configuration, () => clock).tick();
    assert.equal(messages.length, 1);
    assert.match(messages[0] ?? '', /Nansen: 3 credits/);
    assert.match(messages[0] ?? '', /FOMO: 8 \/ 100 credits/);
    assert.match(messages[0] ?? '', /GMGN: 7 request/);
    assert.match(messages[0] ?? '', /RPC: 2 outbound request/);
    await new MonitorNotifications(store, bot, configuration, () => clock + 1_000).tick();
    assert.equal(messages.length, 1, 'SQLite state prevents a duplicate report after notifier restart');
  } finally {
    store.close();
  }
});

test('collector inventories and aggregates six shared Solana RPCs, merges Nansen, and preserves unknown balance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'signal-scan-collector-'));
  const fomoUsagePath = join(directory, 'fomo-usage.json');
  const fomoHeartbeatPath = join(directory, 'fomo-heartbeat');
  const walletHeartbeatPath = join(directory, 'wallet-heartbeat');
  const now = Date.now();
  const configuration = config({
    MONITOR_API_A_URL: 'http://api-a',
    MONITOR_API_B_URL: 'http://api-b',
    MONITOR_GATEWAY_URL: 'http://gateway',
    MONITOR_WEB_A_URL: 'http://web-a',
    MONITOR_WEB_B_URL: 'http://web-b',
    MONITOR_CHROME_A_URL: 'http://chrome-a/pressure',
    MONITOR_CHROME_B_URL: 'http://chrome-b/pressure',
    MONITOR_GATEWAY_CHROME_URL: 'http://gateway-chrome/pressure',
    MONITOR_PUBLIC_SITE_URL: 'http://public/healthz',
    MONITOR_FOMO_USAGE_PATH: fomoUsagePath,
    MONITOR_FOMO_HEARTBEAT_PATH: fomoHeartbeatPath,
    MONITOR_WALLET_HEARTBEAT_PATH: walletHeartbeatPath,
  });
  const fomoSnapshot = {
    fetchedAtMs: now - 1_000,
    attemptedAtMs: now - 1_000,
    plan: 'pro',
    credits: { monthly: 100, usedThisMonth: 95, prepaid: 0, remaining: 5 },
    source: 'fomo-v2-me',
    error: null,
  };
  await writeFile(fomoUsagePath, JSON.stringify(fomoSnapshot));
  await writeFile(fomoHeartbeatPath, '');
  await writeFile(walletHeartbeatPath, '');
  const store = new MonitorStore(':memory:');
  let apiMetricScrapes = 0;
  let nansenBudget = 100;
  let nansenHalf = 50;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/api/monitor/metrics')) {
      assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${configuration.apiToken}`);
      apiMetricScrapes += 1;
      const solanaUsage = Array.from({ length: 6 }, (_, endpointIndex) => ({
        provider: 'solana',
        source: url.startsWith('http://api-a') ? 'application' : 'fomo',
        chain: 'solana',
        endpointIndex,
        endpointId: `${'0'.repeat(63)}${(endpointIndex + 1).toString(16)}`,
        requests: endpointIndex === 0 ? (url.startsWith('http://api-a') ? 2 : 3) : 0,
        successes: endpointIndex === 0 ? (url.startsWith('http://api-a') ? 1 : 3) : 0,
        failures: endpointIndex === 0 && url.startsWith('http://api-a') ? 1 : 0,
        creditExhausted: endpointIndex === 0 && url.startsWith('http://api-a') ? 1 : 0,
        lastAt: endpointIndex === 0 ? now : null,
      }));
      const rpcUsage = url.startsWith('http://api-a')
        ? [
          { provider: 'evm', source: 'application', chain: 'base', endpointIndex: 0, requests: 3, successes: 2, failures: 1, creditExhausted: 0, lastAt: now },
          ...solanaUsage,
        ]
        : [
          { provider: 'evm', source: 'application', chain: 'base', endpointIndex: 0, requests: 8, successes: 8, failures: 0, creditExhausted: 0, lastAt: now },
          ...solanaUsage,
        ];
      const projectId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      const heliusUsage = [{
        projectId,
        endpointIndexes: [0, 1, 2, 3, 4, 5],
        creditsUsed: url.startsWith('http://api-a') ? 20 : 22,
        remaining: url.startsWith('http://api-a') ? 90 : 88,
        limit: 1_000,
        cycleStart: '2026-04-01',
        cycleEnd: '2026-05-01',
        fetchedAtMs: url.startsWith('http://api-a') ? now - 1_000 : now,
        attemptedAtMs: now,
        error: null,
      }];
      const isA = url.startsWith('http://api-a');
      const fomoApiUsage = {
        sampledAtMs: now,
        windowMs: 300_000,
        upstream: { apiStatus: 'operational', liveDataStatus: isA ? 'degraded' : 'operational', checkedAtMs: now },
        endpoints: [{
          endpoint: 'positions',
          operations: isA ? 5 : 2,
          attemptedOperations: isA ? 4 : 2,
          attempts: isA ? 6 : 2,
          attemptFailures: isA ? 2 : 0,
          successes: isA ? 2 : 2,
          noData: isA ? 1 : 0,
          incomplete: 0,
          failures: isA ? 1 : 0,
          deferred: isA ? 1 : 0,
          creditsCost: isA ? 3 : 1,
          lastOutcome: isA ? 'http_error' : 'success',
          lastOutcomeAtMs: now,
        }, {
          endpoint: 'swaps',
          operations: 1,
          attemptedOperations: 1,
          attempts: 1,
          attemptFailures: 0,
          successes: 1,
          noData: 0,
          incomplete: 0,
          failures: 0,
          deferred: 0,
          creditsCost: 1,
          lastOutcome: 'success',
          lastOutcomeAtMs: now,
        }],
      };
      return jsonResponse({ rpcUsage, heliusUsage, fomoApiUsage });
    }
    if (url === 'http://gateway/monitor/metrics') {
      return jsonResponse({
        credits: { day: '2026-01-02', budget: nansenBudget, half: nansenHalf, used: { a: 49, b: 3 } },
        gmgnKeys: [{ index: 0, served: 4, weight: 5 }],
      });
    }
    if (url.endsWith('/api/health')) return jsonResponse({ healthy: true });
    if (url === 'http://gateway/health') return jsonResponse({ ok: true });
    return new Response(null, { status: 200 });
  };
  try {
    const collector = new MonitorCollector(store, configuration, fetcher, () => now);
    await collector.collect();
    assert.equal(apiMetricScrapes, 2);
    const snapshot = store.snapshot(now, configuration.sampleIntervalMs * 3);
    const services = new Map(snapshot.services.map((service) => [service.id, service]));
    assert.equal(services.get('api-a')?.status, 'healthy');
    assert.equal(services.get('fomo-watch')?.status, 'healthy');
    assert.equal(services.get('wallet-watch')?.status, 'healthy');
    assert.equal(snapshot.credits.find((item) => item.provider === 'FOMO')?.status, 'low');
    assert.equal(snapshot.credits.find((item) => item.provider === 'FOMO')?.used, 95);
    const nansen = snapshot.credits.filter((item) => item.provider === 'Nansen');
    assert.equal(snapshot.fomoApi.length, 4);
    const fomoPositionsA = snapshot.fomoApi.find((sample) => sample.instance === 'A' && sample.endpoint === 'positions');
    assert.equal(fomoPositionsA?.operations, 5);
    assert.equal(fomoPositionsA?.attemptFailures, 2);
    assert.equal(fomoPositionsA?.upstreamLiveDataStatus, 'degraded');
    const staleFomoApi = store.snapshot(now + 181_000, configuration.sampleIntervalMs * 3).fomoApi;
    assert.equal(staleFomoApi.every((sample) => sample.stale && sample.upstreamApiStatus === 'unknown'), true);
    assert.equal(nansen.length, 1);
    assert.equal(nansen[0]?.key, 'shared-daily');
    assert.equal(nansen[0]?.used, 52);
    assert.equal(nansen[0]?.remaining, 48);
    assert.equal(nansen[0]?.limit, 100);
    assert.equal(snapshot.credits.find((item) => item.provider === 'GMGN')?.used, 4);
    assert.equal(snapshot.credits.find((item) => item.provider === 'GMGN')?.remaining, null);
    const rpc = snapshot.credits.filter((item) => item.provider === 'Solana RPC');
    assert.equal(rpc.length, 6);
    assert.equal(rpc.find((item) => item.key === 'solana-rpc-1')?.used, 5);
    assert.equal(rpc.find((item) => item.key === 'solana-rpc-6')?.used, 0);
    assert.equal(rpc.find((item) => item.key === 'solana-rpc-6')?.remaining, null);
    assert.equal(rpc.find((item) => item.key === 'solana-rpc-1')?.status, 'exhausted');
    assert.equal(snapshot.credits.filter((item) => item.provider.startsWith('EVM RPC')).length, 2);
    const helius = snapshot.credits.filter((item) => item.provider === 'Helius');
    assert.equal(helius.length, 1);
    assert.equal(helius[0]?.remaining, 88);
    assert.equal(helius[0]?.key, 'helius-project-1');
    assert.equal(JSON.stringify(snapshot).includes('a1b2c3d4-e5f6-7890-abcd-ef1234567890'), false);
    assert.equal(JSON.stringify(snapshot).includes(configuration.apiToken), false);
    assert.equal(snapshot.credits.some((item) => item.key.startsWith('solana-endpoint:')), false);

    nansenBudget = 0;
    nansenHalf = 0;
    await collector.collect();
    const unlimited = store.snapshot(now, configuration.sampleIntervalMs * 3).credits
      .find((item) => item.provider === 'Nansen');
    assert.equal(apiMetricScrapes, 4);
    assert.equal(unlimited?.used, 52);
    assert.equal(unlimited?.remaining, null);
    assert.equal(unlimited?.limit, null);
    assert.equal(unlimited?.status, 'unknown');
    assert.match(unlimited?.source ?? '', /unlimited/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
