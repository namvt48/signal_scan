import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp } from '../src/api.js';
import { config } from '../src/config.js';
import { getDb, getAlertMetricObservations, insertFomoTrade, insertFomoUser, insertTrackedCa, insertWallet, open, saveMetricPollResponse } from '../src/db.js';
import { readMonitorConfig } from '../src/monitor/config.js';
import { MonitorAlerts } from '../src/monitor/alerts.js';
import { MonitorStore } from '../src/monitor/store.js';
import { TelegramBot } from '../src/monitor/telegram.js';
import { createTestAuth } from './auth-testkit.js';
import { insertTrades, updateTokenMetrics } from '../src/ingest.js';

function telegramPayload(init?: RequestInit): Record<string, unknown> {
  if (init?.body instanceof FormData) {
    return Object.fromEntries([...init.body.entries()].map(([key, value]) => [
      key,
      typeof value === 'string' ? value : `[${value.type}:${value.size}]`,
    ]));
  }
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

async function withApi(run: (baseUrl: string, dashboardAuth: string) => Promise<void>): Promise<void> {
  open(':memory:');
  const auth = await createTestAuth();
  auth.deps.monitorToken = 'monitor-feed-secret';
  const server = createApp('alert-api-test', auth.deps).listen(0);
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('alert API test server has no TCP address');
  try {
    await run(`http://127.0.0.1:${address.port}`, await auth.bearer(auth.adminEmail));
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
    getDb().close();
    open(':memory:');
  }
}

test('public token-avatar endpoint returns deterministic CA-specific JPEG bytes', async () => {
  await withApi(async (baseUrl) => {
    getDb().exec('CREATE TEMP TABLE token_state (ca TEXT NOT NULL, chain TEXT NOT NULL, icon_url TEXT)');
    const addresses = [
      '6ZjXu9fMvvEWwpZFTvNaGfkYQU48VvHLYWmb5Uqbco3C',
      '11111111111111111111111111111111',
    ];
    const images = await Promise.all(addresses.map(async (ca) => {
      const response = await fetch(`${baseUrl}/api/token-avatar/sol/${ca}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'image/jpeg');
      return new Uint8Array(await response.arrayBuffer());
    }));
    assert.equal(Buffer.from(images[0]!.subarray(0, 2)).toString('hex'), 'ffd8');
    assert.notDeepEqual(images[0], images[1]);
  });
});

test('FOMO Telegram rules are persisted independently from instance A rules', async () => {
  const previousShowFomo = config.showFomo;
  try {
    await withApi(async (baseUrl, dashboardAuth) => {
      const aRules = {
        fwGrowthPct: 51,
        minFwPct: 18,
        t100GrowthPct: 42,
        minMcK: -1,
        maxMcK: -1,
        trackerBuyingK: 9,
      };
      const fomoRules = { ...aRules, fwGrowthPct: 12, trackerBuyingK: 3 };
      const authHeaders = { authorization: dashboardAuth };
      const aSaved = await fetch(`${baseUrl}/api/telegram-alert-rules`, {
        method: 'PUT',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(aRules),
      });
      assert.deepEqual(await aSaved.json(), aRules);

      config.showFomo = true;
      const firstFomoRead = await fetch(`${baseUrl}/api/fomo/telegram-alert-rules`, { headers: authHeaders });
      assert.deepEqual(await firstFomoRead.json(), aRules);
      const fomoSaved = await fetch(`${baseUrl}/api/fomo/telegram-alert-rules`, {
        method: 'PUT',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(fomoRules),
      });
      assert.deepEqual(await fomoSaved.json(), fomoRules);
      const fomoFeed = await fetch(`${baseUrl}/api/monitor/alerts`, {
        headers: { authorization: 'Bearer monitor-feed-secret' },
      });
      assert.deepEqual((await fomoFeed.json() as { telegramAlertRules: unknown }).telegramAlertRules, fomoRules);
      const invalidFomoUpdate = await fetch(`${baseUrl}/api/fomo/telegram-alert-rules`, {
        method: 'PUT',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackerBuyingK: -1 }),
      });
      assert.equal(invalidFomoUpdate.status, 400);
      const fomoReadAfterReject = await fetch(`${baseUrl}/api/fomo/telegram-alert-rules`, { headers: authHeaders });
      assert.deepEqual(await fomoReadAfterReject.json(), fomoRules);

      assert.equal((await fetch(`${baseUrl}/api/telegram-alert-rules`, { headers: authHeaders })).status, 404);

      config.showFomo = false;
      const aRead = await fetch(`${baseUrl}/api/telegram-alert-rules`, { headers: authHeaders });
      assert.deepEqual(await aRead.json(), aRules);
      const aFeed = await fetch(`${baseUrl}/api/monitor/alerts`, {
        headers: { authorization: 'Bearer monitor-feed-secret' },
      });
      assert.deepEqual((await aFeed.json() as { telegramAlertRules: unknown }).telegramAlertRules, aRules);
      assert.equal((await fetch(`${baseUrl}/api/fomo/telegram-alert-rules`, { headers: authHeaders })).status, 404);
    });
  } finally {
    config.showFomo = previousShowFomo;
  }
});

test('alert feed is monitor-authenticated, ordered, paginated, and ack is bounded', async () => {
  await withApi(async (baseUrl) => {
    saveMetricPollResponse('feed-ca-1', 'sol', 'gini', 100, 200, { nansenFreshPct: 35 });
    saveMetricPollResponse('feed-ca-2', 'base', 'gini', 101, 201, { nansenFreshPct: 40 });
    const rows = getAlertMetricObservations(0, 10);
    const [first, second] = rows;
    assert.ok(first && second);

    assert.equal((await fetch(`${baseUrl}/api/monitor/alerts`)).status, 401);
    const headers = { Authorization: 'Bearer monitor-feed-secret' };
    const invalidQuery = await fetch(`${baseUrl}/api/monitor/alerts?afterId=-1`, { headers });
    assert.equal(invalidQuery.status, 400);
    const page = await fetch(`${baseUrl}/api/monitor/alerts?afterId=0&limit=1`, { headers });
    assert.equal(page.status, 200);
    const payload: unknown = await page.json();
    assert.deepEqual(payload, {
      observations: [first],
      nextId: first.id,
      telegramAlertRules: {
        fwGrowthPct: 30,
        minFwPct: 15,
        t100GrowthPct: 30,
        minMcK: -1,
        maxMcK: -1,
        trackerBuyingK: 0,
      },
    });

    const badAck = await fetch(`${baseUrl}/api/monitor/alerts/ack`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ throughId: second.id + 1 }),
    });
    assert.equal(badAck.status, 409);
    const ack = await fetch(`${baseUrl}/api/monitor/alerts/ack`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ throughId: first.id }),
    });
    assert.equal(ack.status, 204);
    assert.deepEqual(getAlertMetricObservations(0, 10).map((row) => row.id), [second.id]);

    const badBody = await fetch(`${baseUrl}/api/monitor/alerts/ack`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ throughId: 'wrong' }),
    });
    assert.equal(badBody.status, 400);
    assert.equal((await fetch(`${baseUrl}/api/monitor/alerts/ack`, { method: 'POST' })).status, 401);
  });
});

test('alert feed enriches A and B observations with dashboard token and tracked-user metadata', async () => {
  const previousShowFomo = config.showFomo;
  try {
    await withApi(async (baseUrl) => {
      const ca = 'feed-meta-ca';
      const chain = 'sol' as const;
      insertTrackedCa({ address: ca, chain, note: 'test', entryUsd: 100 });
      updateTokenMetrics(ca, chain, {
        iconUrl: 'https://cdn.dexscreener.com/cms/images/token-icon.png',
        xHandle: 'hyped_account',
      });
      const tradeTs = Date.now();
      const walletNames = ['Tracked Whale', 'Wallet Four', 'Wallet Three', 'Wallet Two'];
      walletNames.forEach((name, index) => {
        const wallet = insertWallet({
          address: `tracked-wallet-address-${index}`,
          name,
          tags: [],
          chain,
          source: 'test',
        });
        insertTrades(wallet.id, [{
          tx: `tracked-wallet-tx-${index}`,
          ts: tradeTs,
          side: 'buy',
          ca,
          chain,
          amountUsd: 500,
          price: 1,
        }], 'watch');
      });
      const fomoHandles = ['@fomo_buyer', '@fomo_four', '@fomo_three', '@fomo_two'];
      fomoHandles.forEach((handle, index) => {
        const fomoUser = insertFomoUser({ handle, name: `FOMO Buyer ${index}` });
        insertFomoTrade({
          fomo_user_id: fomoUser.id,
          event_id: `fomo-meta-event-${index}`,
          ca,
          chain,
          type: 'buy',
          usd_value: 500,
          trade_usd: 500,
          ts: tradeTs,
        });
      });
      saveMetricPollResponse(ca, chain, 'gini', 100, 200, { nansenFreshPct: 20 });
      saveMetricPollResponse(ca, chain, 'gini', 101, 201, { nansenFreshPct: 27 });

      const headers = { Authorization: 'Bearer monitor-feed-secret' };
      const getPage = async () => {
        const response = await fetch(`${baseUrl}/api/monitor/alerts?afterId=0`, { headers });
        assert.equal(response.status, 200);
        return await response.json() as {
          observations: Array<{ id: number; snapshot: Record<string, unknown> }>;
          telegramAlertRules?: unknown;
        };
      };

      config.showFomo = false;
      const aPage = await getPage();
      assert.deepEqual(aPage.observations[0]?.snapshot.tracked, {
        count: 4,
        wallets: { names: walletNames, total: 4 },
        fomoUsers: { names: [], total: 0 },
      });
      assert.equal(aPage.observations[0]?.snapshot.iconUrl, '/api/token-avatar/sol/feed-meta-ca');
      assert.equal(aPage.observations[0]?.snapshot.xHandle, 'hyped_account');

      config.showFomo = true;
      const bPage = await getPage();
      assert.deepEqual(bPage.observations[0]?.snapshot.tracked, {
        count: 8,
        wallets: { names: walletNames, total: 4 },
        fomoUsers: { names: fomoHandles, total: 4 },
      });
      assert.deepEqual(bPage.telegramAlertRules, {
        fwGrowthPct: 30,
        minFwPct: 15,
        t100GrowthPct: 30,
        minMcK: -1,
        maxMcK: -1,
        trackerBuyingK: 0,
      });

      const store = new MonitorStore(':memory:');
      const monitorConfig = readMonitorConfig({
        MONITOR_API_TOKEN: 'feed-token',
        MONITOR_API_A_URL: 'http://api-a',
        MONITOR_API_B_URL: 'http://api-b',
      });
      const telegramRequests: Array<{ method: string; payload: Record<string, unknown> }> = [];
      const monitorFetcher: typeof fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/ack')) return new Response(null, { status: 204 });
        return new Response(JSON.stringify(url.hostname === 'api-a' ? aPage : bPage), { status: 200 });
      };
      const bot = new TelegramBot('test-token', 'test-chat', async (input, init) => {
        telegramRequests.push({
          method: String(input).split('/').at(-1) ?? '',
          payload: telegramPayload(init),
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });
      try {
        await new MonitorAlerts(store, monitorConfig, bot, monitorFetcher).tick();
      } finally {
        store.close();
      }
      assert.equal(telegramRequests.length, 1, 'source B Solana alerts are suppressed');
      assert.ok(telegramRequests.every(({ method }) => method === 'sendPhoto'));
      const aCaption = telegramRequests.find(({ payload }) =>
        typeof payload.caption === 'string' && payload.caption.includes('Tracked in: 4'))?.payload.caption;
      assert.equal(typeof aCaption, 'string');
      assert.match(String(telegramRequests.find(({ payload }) =>
        typeof payload.caption === 'string' && payload.caption.includes('Tracked in: 4'))?.payload.photo), /^\[image\/jpeg:/);
      assert.match(aCaption as string, /Tracked by: Tracked Whale, Wallet Four, Wallet Three, Wallet Two/);
      assert.doesNotMatch(aCaption as string, /FOMO users:/);
      assert.match(aCaption as string, /Twitter: <a href="https:\/\/x\.com\/hyped_account">/);
      assert.match(aCaption as string, /CA search on X/);
    });
  } finally {
    config.showFomo = previousShowFomo;
  }
});
