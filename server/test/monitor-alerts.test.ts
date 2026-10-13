import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { test } from 'node:test';
import type { AlertMetricObservation } from '../src/alert-feed.js';
import { readMonitorConfig } from '../src/monitor/config.js';
import { MonitorAlerts } from '../src/monitor/alerts.js';
import { MonitorStore } from '../src/monitor/store.js';
import { TelegramBot } from '../src/monitor/telegram.js';

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
    B: [observation(1, 'fresh', 15), observation(2, 'fresh', 50, 'B-TOKEN')],
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
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
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
      method === 'sendPhoto' && payload.photo === 'https://cdn.dexscreener.com/cms/images/token-icon.png'));
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
      payload: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  const alerts = new MonitorAlerts(store, configuration, bot, fetcher, () => 1_700_000_001_000);
  try {
    await alerts.tick();
    assert.equal(store.alertCursor('A'), 2);
    assert.equal(telegramRequests.length, 1);
    assert.equal(telegramRequests[0]?.method, 'sendMessage');
    const text = telegramRequests[0]?.payload.text;
    assert.equal(typeof text, 'string');
    assert.match(text as string, /Fresh wallet growth: \+35% \(20% → 27%\)/);
    assert.match(text as string, /CA search on X/);
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
    assert.deepEqual(pending.map((alert) => alert.alertId), ['A:4', 'A:7']);
    assert.equal(pending[0]?.payload.trigger.previous, 3.25 * 1.3);
    assert.equal(pending[0]?.payload.trigger.current, 5.5);
    assert.equal(pending[1]?.payload.trigger.previous, 5);
    assert.equal(pending[1]?.payload.trigger.current, 6.7);
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
    assert.deepEqual(pending.map((alert) => alert.alertId), ['A:2', 'A:4', 'A:6']);
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
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
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
