import type { PeriodicScanItem } from '../periodic-scan.js';
import { PERIODIC_SCAN_INTERVAL_HOURS } from '../periodic-scan-settings.js';
import { CHAINS } from '../shared/chain.js';
import type { MonitorConfig } from './config.js';
import { MonitorStore } from './store.js';
import { TelegramBot, TelegramSendError, type PeriodicScanReportEntry } from './telegram.js';

const UTC7_OFFSET_MS = 7 * 60 * 60 * 1_000;
const SLOT_GRACE_MINUTES = 5;

type Source = 'A' | 'B';
type Fetcher = typeof fetch;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseItem(raw: unknown): PeriodicScanItem | null {
  const value = record(raw);
  const nansen = record(value?.nansen);
  if (value === null || nansen === null || typeof value.ca !== 'string' || value.ca === '' ||
      typeof value.chain !== 'string' || !(CHAINS as readonly string[]).includes(value.chain) ||
      typeof nansen.freshCurrent !== 'boolean' ||
      (nansen.freshUpdatedAt !== undefined &&
        (!finite(nansen.freshUpdatedAt) || !Number.isSafeInteger(nansen.freshUpdatedAt) || nansen.freshUpdatedAt < 0)) ||
      !finite(value.volume24h) || !finite(value.trackedHolding)) return null;
  const rawT100 = record(nansen.t100);
  const t100 = rawT100 !== null && finite(rawT100.multiple) ? { multiple: rawT100.multiple } : undefined;
  return {
    chain: value.chain as PeriodicScanItem['chain'],
    ca: value.ca,
    ...(typeof value.symbol === 'string' ? { symbol: value.symbol } : {}),
    ...(finite(value.marketCap) ? { marketCap: value.marketCap } : {}),
    ...(typeof value.iconUrl === 'string' ? { iconUrl: value.iconUrl } : {}),
    ...(typeof value.xHandle === 'string' ? { xHandle: value.xHandle } : {}),
    nansen: {
      freshCurrent: nansen.freshCurrent,
      ...(finite(nansen.freshUpdatedAt) ? { freshUpdatedAt: nansen.freshUpdatedAt } : {}),
      ...(t100 !== undefined ? { t100 } : {}),
      ...(finite(nansen.lf) ? { lf: nansen.lf } : {}),
      ...(finite(nansen.fresh) ? { fresh: nansen.fresh } : {}),
      ...(finite(nansen.rawFresh) ? { rawFresh: nansen.rawFresh } : {}),
    },
    volume24h: value.volume24h,
    trackedHolding: value.trackedHolding,
  };
}

function parseFeed(raw: unknown): { enabled: boolean; intervalHours: number; signals: PeriodicScanItem[] } | null {
  const body = record(raw);
  const settings = record(body?.settings);
  if (body === null || settings === null || typeof settings.enabled !== 'boolean' ||
      !PERIODIC_SCAN_INTERVAL_HOURS.includes(settings.intervalHours as typeof PERIODIC_SCAN_INTERVAL_HOURS[number]) ||
      !Array.isArray(body.signals)) {
    return null;
  }
  const signals: PeriodicScanItem[] = [];
  for (const rawSignal of body.signals) {
    const signal = parseItem(rawSignal);
    if (signal === null) return null;
    signals.push(signal);
  }
  return { enabled: settings.enabled, intervalHours: settings.intervalHours as number, signals };
}
export function periodicScanSlotUtc7(now: number, intervalHours = 6): string | null {
  const local = new Date(now + UTC7_OFFSET_MS);
  const hour = local.getUTCHours();
  const minute = local.getUTCMinutes();
  if (!PERIODIC_SCAN_INTERVAL_HOURS.includes(intervalHours as typeof PERIODIC_SCAN_INTERVAL_HOURS[number]) ||
      hour % intervalHours !== 0 || minute >= SLOT_GRACE_MINUTES) return null;
  return `${local.toISOString().slice(0, 13)}:00+07:00`;
}
export class PeriodicScanRunner {
  constructor(
    private readonly store: MonitorStore,
    private readonly config: MonitorConfig,
    private readonly bot: TelegramBot,
    private readonly fetcher: Fetcher = fetch,
    private readonly now: () => number = Date.now,
  ) {}
  async tick(): Promise<void> {
    const slot = periodicScanSlotUtc7(this.now(), 1);
    if (slot === null) return;
    const [a, b] = await Promise.all([
      this.scanSource('A', this.config.apiAUrl, slot),
      this.scanSource('B', this.config.apiBUrl, slot),
    ]);
    if (a === null || b === null) return;
    const dueSources = [a, b].filter((scan) => scan.due);
    const entries = dueSources.flatMap((scan) => scan.entries);
    if (dueSources.length === 0 || entries.length === 0) return;
    const sourceKey = dueSources.map((scan) => scan.source).join('+');
    const intervals = [...new Set(dueSources.map((scan) => scan.intervalHours))];
    await this.deliver(sourceKey, slot, () => this.bot.sendPeriodicScanReport(entries, slot, intervals));
  }

  private async scanSource(
    source: Source,
    baseUrl: string,
    slot: string,
  ): Promise<{ source: Source; due: boolean; intervalHours: number; entries: PeriodicScanReportEntry[] } | null> {
    let feed: { enabled: boolean; intervalHours: number; signals: PeriodicScanItem[] } | null;
    try {
      const response = await this.fetcher(new URL('/api/monitor/periodic-scan', baseUrl), {
        headers: { Authorization: `Bearer ${this.config.apiToken}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      feed = parseFeed(await response.json());
      if (feed === null) throw new Error('invalid scan response');
    } catch (error) {
      const kind = error instanceof Error ? error.name : 'Error';
      console.warn(`[monitor] periodic scan ${source} unavailable: ${kind}`);
      return null;
    }
    const due = feed.enabled && periodicScanSlotUtc7(this.now(), feed.intervalHours) === slot;
    return {
      source,
      due,
      intervalHours: feed.intervalHours,
      entries: due ? feed.signals.map((signal) => ({ source, signal })) : [],
    };
  }

  private async deliver(sources: string, slot: string, send: () => Promise<void>): Promise<void> {
    const key = `periodic-scan:report:${sources}:${slot}`;
    const previous = this.store.notificationState(key);
    if (previous?.state === 'sent' || previous?.state === 'sending' ||
        previous?.state === 'uncertain' || previous?.state === 'failed') return;
    this.store.setNotificationState(key, 'sending', null, null);
    try {
      await send();
      this.store.setNotificationState(key, 'sent', this.now(), null);
    } catch (error) {
      const state = error instanceof TelegramSendError && error.deliveryStatus === 'unknown'
        ? 'uncertain'
        : error instanceof TelegramSendError && error.retryable
          ? 'rejected'
          : 'failed';
      this.store.setNotificationState(key, state, null, error instanceof Error ? error.name : 'Error');
      console.warn(`[monitor] periodic scan ${sources} report delivery ${state}`);
    }
  }
}

