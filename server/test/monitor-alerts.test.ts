import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { test } from 'node:test';
import type { AlertMetricObservation } from '../src/alert-feed.js';
import { config } from '../src/config.js';
import { createApp } from '../src/api.js';
import { getDb, insertFomoUser, open } from '../src/db.js';
import { readMonitorConfig } from '../src/monitor/config.js';
import { MonitorAlerts } from '../src/monitor/alerts.js';
import { MonitorStore } from '../src/monitor/store.js';
import { TelegramBot } from '../src/monitor/telegram.js';
import { createTestAuth, TEST_SERVICE_TOKEN } from './auth-testkit.js';

function observation(
  id: number,
  metric: 'fresh' | 't100' | 'trackerBuy',
  value: number,
  symbol = 'ALERT',
  ca = 'AlertMint111111111111111111111111111111111',
  freshPct: number | null = metric === 'fresh' ? value : 41,
  marketCap: number | null = 25_000,
): AlertMetricObservation {
  return {
    id, ca, chain: 'sol', metric, value,
    responseAt: 1_700_000_000_000 + id,
    snapshot: {
      capturedAt: 1_700_000_000_100 + id,
      symbol,
      marketCap,
      marketCapAt: 1_700_000_000_000,
      freshPct,
      t100Multiple: metric === 't100' ? value : 2.5,
      lf: 100,
      trackedHoldingPct: 3.75,
      iconUrl: 'https://cdn.dexscreener.com/cms/images/token-icon.png',
      xHandle: 'signal_x',
      tracked: {
        count: 2,
        wallets: { names: ['Tracked Wallet'], total: 1 },
        fomoUsers: { names: ['@fomo_user'], total: 1 },
      },
      ...(metric === 'trackerBuy' ? { trackerBuyer: { name: symbol, address: 'TrackerWallet111' } } : {}),
    },
  };
}

