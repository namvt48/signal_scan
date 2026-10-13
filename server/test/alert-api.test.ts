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
import { insertTrades, updateTokenMetrics } from '../src/ingest.js';

async function withApi(run: (baseUrl: string) => Promise<void>): Promise<void> {
  open(':memory:');
  const server = createApp('alert-api-test', { monitorToken: 'monitor-feed-secret' }).listen(0);
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('alert API test server has no TCP address');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
    getDb().close();
    open(':memory:');
  }
}

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
      const wallet = insertWallet({
        address: 'tracked-wallet-address',
        name: 'Tracked Whale',
        tags: [],
        chain,
        source: 'test',
      });
      insertTrades(wallet.id, [{
        tx: 'tracked-wallet-tx',
        ts: Date.now(),
        side: 'buy',
        ca,
        chain,
        amountUsd: 500,
        price: 1,
      }], 'watch');
      const fomoUser = insertFomoUser({ handle: '@fomo_buyer', name: 'FOMO Buyer' });
      insertFomoTrade({
        fomo_user_id: fomoUser.id,
        event_id: 'fomo-meta-event',
        ca,
        chain,
        type: 'buy',
        usd_value: 500,
        trade_usd: 500,
        ts: Date.now(),
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
        count: 1,
        wallets: { names: ['Tracked Whale'], total: 1 },
        fomoUsers: { names: [], total: 0 },
      });
      assert.equal(aPage.observations[0]?.snapshot.iconUrl, 'https://cdn.dexscreener.com/cms/images/token-icon.png');
      assert.equal(aPage.observations[0]?.snapshot.xHandle, 'hyped_account');

      config.showFomo = true;
      const bPage = await getPage();
      assert.deepEqual(bPage.observations[0]?.snapshot.tracked, {
        count: 2,
        wallets: { names: ['Tracked Whale'], total: 1 },
        fomoUsers: { names: ['@fomo_buyer'], total: 1 },
      });
      assert.equal(Object.hasOwn(bPage, 'telegramAlertRules'), false);

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
          payload: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });
      try {
        await new MonitorAlerts(store, monitorConfig, bot, monitorFetcher).tick();
      } finally {
        store.close();
      }
      assert.equal(telegramRequests.length, 2);
      assert.ok(telegramRequests.every(({ method }) => method === 'sendPhoto'));
      const aCaption = telegramRequests.find(({ payload }) =>
        typeof payload.caption === 'string' && payload.caption.includes('Tracked in: 1'))?.payload.caption;
      assert.equal(typeof aCaption, 'string');
      assert.equal(telegramRequests.find(({ payload }) =>
        typeof payload.caption === 'string' && payload.caption.includes('Tracked in: 1'))?.payload.photo,
      'https://cdn.dexscreener.com/cms/images/token-icon.png');
      assert.match(aCaption as string, /Tracked by: Tracked Whale/);
      assert.doesNotMatch(aCaption as string, /FOMO users:/);
      assert.match(aCaption as string, /Twitter: <a href="https:\/\/x\.com\/hyped_account">/);
      assert.match(aCaption as string, /CA search on X/);
      const bCaption = telegramRequests.find(({ payload }) =>
        typeof payload.caption === 'string' && payload.caption.includes('Tracked in: 2'))?.payload.caption;
      assert.equal(typeof bCaption, 'string');
      assert.match(bCaption as string, /Tracked by: Tracked Whale/);
      assert.match(bCaption as string, /FOMO users: @fomo_buyer/);
    });
  } finally {
    config.showFomo = previousShowFomo;
  }
});
