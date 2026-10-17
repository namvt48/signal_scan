import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TokenSignal } from '../../src/types.js';
import { DEFAULT_PERIODIC_SCAN_SETTINGS } from '../src/periodic-scan-settings.js';
import { selectPeriodicScanSignals } from '../src/periodic-scan.js';
import { readMonitorConfig } from '../src/monitor/config.js';
import { MonitorStore } from '../src/monitor/store.js';
import { periodicScanSlotUtc7, PeriodicScanRunner } from '../src/monitor/periodic-scan.js';
import { TelegramBot, formatPeriodicScanAlert } from '../src/monitor/telegram.js';

function signal(overrides: Partial<TokenSignal> = {}): TokenSignal {
  return {
    id: 'sol:CA1',
    ca: 'CA1',
    chain: 'sol',
    symbol: 'DEMO',
    trackedWallets: [],
    fomoUsers: [],
    nansen: { score: 0, pass: { fresh: false, t100: false, lf: false }, t100: { pct: 12, multiple: 1.12 }, lf: 68_000_000, fresh: 8, rawFresh: 8 },
    holders: 10,
    marketCap: 120_000,
    dataUpdatedAt: { volume24h: 1 },
    trackedInflow: 0,
    trackedActivityAt: 0,
    trackedHolding: 3.5,
    volume24h: 299_000,
    tier: null,
    ...overrides,
  };
}

test('periodic scan uses strict AND thresholds and excludes incomplete or stale volume data', () => {
  const rows = [
    signal(),
    signal({ id: 'volume-boundary', volume24h: 300_000 }),
    signal({ id: 'lf-boundary', nansen: { ...signal().nansen, lf: 69_000_000 } }),
    signal({ id: 'missing-lf', nansen: { score: 0, pass: { fresh: false, t100: false, lf: false } } }),
    signal({ id: 'unknown-volume-time', dataUpdatedAt: undefined }),
  ];
  assert.deepEqual(selectPeriodicScanSignals(rows, DEFAULT_PERIODIC_SCAN_SETTINGS).map((row) => row.id), ['sol:CA1']);
  assert.deepEqual(selectPeriodicScanSignals(rows, { ...DEFAULT_PERIODIC_SCAN_SETTINGS, enabled: false }), []);
});