function telegramPayload(init?: RequestInit): Record<string, unknown> {
  if (init?.body instanceof FormData) {
    return Object.fromEntries([...init.body.entries()].map(([key, value]) => [
      key,
      typeof value === 'string' ? value : `[${value.type}:${value.size}]`,
    ]));
  }
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

test('Monitor processes every source observation, strict thresholds, replay and source-local baselines', async () => {
  const store = new MonitorStore(':memory:');
  const configuration = readMonitorConfig({
    MONITOR_API_TOKEN: 'feed-token',
    MONITOR_API_A_URL: 'http://api-a',
    MONITOR_API_B_URL: 'http://api-b',
  });
  const feeds: Record<'A' | 'B', AlertMetricObservation[]> = {
    A: [
      observation(1, 'fresh', 20),
      observation(2, 'fresh', 26),
      observation(3, 'fresh', 20, 'ALERT', 'RelativeMint111111111111111111111111111111'),
      observation(4, 'fresh', 26.2, 'ALERT', 'RelativeMint111111111111111111111111111111'),
      observation(5, 't100', 3),
      observation(6, 't100', 4),
      observation(7, 'trackerBuy', 50_001, 'BUYER'),
    ],
    B: [{ ...observation(1, 'fresh', 15), chain: 'base' }, { ...observation(2, 'fresh', 50, 'B-TOKEN'), chain: 'base' }],
  };
  let failedAckA = false;
  const messages: string[] = [];
  const telegramRequests: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const source = url.hostname === 'api-a' ? 'A' : 'B';
    if (url.pathname.endsWith('/ack')) {
      if (source === 'A' && !failedAckA) {
        failedAckA = true;
        return new Response(JSON.stringify({ error: 'temporary ack failure' }), { status: 503 });
      }
      return new Response(null, { status: 204 });
    }
    const afterId = Number(url.searchParams.get('afterId'));
    return new Response(JSON.stringify({
      observations: feeds[source].filter((row) => row.id > afterId),
      ...(source === 'A' ? { telegramAlertRules: { fwGrowthPct: 30, minFwPct: 15, t100GrowthPct: 30, minMcK: -1, maxMcK: -1, trackerBuyingK: 50 } } : {}),
    }), { status: 200 });
  };
  const bot = new TelegramBot('test-token', 'test-chat', async (url, init) => {
    const payload = telegramPayload(init);
    const method = String(url).split('/').at(-1) ?? '';
    telegramRequests.push({ method, payload });
    const text = typeof payload.caption === 'string' ? payload.caption : payload.text;
    if (typeof text === 'string') messages.push(text);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  let now = 1_700_000_001_000;
  const alerts = new MonitorAlerts(store, configuration, bot, fetcher, () => now);
  try {
    await alerts.tick();
    assert.equal(messages.length, 4, 'tracker BUY >50K, >30% Fresh, >30% T100, and B transition alert');
    assert.equal(messages.filter((text) => text.includes('Fresh wallet growth: +30% (20% → 26%)')).length, 0);
    assert.equal(messages.filter((text) => text.includes('Fresh wallet growth: +31% (20% → 26.2%)')).length, 1);
    assert.equal(messages.filter((text) => text.includes('Top100 increase: 3 → 4')).length, 1);
    assert.equal(messages.filter((text) => text.includes('Tracker Buying: BUYER (TrackerWallet111) bought $50,001.00')).length, 1);
    assert.equal(messages.filter((text) => text.includes('B-TOKEN')).length, 1);
    assert.ok(messages.every((text) => text.includes('MC: $25K')));
    assert.ok(messages.every((text) => text.includes('Nansen: Top100')));
    assert.ok(messages.every((text) => text.includes('Low Float')));
    assert.ok(messages.every((text) => text.includes('Tracker holding: 3.75%')));
    assert.ok(messages.every((text) => text.split(/\r?\n/).length >= 9));
    assert.ok(messages.every((text) => text.includes('Tracked in: 2')));
    assert.ok(messages.every((text) => text.includes('Tracked by: Tracked Wallet')));
    const bMessage = messages.find((text) => text.includes('B-TOKEN'));
    assert.ok(bMessage?.includes('FOMO users: @fomo_user'));
    assert.ok(bMessage?.includes('CA search on X'));
    assert.ok(messages.filter((text) => !text.includes('B-TOKEN')).every((text) => !text.includes('FOMO users:')));
    assert.ok(telegramRequests.every(({ method, payload }) =>
      method === 'sendPhoto' && String(payload.photo).startsWith('[image/jpeg:')));
    assert.ok(messages.every((text) => !/Source:|Response:|Alert:/.test(text)));

    now += 60_000;
    await alerts.tick();
    assert.equal(messages.length, 4, 'source replay after ack failure does not enqueue duplicates');
    assert.equal(store.alertCursor('A'), 7);
    assert.equal(store.alertCursor('B'), 2);
    assert.deepEqual(store.pendingTelegramAlerts(now, 10), []);
  } finally {
    store.close();
  }
});
test('Instance A and FOMO alerts apply the rules returned by their own feed', async () => {
  const store = new MonitorStore(':memory:');
  const configuration = readMonitorConfig({
    MONITOR_API_TOKEN: 'feed-token',
    MONITOR_API_A_URL: 'http://api-a',
    MONITOR_API_B_URL: 'http://api-b',
  });
  const observations = {
    A: [observation(1, 'fresh', 20), observation(2, 'fresh', 27, 'A-TOKEN')],
    B: [{ ...observation(1, 'fresh', 20), chain: 'base' }, { ...observation(2, 'fresh', 27, 'FOMO-TOKEN'), chain: 'base' }],
  };
  const rules = {
    A: { fwGrowthPct: 100, minFwPct: 15, t100GrowthPct: 30, minMcK: -1, maxMcK: -1, trackerBuyingK: 0 },
    B: { fwGrowthPct: 20, minFwPct: 15, t100GrowthPct: 30, minMcK: -1, maxMcK: -1, trackerBuyingK: 0 },
  };
  const telegramDestinations: string[] = [];
  const telegramMessages: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/ack')) return new Response(null, { status: 204 });
    const source = url.hostname === 'api-a' ? 'A' : 'B';
    const afterId = Number(url.searchParams.get('afterId'));
    return new Response(JSON.stringify({
      observations: observations[source].filter((row) => row.id > afterId),
      telegramAlertRules: rules[source],
    }), { status: 200 });
  };
  const bot = new TelegramBot('test-token', 'shared-chat', async (_url, init) => {
    const payload = telegramPayload(init);
    const text = typeof payload.caption === 'string' ? payload.caption : payload.text;
    if (typeof text === 'string') telegramMessages.push(text);
    telegramDestinations.push(String(payload.chat_id));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  try {
    await new MonitorAlerts(store, configuration, bot, fetcher, () => 1_700_000_001_000).tick();
    assert.equal(telegramMessages.length, 1);
    assert.match(telegramMessages[0] ?? '', /FOMO-TOKEN/);
    assert.doesNotMatch(telegramMessages[0] ?? '', /A-TOKEN/);
    assert.deepEqual(telegramDestinations, ['shared-chat']);
  } finally {
    store.close();
  }
});


test('invalid optional dashboard metadata does not discard a valid alert observation', async () => {
  const store = new MonitorStore(':memory:');
  const configuration = readMonitorConfig({
    MONITOR_API_TOKEN: 'feed-token',
    MONITOR_API_A_URL: 'http://api-a',
    MONITOR_API_B_URL: 'http://api-b',
  });
  const invalidEnrichment = observation(2, 'fresh', 27, 'UNTRUSTED', 'InvalidMetaMint111111111111111111111111');
  invalidEnrichment.snapshot = {
    ...invalidEnrichment.snapshot,
    iconUrl: 'https://images.example.com/avatar.png',
    xHandle: '<script>',
    tracked: {
      count: 4,
      wallets: { names: ['Tracked Wallet'], total: 1 },
      fomoUsers: { names: ['@fomo_user'], total: 1 },
    },
  };
  const rows = [observation(1, 'fresh', 20, 'UNTRUSTED', invalidEnrichment.ca), invalidEnrichment];
  const telegramRequests: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/ack')) return new Response(null, { status: 204 });
    const sourceA = url.hostname === 'api-a';
    const afterId = Number(url.searchParams.get('afterId'));
    return new Response(JSON.stringify({
      observations: sourceA ? rows.filter((row) => row.id > afterId) : [],
      ...(sourceA ? {
        telegramAlertRules: { fwGrowthPct: 30, minFwPct: 15, t100GrowthPct: 30, trackerBuyingK: 0 },
      } : {}),
    }), { status: 200 });
  };
  const bot = new TelegramBot('test-token', 'test-chat', async (url, init) => {
    telegramRequests.push({
      method: String(url).split('/').at(-1) ?? '',
      payload: telegramPayload(init),
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  const alerts = new MonitorAlerts(store, configuration, bot, fetcher, () => 1_700_000_001_000);
  try {
    await alerts.tick();
    assert.equal(store.alertCursor('A'), 2);
    assert.equal(telegramRequests.length, 1);
    assert.equal(telegramRequests[0]?.method, 'sendPhoto');
    const text = telegramRequests[0]?.payload.caption;
    assert.equal(typeof text, 'string');
    assert.match(text as string, /Fresh wallet growth: \+35% \(20% → 27%\)/);
    assert.match(text as string, /CA search on X/);
    assert.match(String(telegramRequests[0]?.payload.photo), /^\[image\/jpeg:/);
    assert.match(text as string, /Twitter: unavailable/);
    assert.doesNotMatch(text as string, /Tracked in:|@fomo_user|<script>/);
  } finally {
    store.close();
  }
});
test('T100 alerts require strictly more than 30% growth from a positive prior baseline', () => {
  const store = new MonitorStore(':memory:');
  const ca = 'T100IncreaseMint11111111111111111111111';
  const zeroCa = 'T100ZeroBaseMint111111111111111111111';
  try {
    store.commitAlertObservations('A', [
      observation(1, 't100', 2.5, 'UPWARD', ca),
      observation(2, 't100', 3.25, 'UPWARD', ca),
      observation(3, 't100', 3.25 * 1.3, 'UPWARD', ca),
      observation(4, 't100', 5.5, 'UPWARD', ca),
      observation(5, 't100', 5.5, 'UPWARD', ca),
      observation(6, 't100', 5, 'UPWARD', ca),
      observation(7, 't100', 6.7, 'UPWARD', ca),
      observation(8, 't100', 0, 'ZERO', zeroCa),
      observation(9, 't100', 1, 'ZERO', zeroCa),
    ]);
    const pending = store.pendingTelegramAlerts(Date.now(), 10);
    assert.deepEqual(pending.map((alert) => alert.alertId), ['A:3', 'A:4', 'A:5', 'A:7']);
    assert.equal(pending[0]?.payload.trigger.previous, 2.5);
    assert.equal(pending[1]?.payload.trigger.previous, 3.25 * 1.3);
    assert.equal(pending[1]?.payload.trigger.current, 5.5);
    assert.equal(pending[2]?.payload.trigger.previous, 3.25 * 1.3);
    assert.equal(pending[3]?.payload.trigger.previous, 5);
    assert.equal(pending[3]?.payload.trigger.current, 6.7);
  } finally {
    store.close();
  }
});
test('legacy alert baselines gain persisted n-2 history after a new observation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'monitor-alert-baseline-'));
  const path = join(dir, 'monitor.sqlite3');
  const legacyDb = new Database(path);
  legacyDb.exec(`
    CREATE TABLE alert_baselines (
      source TEXT NOT NULL,
      chain TEXT NOT NULL,
      ca TEXT NOT NULL,
      metric TEXT NOT NULL,
      value REAL NOT NULL,
      PRIMARY KEY (source, chain, ca, metric)
    );
    INSERT INTO alert_baselines VALUES ('A', 'sol', 'LegacyBaselineMint1111111111111111111111', 'fresh', 20);
  `);
  legacyDb.close();
  const store = new MonitorStore(path);
  const ca = 'LegacyBaselineMint1111111111111111111111';
  try {
    store.commitAlertObservations('A', [observation(1, 'fresh', 25, 'LEGACY', ca)]);
    store.close();
    const reopened = new MonitorStore(path);
    try {
      reopened.commitAlertObservations('A', [observation(2, 'fresh', 30, 'LEGACY', ca)]);
      const pending = reopened.pendingTelegramAlerts(Date.now(), 10);
      assert.equal(pending.length, 1);
      assert.equal(pending[0]?.payload.trigger.previous, 20);
      const baseline = new Database(path, { readonly: true });
      try {
        assert.deepEqual(
          baseline.prepare('SELECT value, previous_value FROM alert_baselines WHERE ca = ?').get(ca),
          { value: 30, previous_value: 25 },
        );
      } finally {
        baseline.close();
      }
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('FW and T100 fall back to n-2 once and prefer a qualifying n-1 baseline on sources A and B', () => {
  const store = new MonitorStore(':memory:');
  const fallbackCa = 'FallbackMint111111111111111111111111111111';
  const preferredCa = 'PreferredMint11111111111111111111111111111';
  try {
    for (const source of ['A', 'B'] as const) {
      const samples = [
        observation(1, 'fresh', 20, 'FALLBACK-FW', fallbackCa),
        observation(2, 'fresh', 23.5, 'FALLBACK-FW', fallbackCa),
        observation(3, 'fresh', 30, 'FALLBACK-FW', fallbackCa),
        observation(4, 't100', 2, 'FALLBACK-T100', fallbackCa),
        observation(5, 't100', 2.35, 'FALLBACK-T100', fallbackCa),
        observation(6, 't100', 3, 'FALLBACK-T100', fallbackCa),
        observation(7, 'fresh', 20, 'PREFERRED-FW', preferredCa),
        observation(8, 'fresh', 22, 'PREFERRED-FW', preferredCa),
        observation(9, 'fresh', 30, 'PREFERRED-FW', preferredCa),
        observation(10, 't100', 2, 'PREFERRED-T100', preferredCa),
        observation(11, 't100', 2.2, 'PREFERRED-T100', preferredCa),
        observation(12, 't100', 3, 'PREFERRED-T100', preferredCa),
      ];
      store.commitAlertObservations(source, source === 'B'
        ? samples.map((sample) => ({ ...sample, chain: 'base' }))
        : samples);
    }
    const alerts = store.pendingTelegramAlerts(Date.now(), 20);
    assert.deepEqual(alerts.map(({ alertId, payload }) => [alertId, payload.trigger.metric, payload.trigger.previous]), [
      ['A:3', 'fresh', 20],
      ['B:3', 'fresh', 20],
      ['A:6', 't100', 2],
      ['B:6', 't100', 2],
      ['A:9', 'fresh', 22],
      ['B:9', 'fresh', 22],
      ['A:12', 't100', 2.2],
      ['B:12', 't100', 2.2],
    ]);
  } finally {
    store.close();
  }
});

test('Fresh rule uses strict relative growth and suppresses a zero baseline', () => {
  const store = new MonitorStore(':memory:');
  const relativeCa = 'RelativeMint111111111111111111111111111111';
  const zeroCa = 'ZeroMint1111111111111111111111111111111111';
  try {
    store.commitAlertObservations('A', [observation(1, 'fresh', 20)]);
    store.commitAlertObservations('A', [observation(2, 'fresh', 26)]);
    store.commitAlertObservations('A', [observation(3, 'fresh', 20, 'RELATIVE', relativeCa)]);
    store.commitAlertObservations('A', [observation(4, 'fresh', 26.2, 'RELATIVE', relativeCa)]);
    store.commitAlertObservations('A', [observation(5, 'fresh', 0, 'ZERO', zeroCa)]);
    store.commitAlertObservations('A', [observation(6, 'fresh', 1, 'ZERO', zeroCa)]);

    const pending = store.pendingTelegramAlerts(Date.now(), 10);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.alertId, 'A:4');
    assert.equal(pending[0]?.payload.trigger.previous, 20);
    assert.equal(pending[0]?.payload.trigger.current, 26.2);
  } finally {
    store.close();
  }
});

test('Fresh Min FW uses an inclusive current FW gate; baseline may be below the threshold', () => {
  const store = new MonitorStore(':memory:');
  const belowMin = 'BelowMinFreshMint1111111111111111111111111';
  const crossesMin = 'CrossesMinFreshMint11111111111111111111111';
  const atMin = 'AtMinFreshMint1111111111111111111111111111';
  const growthBoundary = 'GrowthBoundaryFreshMint1111111111111111111';
  const zeroBaseline = 'ZeroBaselineFreshMint11111111111111111111';
  try {
    store.commitAlertObservations('A', [
      observation(1, 'fresh', 5, 'BELOW-MIN', belowMin),
      observation(2, 'fresh', 10, 'BELOW-MIN', belowMin),
      observation(3, 'fresh', 5, 'CROSS-MIN', crossesMin),
      observation(4, 'fresh', 16, 'CROSS-MIN', crossesMin),
      observation(5, 'fresh', 5, 'AT-MIN', atMin),
      observation(6, 'fresh', 15, 'AT-MIN', atMin),
      observation(7, 'fresh', 20, 'GROWTH-BOUNDARY', growthBoundary),
      observation(8, 'fresh', 26, 'GROWTH-BOUNDARY', growthBoundary),
      observation(9, 'fresh', 0, 'ZERO', zeroBaseline),
      observation(10, 'fresh', 16, 'ZERO', zeroBaseline),
      observation(11, 'fresh', 22, 'ZERO', zeroBaseline),
    ]);

    const pending = store.pendingTelegramAlerts(Date.now(), 10);
    assert.deepEqual(pending.map((alert) => alert.alertId), ['A:4', 'A:6', 'A:11']);
    assert.deepEqual(
      pending.map((alert) => [alert.payload.trigger.previous, alert.payload.trigger.current]),
      [[5, 16], [5, 15], [16, 22]],
    );
  } finally {
    store.close();
  }
});
test('T100 growth alerts independently of Min FW and repeats on each qualifying increase', () => {
  const store = new MonitorStore(':memory:');
  const lowFreshCa = 'LowFreshT10011111111111111111111111111';
  const missingFreshCa = 'MissingFreshT100111111111111111111111111';
  try {
    store.commitAlertObservations('A', [
      observation(1, 't100', 3, 'LOW-FRESH', lowFreshCa, 14.99),
      observation(2, 't100', 4, 'LOW-FRESH', lowFreshCa, 14.99),
      observation(3, 't100', 3, 'NO-FRESH', missingFreshCa, null),
      observation(4, 't100', 4, 'NO-FRESH', missingFreshCa, null),
      observation(5, 't100', 4, 'LOW-FRESH', lowFreshCa, 10),
      observation(6, 't100', 5.3, 'LOW-FRESH', lowFreshCa, 10),
    ]);

    const pending = store.pendingTelegramAlerts(Date.now(), 10);
    assert.deepEqual(pending.map((alert) => alert.alertId), ['A:2', 'A:4', 'A:5', 'A:6']);
    assert.ok(pending.every((alert) => alert.payload.trigger.metric === 't100'));
  } finally {
    store.close();
  }
});

test('FW and T100 alerts enqueue independently for the same CA', () => {
  const store = new MonitorStore(':memory:');
  const ca = 'DualMetricMint11111111111111111111111111';
  try {
    store.commitAlertObservations('A', [
      observation(1, 'fresh', 10, 'DUAL', ca),
      observation(2, 't100', 2, 'DUAL', ca, null),
      observation(3, 'fresh', 16, 'DUAL', ca),
      observation(4, 't100', 3, 'DUAL', ca, null),
    ]);

    const pending = store.pendingTelegramAlerts(Date.now(), 10);
    assert.deepEqual(
      pending.map((alert) => [alert.alertId, alert.payload.trigger.metric]),
      [['A:3', 'fresh'], ['A:4', 't100']],
    );
    store.commitAlertObservations('A', [
      observation(3, 'fresh', 16, 'DUAL', ca),
      observation(4, 't100', 3, 'DUAL', ca, null),
    ]);
    assert.equal(store.pendingTelegramAlerts(Date.now(), 10).length, 2);
  } finally {
    store.close();
  }
});
test('ambiguous Telegram outcome is not resent after reopening the outbox', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-scan-monitor-alert-'));
  const dbPath = join(directory, 'monitor.sqlite3');
  const configuration = readMonitorConfig({ MONITOR_API_TOKEN: 'feed-token' });
  let sends = 0;
  const bot = new TelegramBot('test-token', 'test-chat', async () => {
    sends += 1;
    throw new TypeError('fetch failed');
  });
  const feed: typeof fetch = async (input) => {
    if (new URL(String(input)).pathname.endsWith('/ack')) return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ observations: [] }), { status: 200 });
  };
  let now = 1_700_000_001_000;
  let store = new MonitorStore(dbPath);
  try {
    store.commitAlertObservations('A', [
      observation(1, 'fresh', 15),
      observation(2, 'fresh', 20),
    ]);
    await new MonitorAlerts(store, configuration, bot, feed, () => now).tick();
    assert.equal(sends, 1);
    store.close();

    store = new MonitorStore(dbPath);
    now += 3_600_000;
    await new MonitorAlerts(store, configuration, bot, feed, () => now).tick();
    assert.equal(sends, 1);
    assert.deepEqual(store.pendingTelegramAlerts(now, 10), []);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('claimed Telegram delivery is not requeued after a process restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-scan-monitor-claim-'));
  const dbPath = join(directory, 'monitor.sqlite3');
  let store = new MonitorStore(dbPath);
  try {
    store.commitAlertObservations('A', [
      observation(1, 'fresh', 15),
      observation(2, 'fresh', 20),
    ]);
    const [pending] = store.pendingTelegramAlerts(Date.now(), 10);
    assert.ok(pending);
    assert.equal(store.markTelegramAlertSending(pending.alertId), true);
    store.close();

    store = new MonitorStore(dbPath);
    assert.deepEqual(store.pendingTelegramAlerts(Date.now(), 10), []);
    assert.equal(store.markTelegramAlertSending(pending.alertId), false);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});


test('legacy outbox migration keeps new alerts pending and never retries sent or retried alerts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-scan-monitor-migration-'));
  const dbPath = join(directory, 'monitor.sqlite3');
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE telegram_alert_outbox (
      alert_id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      next_attempt_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      sent_at INTEGER,
      last_error TEXT
    );
  `);
  legacy.prepare(`
    INSERT INTO telegram_alert_outbox
      (alert_id, payload_json, created_at, next_attempt_at, attempts, sent_at, last_error)
    VALUES (?, '{}', 1, 1, ?, ?, NULL)
  `).run('fresh-unsent', 0, null);
  legacy.prepare(`
    INSERT INTO telegram_alert_outbox
      (alert_id, payload_json, created_at, next_attempt_at, attempts, sent_at, last_error)
    VALUES (?, '{}', 1, 1, ?, ?, NULL)
  `).run('previously-retried', 2, null);
  legacy.prepare(`
    INSERT INTO telegram_alert_outbox
      (alert_id, payload_json, created_at, next_attempt_at, attempts, sent_at, last_error)
    VALUES (?, '{}', 1, 1, ?, ?, NULL)
  `).run('already-sent', 0, 2);
  legacy.close();

  const store = new MonitorStore(dbPath);
  try {
    assert.deepEqual(store.pendingTelegramAlerts(10, 10).map((alert) => alert.alertId), ['fresh-unsent']);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test('adds multipart progress to an existing delivery-state outbox', () => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-scan-monitor-parts-migration-'));
  const dbPath = join(directory, 'monitor.sqlite3');
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE telegram_alert_outbox (
      alert_id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      next_attempt_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      sent_at INTEGER,
      last_error TEXT,
      delivery_state TEXT NOT NULL DEFAULT 'pending'
    );
    INSERT INTO telegram_alert_outbox (alert_id, payload_json, created_at, next_attempt_at)
    VALUES ('existing', '{}', 1, 1);
  `);
  legacy.close();

  const store = new MonitorStore(dbPath);
  try {
    assert.equal(store.pendingTelegramAlerts(10, 10)[0]?.sentParts, 0);
    assert.equal(store.pendingTelegramAlerts(10, 10)[0]?.deliveryMode, 'photo');
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy text progress remains in text mode after avatar outbox migration', () => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-scan-monitor-mode-migration-'));
  const dbPath = join(directory, 'monitor.sqlite3');
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE telegram_alert_outbox (
      alert_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      next_attempt_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      sent_at INTEGER, last_error TEXT, delivery_state TEXT NOT NULL DEFAULT 'pending',
      sent_parts INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO telegram_alert_outbox (alert_id, payload_json, created_at, next_attempt_at, sent_parts)
    VALUES ('partial-text', '{}', 1, 1, 1);
  `);
  legacy.close();
  const store = new MonitorStore(dbPath);
  try {
    const pending = store.pendingTelegramAlerts(10, 10)[0];
    assert.equal(pending?.sentParts, 1);
    assert.equal(pending?.deliveryMode, 'text');
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});



test('Telegram failures stay queued and retry after persisted backoff', async () => {
  const store = new MonitorStore(':memory:');
  const configuration = readMonitorConfig({ MONITOR_API_TOKEN: 'feed-token' });
  let now = 1_700_000_001_000;
  let sends = 0;
  const bot = new TelegramBot('test-token', 'test-chat', async () => {
    sends += 1;
    return sends === 1
      ? new Response(JSON.stringify({ ok: false, description: 'rate limited', parameters: { retry_after: 7 } }), { status: 429 })
      : new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  const alerts = new MonitorAlerts(store, configuration, bot, async () => new Response(JSON.stringify({ observations: [] })), () => now);
  const sample = observation(1, 'fresh', 15);
  store.commitAlertObservations('A', [sample]);
  store.commitAlertObservations('A', [observation(2, 'fresh', 20)]);
  try {
    await alerts.tick();
    assert.equal(sends, 1);
    assert.equal(store.pendingTelegramAlerts(now + 14_999, 10).length, 0);
    now += 15_000;
    await alerts.tick();
    assert.equal(sends, 2);
    assert.equal(store.pendingTelegramAlerts(now, 10).length, 0);
  } finally {
    store.close();
  }
});

test('suppresses source B Solana alerts at enqueue and drains legacy pending alerts without blocking other chains', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-scan-monitor-b-sol-suppression-'));
  const dbPath = join(directory, 'monitor.sqlite3');
  const store = new MonitorStore(dbPath);
  const legacyAlert = {
    alertId: 'B:legacy-sol',
    chain: 'sol',
    ca: 'LegacySolMint11111111111111111111111111111111',
    symbol: 'LEGACY_SOL',
    trigger: { metric: 'trackerBuy', previous: 0, current: 25_000, responseAt: 1_700_000_000_000 },
    nansen: {},
  };
  const legacyDb = new Database(dbPath);
  legacyDb.prepare(`
    INSERT INTO telegram_alert_outbox (alert_id, payload_json, created_at, next_attempt_at)
    VALUES (?, ?, ?, ?)
  `).run(legacyAlert.alertId, JSON.stringify(legacyAlert), 1_700_000_000_000, 1_700_000_000_000);
  legacyDb.close();
  const rules = {
    fwGrowthPct: 30,
    minFwPct: 15,
    t100GrowthPct: 30,
    minMcK: -1,
    maxMcK: -1,
    trackerBuyingK: 20,
  };
  const aSol = observation(1, 'trackerBuy', 25_000, 'A_SOL');
  const bSol = observation(1, 'trackerBuy', 25_000, 'B_SOL');
  const bBase = { ...observation(2, 'trackerBuy', 25_000, 'B_BASE'), chain: 'base' as const };
  const messages: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/ack')) return new Response(null, { status: 204 });
    const sourceA = url.hostname === 'api-a';
    const afterId = Number(url.searchParams.get('afterId'));
    return new Response(JSON.stringify({
      observations: (sourceA ? [aSol] : [bSol, bBase]).filter((row) => row.id > afterId),
      telegramAlertRules: rules,
    }), { status: 200 });
  };
  const bot = new TelegramBot('test-token', 'test-chat', async (_url, init) => {
    const payload = telegramPayload(init);
    const text = typeof payload.caption === 'string' ? payload.caption : payload.text;
    if (typeof text === 'string') messages.push(text);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  const now = 1_700_000_001_000;
  const alerts = new MonitorAlerts(store, readMonitorConfig({
    MONITOR_API_TOKEN: 'feed-token',
    MONITOR_API_A_URL: 'http://api-a',
    MONITOR_API_B_URL: 'http://api-b',
  }), bot, fetcher, () => now);
  try {
    await alerts.tick();
    assert.equal(store.alertCursor('B'), 2, 'suppressed observations still advance the source cursor');
    assert.equal(messages.length, 2);
    assert.ok(messages.some((text) => text.includes('$A_SOL')));
    assert.ok(messages.some((text) => text.includes('$B_BASE')));
    assert.ok(messages.every((text) => !text.includes('B_SOL') && !text.includes('LEGACY_SOL')));

    const outbox = new Database(dbPath, { readonly: true });
    try {
      assert.deepEqual(outbox.prepare(`
        SELECT alert_id, delivery_state FROM telegram_alert_outbox ORDER BY alert_id
      `).all(), [
        { alert_id: 'A:1', delivery_state: 'sent' },
        { alert_id: 'B:2', delivery_state: 'sent' },
        { alert_id: 'B:legacy-sol', delivery_state: 'suppressed' },
      ]);
    } finally {
      outbox.close();
    }
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Tracker Buying alerts only on a single priced BUY strictly above configured K, independent of FW', () => {
  const store = new MonitorStore(':memory:');
  try {
    store.commitAlertObservations('A', [
      observation(1, 'trackerBuy', 50_000, 'BOUNDARY', 'TrackerBuyMint11111111111111111111111111', 0),
      observation(2, 'trackerBuy', 50_001, 'ABOVE', 'TrackerBuyMint11111111111111111111111111', 0),
    ], { fwGrowthPct: 30, minFwPct: 15, t100GrowthPct: 30, minMcK: -1, maxMcK: -1, trackerBuyingK: 50 });
    const pending = store.pendingTelegramAlerts(Date.now(), 10);
    assert.deepEqual(pending.map((alert) => alert.alertId), ['A:2']);
    assert.equal(pending[0]?.payload.trigger.metric, 'trackerBuy');
    assert.equal(pending[0]?.payload.trigger.current, 50_001);
    const disabled = observation(1, 'trackerBuy', 500_001, 'DISABLED');
    store.commitAlertObservations('B', [disabled], {
      fwGrowthPct: 30,
      minFwPct: 15,
      t100GrowthPct: 30,
      minMcK: -1,
      maxMcK: -1,
      trackerBuyingK: 0,
    });
    const legacy = observation(2, 'trackerBuy', 50_001, 'LEGACY');
    const legacySnapshot = { ...legacy.snapshot };
    delete legacySnapshot.trackerBuyer;
    store.commitAlertObservations('B', [{ ...legacy, snapshot: legacySnapshot }], {
      fwGrowthPct: 30,
      minFwPct: 15,
      t100GrowthPct: 30,
      minMcK: -1,
      maxMcK: -1,
      trackerBuyingK: 50,
    });
    assert.deepEqual(store.pendingTelegramAlerts(Date.now(), 10).map((alert) => alert.alertId), ['A:2']);
  } finally {
    store.close();
  }
});
test('global MC min/max bounds gate Fresh, T100, and Tracker Buying; -1 disables a bound', () => {
  const store = new MonitorStore(':memory:');
  const rules = {
    fwGrowthPct: 30,
    minFwPct: 15,
    t100GrowthPct: 30,
    minMcK: 20,
    maxMcK: 30,
    trackerBuyingK: 1,
  };
  const freshInside = 'FreshInsideMint1111111111111111111111111';
  const freshAbove = 'FreshAboveMint1111111111111111111111111';
  const freshMissing = 'FreshMissingMint11111111111111111111111';
  const t100Inside = 'T100InsideMint11111111111111111111111111';
  const t100Above = 'T100AboveMint11111111111111111111111111';
  try {
    store.commitAlertObservations('A', [
      observation(1, 'fresh', 20, 'F-IN', freshInside, 20, 20_000),
      observation(2, 'fresh', 26.2, 'F-IN', freshInside, 26.2, 20_000),
      observation(3, 'fresh', 20, 'F-OUT', freshAbove, 20, 31_000),
      observation(4, 'fresh', 26.2, 'F-OUT', freshAbove, 26.2, 31_000),
      observation(5, 'fresh', 20, 'F-NULL', freshMissing, 20, 25_000),
      observation(6, 'fresh', 26.2, 'F-NULL', freshMissing, 26.2, null),
      observation(7, 't100', 1, 'T-IN', t100Inside, 41, 20_000),
      observation(8, 't100', 2, 'T-IN', t100Inside, 41, 30_000),
      observation(9, 't100', 1, 'T-OUT', t100Above, 41, 20_000),
      observation(10, 't100', 2, 'T-OUT', t100Above, 41, 31_000),
      observation(11, 'trackerBuy', 1_001, 'BUY-IN', undefined, 0, 20_000),
      observation(12, 'trackerBuy', 1_001, 'BUY-OUT', undefined, 0, 31_000),
      observation(13, 'trackerBuy', 1_001, 'BUY-NULL', undefined, 0, null),
    ], rules);

    const pending = store.pendingTelegramAlerts(Date.now(), 20);
    assert.deepEqual(pending.map((alert) => alert.alertId), ['A:2', 'A:8', 'A:11']);
    assert.deepEqual(pending[2]?.payload.trigger.buyer, { name: 'BUY-IN', address: 'TrackerWallet111' });

    const noBounds = new MonitorStore(':memory:');
    try {
      noBounds.commitAlertObservations('A', [
        observation(1, 'trackerBuy', 1_001, 'LEGACY-UNFILTERED', undefined, 0, null),
      ], { ...rules, minMcK: -1, maxMcK: -1 });
      assert.deepEqual(noBounds.pendingTelegramAlerts(Date.now(), 10).map((alert) => alert.alertId), ['A:1']);
    } finally {
      noBounds.close();
    }
  } finally {
    store.close();
  }
});
test('legacy alert rules without MC bounds leave the market cap filter disabled', async () => {
  const store = new MonitorStore(':memory:');
  const configuration = readMonitorConfig({
    MONITOR_API_TOKEN: 'feed-token',
    MONITOR_API_A_URL: 'http://api-a',
    MONITOR_API_B_URL: 'http://api-b',
  });
  const ca = 'LegacyRulesMint1111111111111111111111111111';
  const observations = [
    observation(1, 'fresh', 20, 'LEGACY', ca, 20, null),
    observation(2, 'fresh', 26.2, 'LEGACY', ca, 26.2, null),
  ];
  const messages: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/ack')) return new Response(null, { status: 204 });
    const sourceA = url.hostname === 'api-a';
    return new Response(JSON.stringify({
      observations: sourceA ? observations.filter((row) => row.id > Number(url.searchParams.get('afterId'))) : [],
      ...(sourceA ? {
        telegramAlertRules: { fwGrowthPct: 30, minFwPct: 15, t100GrowthPct: 30, trackerBuyingK: 0 },
      } : {}),
    }), { status: 200 });
  };
  const bot = new TelegramBot('test-token', 'test-chat', async (_url, init) => {
    const payload = telegramPayload(init);
    const text = typeof payload.caption === 'string' ? payload.caption : payload.text;
    if (typeof text === 'string') messages.push(text);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  const alerts = new MonitorAlerts(store, configuration, bot, fetcher, () => 1_700_000_001_000);
  try {
    await alerts.tick();
    assert.equal(messages.length, 1);
    assert.ok(messages[0]?.includes('Fresh wallet growth: +31% (20% → 26.2%)'));
  } finally {
    store.close();
  }
});
test('FOMO tracker-buy observations use the shared rule on source B and render handle-only identity', async () => {
  const store = new MonitorStore(':memory:');
  const configuration = readMonitorConfig({
    MONITOR_API_TOKEN: 'feed-token',
    MONITOR_API_A_URL: 'http://api-a',
    MONITOR_API_B_URL: 'http://api-b',
  });
  const ca = '0x88ad8ddf1e3898412146a534538d418c6f8a9062';
  const fomoBuy = observation(1, 'trackerBuy', 24_865.82, 'STANDARD', ca);
  fomoBuy.chain = 'robinhood';
  fomoBuy.snapshot.trackerBuyer = { name: 'midcurver' };
  const messages: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/ack')) return new Response(null, { status: 204 });
    const sourceA = url.hostname === 'api-a';
    const afterId = Number(url.searchParams.get('afterId'));
    return new Response(JSON.stringify({
      observations: sourceA ? [] : fomoBuy.id > afterId ? [fomoBuy] : [],
      telegramAlertRules: { fwGrowthPct: 30, minFwPct: 15, t100GrowthPct: 30, minMcK: 10, maxMcK: -1, trackerBuyingK: 20 },
    }), { status: 200 });
  };
  const bot = new TelegramBot('test-token', 'test-chat', async (_url, init) => {
    const payload = telegramPayload(init);
    const text = typeof payload.caption === 'string' ? payload.caption : payload.text;
    if (typeof text === 'string') messages.push(text);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  const alerts = new MonitorAlerts(store, configuration, bot, fetcher, () => 1_700_000_001_000);
  try {
    await alerts.tick();
    assert.equal(messages.length, 1);
    assert.match(messages[0] ?? '', /Tracker Buying: FOMO user midcurver bought \$24,865\.82/);
    assert.equal(store.alertCursor('B'), 1);
    await alerts.tick();
    assert.equal(messages.length, 1, 're-reading the same event after cursor commit does not send twice');
  } finally {
    store.close();
  }
});
test('FOMO trade API feeds one thresholded Tracker Buying Telegram alert end-to-end', async () => {
  const originalKey = config.fomoApiKey;
  const originalShowFomo = config.showFomo;
  config.fomoApiKey = '';
  config.showFomo = true;
  const store = new MonitorStore(':memory:');
  let api: Server | undefined;
  open(':memory:');
  const user = insertFomoUser({ handle: 'midcurver', user_id: 'integration-user', name: 'Midcurver' });
  const ca = '0x88ad8ddf1e3898412146a534538d418c6f8a9062';
  getDb().prepare('INSERT INTO token_state (ca, chain, symbol, market_cap, supply) VALUES (?, ?, ?, ?, ?)')
    .run(ca, 'robinhood', 'STANDARD', 15_810_503, 1_000_000);
  const auth = await createTestAuth();
  auth.deps.monitorToken = 'monitor-test-token';
  api = createApp('test', auth.deps).listen(0);
  await new Promise((resolve) => api?.once('listening', resolve));
  const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  try {
    const fomoRules = await fetch(`${apiUrl}/api/fomo/telegram-alert-rules`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', authorization: await auth.bearer(auth.adminEmail) },
      body: JSON.stringify({
        fwGrowthPct: 30, minFwPct: 15, t100GrowthPct: 30, minMcK: 10, maxMcK: -1, trackerBuyingK: 20,
      }),
    });
    assert.equal(fomoRules.status, 200);
    const posted = await fetch(`${apiUrl}/api/fomo-watch/trades`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_SERVICE_TOKEN}` },
      body: JSON.stringify({
        eventId: 'integration-fomo-buy',
        userId: 'integration-user',
        trader: user.handle,
        type: 'buy',
        tokenAddress: ca,
        chain: 'robinhood',
        ts: 1_791_879_930_000,
        tradeUsd: 24_865.82,
        usdValue: 24_875,
      }),
    });
    assert.equal(posted.status, 200);
    const messages: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'api-a') {
        return new Response(JSON.stringify({
          observations: [],
          telegramAlertRules: { fwGrowthPct: 30, minFwPct: 15, t100GrowthPct: 30, minMcK: 10, maxMcK: -1, trackerBuyingK: 20 },
        }), { status: 200 });
      }
      const headers = new Headers(init?.headers);
      headers.set('authorization', 'Bearer monitor-test-token');
      return fetch(`${apiUrl}${url.pathname}${url.search}`, { ...init, headers });
    };
    const bot = new TelegramBot('test-token', 'test-chat', async (_url, init) => {
      const payload = telegramPayload(init);
      const text = typeof payload.caption === 'string' ? payload.caption : payload.text;
      if (typeof text === 'string') messages.push(text);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const monitorNow = Date.now() + 60_000;
    const alerts = new MonitorAlerts(store, readMonitorConfig({
      MONITOR_API_TOKEN: 'feed-token', MONITOR_API_A_URL: 'http://api-a', MONITOR_API_B_URL: 'http://api-b',
    }), bot, fetcher, () => monitorNow);
    await alerts.tick();
    assert.equal(messages.length, 1);
    assert.match(messages[0] ?? '', /Tracker Buying: FOMO user midcurver bought \$24,865\.82/);
    await alerts.tick();
    assert.equal(messages.length, 1);
  } finally {
    await new Promise<void>((resolve) => api?.close(() => resolve()));
    store.close();
    getDb().close();
    config.fomoApiKey = originalKey;
    config.showFomo = originalShowFomo;
  }
});
test('resumes multipart alert at first unsent Telegram part after retryable rejection', async () => {
  const store = new MonitorStore(':memory:');
  const configuration = readMonitorConfig({
    MONITOR_API_TOKEN: 'feed-token',
    MONITOR_API_A_URL: 'http://api-a',
    MONITOR_API_B_URL: 'http://api-b',
  });
  const wallets = Array.from({ length: 129 }, (_, index) =>
    `wallet-${String(index).padStart(3, '0')}-${'w'.repeat(72)}`,
  );
  const fomoUsers = Array.from({ length: 129 }, (_, index) =>
    `fomo-${String(index).padStart(3, '0')}-${'f'.repeat(72)}`,
  );
  const attempts: string[] = [];
  const delivered: string[] = [];
  let rejectSecondPart = true;
  let now = Date.now() + 60_000;
  const bot = new TelegramBot('test-token', 'test-chat', async (_url, init) => {
    const payload = telegramPayload(init);
    const text = String(payload.caption ?? payload.text ?? '');
    attempts.push(text);
    if (rejectSecondPart && text.startsWith('Part 2/')) {
      rejectSecondPart = false;
      return new Response(JSON.stringify({
        ok: false,
        description: 'rate limited',
        parameters: { retry_after: 1 },
      }), { status: 429 });
    }
    delivered.push(text);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  const feed: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/ack')) return new Response(null, { status: 204 });
    const rows = [first, second].filter((row) => row.id > Number(url.searchParams.get('afterId') ?? '0'));
    return new Response(JSON.stringify({
      observations: url.hostname === 'api-a' ? [] : rows,
      ...(url.hostname === 'api-a' ? {
        telegramAlertRules: { fwGrowthPct: 30, minFwPct: 15, t100GrowthPct: 30, minMcK: -1, maxMcK: -1, trackerBuyingK: 20 },
      } : {}),
    }), { status: 200 });
  };
  const first = { ...observation(1, 'fresh', 15, 'LONG-LIST'), chain: 'base' as const };
  const second = { ...observation(2, 'fresh', 20, 'LONG-LIST', first.ca), chain: 'base' as const };
  second.snapshot.tracked = {
    count: wallets.length + fomoUsers.length,
    wallets: { names: wallets, total: wallets.length },
    fomoUsers: { names: fomoUsers, total: fomoUsers.length },
  };
  const alerts = new MonitorAlerts(store, configuration, bot, feed, () => now);
  try {
    await alerts.tick();
    assert.equal(store.alertCursor('B'), 2);
    assert.equal(attempts.filter((text) => text.startsWith('Part 2/')).length, 1);
    assert.equal(store.pendingTelegramAlerts(now + 60_000, 10)[0]?.sentParts, 1);
    assert.equal(store.pendingTelegramAlerts(now + 60_000, 10)[0]?.deliveryMode, 'photo');

    now += 60_000;
    await alerts.tick();
    assert.equal(attempts.filter((text) => text.startsWith('Part 2/')).length, 2);
    assert.equal(delivered.length, attempts.length - 1);
    assert.deepEqual(store.pendingTelegramAlerts(now, 10), []);
    for (const name of [...wallets, ...fomoUsers]) {
      assert.equal(delivered.filter((text) => text.includes(name)).length, 1);
    }
  } finally {
    store.close();
  }
});