test('periodic scan uses configurable UTC+7 hour boundaries with a short dispatch grace window', () => {
  assert.equal(periodicScanSlotUtc7(Date.UTC(2026, 0, 1, 17, 0)), '2026-01-02T00:00+07:00');
  assert.equal(periodicScanSlotUtc7(Date.UTC(2026, 0, 1, 23, 4)), '2026-01-02T06:00+07:00');
  assert.equal(periodicScanSlotUtc7(Date.UTC(2026, 0, 1, 23, 5)), null);
  assert.equal(periodicScanSlotUtc7(Date.UTC(2026, 0, 1, 18, 0)), null);
  assert.equal(periodicScanSlotUtc7(Date.UTC(2026, 0, 1, 20, 0), 3), '2026-01-02T03:00+07:00');
  assert.equal(periodicScanSlotUtc7(Date.UTC(2026, 0, 1, 19, 0), 3), null);
  assert.equal(periodicScanSlotUtc7(Date.UTC(2026, 0, 1, 17, 0), 1), '2026-01-02T00:00+07:00');
});
test('Telegram alert and periodic destinations are independent and must differ', () => {
  const alertOnly = readMonitorConfig({
    MONITOR_API_TOKEN: 'monitor-token',
    TELEGRAM_CHAT_ID: 'alerts-chat',
  });
  assert.equal(alertOnly.telegramPeriodicChatId, '');
  assert.throws(() => readMonitorConfig({
    MONITOR_API_TOKEN: 'monitor-token',
    TELEGRAM_ALERT_THREAD_ID: '11',
  }), /TELEGRAM_CHAT_ID is required/);
  const config = readMonitorConfig({
    MONITOR_API_TOKEN: 'monitor-token',
    TELEGRAM_CHAT_ID: 'alerts-chat',
    TELEGRAM_ALERT_THREAD_ID: '11',
    TELEGRAM_PERIODIC_CHAT_ID: 'periodic-chat',
  });
  assert.equal(config.telegramAlertThreadId, 11);
  assert.equal(config.telegramPeriodicChatId, 'periodic-chat');
  assert.throws(() => readMonitorConfig({
    MONITOR_API_TOKEN: 'monitor-token',
    TELEGRAM_CHAT_ID: 'same-chat',
    TELEGRAM_PERIODIC_CHAT_ID: 'same-chat',
  }), /must differ from TELEGRAM_CHAT_ID/);
});
test('periodic scan omits empty reports, blocks partial feeds, and does not retry ambiguous or partial delivery', async () => {
  for (const scenario of ['empty', 'unavailable', 'uncertain', 'partial'] as const) {
    let telegramCalls = 0;
    const config = readMonitorConfig({
      MONITOR_API_TOKEN: 'monitor-token',
      MONITOR_API_A_URL: 'http://api-a',
      MONITOR_API_B_URL: 'http://api-b',
      TELEGRAM_CHAT_ID: 'alert-chat',
      TELEGRAM_ALERT_THREAD_ID: '11',
      TELEGRAM_PERIODIC_CHAT_ID: 'periodic-chat',
    });
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.startsWith('https://api.telegram.org/')) {
        telegramCalls += 1;
        if (scenario === 'uncertain' || (scenario === 'partial' && telegramCalls === 2)) {
          throw new Error('network timeout');
        }
        return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
      }
      if (scenario === 'unavailable' && url.includes('api-a')) return new Response('', { status: 503 });
      return new Response(JSON.stringify({
        settings: { enabled: true, intervalHours: 3 },
        signals: scenario === 'empty' ? [] : [{
          chain: 'sol', ca: 'CA1', symbol: 'DEMO', iconUrl: 'https://cdn.dexscreener.com/cms/images/token-icon.png',
          volume24h: 299_000, trackedHolding: 1, nansen: { lf: 68_000_000 },
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const store = new MonitorStore(':memory:');
    try {
      const runner = new PeriodicScanRunner(
        store,
        config,
        new TelegramBot('bot-token', 'alert-chat', fetcher, undefined, { alerts: 11 }, 'periodic-chat'),
        fetcher,
        () => Date.UTC(2026, 0, 1, 20, 0),
      );
      await runner.tick();
      if (scenario === 'uncertain' || scenario === 'partial') {
        await runner.tick();
        assert.equal(telegramCalls, scenario === 'partial' ? 2 : 1);
        assert.equal(
          store.notificationState('periodic-scan:report:A+B:2026-01-02T03:00+07:00')?.state,
          'uncertain',
        );
      } else {
        assert.equal(telegramCalls, 0, `${scenario} scenario must not deliver`);
      }
    } finally {
      store.close();
    }
  }
});

test('periodic scan formatter includes requested metrics and encoded links', () => {
  const text = formatPeriodicScanAlert({
    chain: 'sol', ca: 'CA/&1', symbol: '<DEMO>', marketCap: 12_000,
    iconUrl: 'https://example.com/token.png', xHandle: 'demo_token',
    nansen: { t100: { multiple: 1.12 }, lf: 68_000_000, rawFresh: 8 },
    volume24h: 299_000, trackedHolding: 3.5,
  });
  assert.ok(text.includes('Nansen: Top100 1.12 | Low Float 68M | Fresh Wallet 8%'));
  assert.ok(text.includes('24h volume:'));
  assert.ok(text.includes('Tracker holding: 3.5%'));
  assert.ok(text.includes('Twitter:') && text.includes('CA search on X'));
  assert.ok(text.includes('CA: <a href="https://gmgn.ai/sol/token/CA%2F%261">Gmgn</a>'));
  assert.ok(text.includes('https://x.com/search?q=CA%2F%261'));
  assert.ok(text.includes('$&lt;DEMO&gt;\nMC: $12K\n\nCA:'));
  assert.ok(!text.startsWith('<a'));
});
 

test('periodic scan sends a source/time header and captioned avatar album idempotently across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'signal-scan-periodic-'));
  const path = join(directory, 'monitor.sqlite3');
  const now = Date.UTC(2026, 0, 1, 20, 0);
  let endpointCalls = 0;
  let avatarRenders = 0;
  const headers: string[] = [];
  const albumMedia: Array<Array<Record<string, unknown>>> = [];
  const telegramMethods: string[] = [];
  const avatarBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const config = readMonitorConfig({
    MONITOR_API_TOKEN: 'monitor-token',
    MONITOR_TIMEZONE: 'Asia/Ho_Chi_Minh',
    MONITOR_API_A_URL: 'http://api-a',
    MONITOR_API_B_URL: 'http://api-b',
    TELEGRAM_CHAT_ID: 'alert-chat',
    TELEGRAM_ALERT_THREAD_ID: '11',
    TELEGRAM_PERIODIC_CHAT_ID: 'periodic-chat',
  });
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://api.telegram.org/')) {
      const method = url.slice(url.lastIndexOf('/') + 1);
      telegramMethods.push(method);
      if (method === 'sendMessage') {
        const payload = JSON.parse(String(init?.body)) as { chat_id: string; message_thread_id?: number; text: string };
        assert.equal(payload.chat_id, 'periodic-chat');
        assert.equal(payload.message_thread_id, undefined);
        headers.push(payload.text);
        return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
      }
      assert.equal(method, 'sendMediaGroup');
      assert.ok(init?.body instanceof FormData);
      const form = init.body;
      assert.equal(form.get('chat_id'), 'periodic-chat');
      assert.equal(form.get('message_thread_id'), null);
      const media = JSON.parse(String(form.get('media'))) as Array<Record<string, unknown>>;
      albumMedia.push(media);
      const firstAvatar = form.get('periodic_avatar_0');
      const fallback = form.get('periodic_avatar_1');
      assert.ok(firstAvatar instanceof Blob);
      assert.ok(fallback instanceof Blob);
      assert.deepEqual(new Uint8Array(await firstAvatar.arrayBuffer()), avatarBytes);
      assert.deepEqual(new Uint8Array(await fallback.arrayBuffer()), avatarBytes);
      return new Response(JSON.stringify({
        ok: true, result: media.map((_, index) => ({ message_id: index + 1 })),
      }), { status: 200 });
    }
    endpointCalls += 1;
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${config.apiToken}`);
    return new Response(JSON.stringify({
      settings: { enabled: true, intervalHours: 3 },
      signals: [{
        chain: 'sol', ca: 'CA1', symbol: 'DEMO', ...(url.includes('api-a')
          ? { iconUrl: 'https://cdn.dexscreener.com/cms/images/token-icon.png' } : {}),
        marketCap: 120_000, nansen: { t100: { multiple: 1.12 }, lf: 68_000_000, rawFresh: 8 },
        volume24h: url.includes('api-a') ? 299_000 : 298_000, trackedHolding: 3.5,
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const store = new MonitorStore(path);
    const runner = new PeriodicScanRunner(
      store,
      config,
      new TelegramBot('bot-token', 'alert-chat', fetcher, async (symbol) => {
        avatarRenders += 1;
        assert.equal(symbol, 'DEMO');
        return avatarBytes;
      }, { alerts: 11 }, 'periodic-chat'),
      fetcher,
      () => now,
    );
    await runner.tick();
    assert.deepEqual(telegramMethods, ['sendMessage', 'sendMediaGroup']);
    assert.deepEqual(headers, ['Periodic scan · Dashboard A+B · 2026-01-02 03:00 UTC+7 · 3h · 2 CA']);
    assert.equal(albumMedia.length, 1);
    assert.equal(albumMedia[0]!.length, 2);
    assert.equal(albumMedia[0]![0]!.media, 'attach://periodic_avatar_0');
    assert.equal(albumMedia[0]![1]!.media, 'attach://periodic_avatar_1');
    assert.match(String(albumMedia[0]![0]!.caption), /^Dashboard A · 2026-01-02 03:00 UTC\+7/);
    assert.match(String(albumMedia[0]![1]!.caption), /^Dashboard B · 2026-01-02 03:00 UTC\+7/);
    assert.ok(String(albumMedia[0]![0]!.caption).includes('24h volume: $299K'));
    assert.ok(String(albumMedia[0]![1]!.caption).includes('24h volume: $298K'));
    assert.equal(avatarRenders, 2);
    store.close();

    const reopened = new MonitorStore(path);
    try {
      const restarted = new PeriodicScanRunner(
        reopened,
        config,
        new TelegramBot('bot-token', 'alert-chat', fetcher, async () => avatarBytes, { alerts: 11 }, 'periodic-chat'),
        fetcher,
        () => now,
      );
      await restarted.tick();
      assert.deepEqual(telegramMethods, ['sendMessage', 'sendMediaGroup']);
      assert.equal(endpointCalls, 4);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
