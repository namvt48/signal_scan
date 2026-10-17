import { CHAINS } from '../shared/chain.js';
import type { AlertMetricObservation, AlertMetricSnapshot, AlertTrackedMetadata } from '../alert-feed.js';
import { validatedIconUrl } from '../providers/dexscreener.js';
import { DEFAULT_TELEGRAM_ALERT_RULES, type TelegramAlertRules } from '../telegram-alert-settings.js';
import { isSuppressedTelegramAlert } from './alert-policy.js';
import type { MonitorConfig } from './config.js';
import { MonitorStore } from './store.js';
import { TelegramBot, TelegramSendError } from './telegram.js';

const PAGE_SIZE = 200;
const OUTBOX_BATCH_SIZE = 10;
type Source = 'A' | 'B';
type Fetcher = typeof fetch;

function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return Reflect.get(value, key);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function nullableNumber(value: unknown): value is number | null {
  return value === null || finite(value);
}

function parseTrackedGroup(raw: unknown): AlertTrackedMetadata['wallets'] | null {
  const namesRaw = field(raw, 'names');
  const total = field(raw, 'total');
  if (!Array.isArray(namesRaw) ||
      typeof total !== 'number' || !Number.isSafeInteger(total) || total < namesRaw.length) return null;
  const names: string[] = [];
  for (const name of namesRaw) {
    if (typeof name !== 'string' || name.length > 128) return null;
    if (name.trim()) names.push(name.trim());
  }
  return { names, total };
}

function parseTrackedMetadata(raw: unknown): AlertTrackedMetadata | undefined {
  if (raw === undefined || raw === null) return undefined;
  const count = field(raw, 'count');
  const wallets = parseTrackedGroup(field(raw, 'wallets'));
  const fomoUsers = parseTrackedGroup(field(raw, 'fomoUsers'));
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 ||
      wallets === null || fomoUsers === null || count !== wallets.total + fomoUsers.total) return undefined;
  return { count, wallets, fomoUsers };
}

function parseObservation(raw: unknown): AlertMetricObservation | null {
  const id = field(raw, 'id');
  const ca = field(raw, 'ca');
  const chain = field(raw, 'chain');
  const metric = field(raw, 'metric');
  const value = field(raw, 'value');
  const responseAt = field(raw, 'responseAt');
  const snapshotRaw = field(raw, 'snapshot');
  if (!Number.isSafeInteger(id) || (id as number) <= 0 || typeof ca !== 'string' || ca.length < 1 || ca.length > 128 ||
      typeof chain !== 'string' || !(CHAINS as readonly string[]).includes(chain) ||
      (metric !== 'fresh' && metric !== 't100' && metric !== 'trackerBuy') || !finite(value) ||
      !Number.isSafeInteger(responseAt) || (responseAt as number) <= 0) return null;
  const capturedAt = field(snapshotRaw, 'capturedAt');
  const symbol = field(snapshotRaw, 'symbol');
  const marketCap = field(snapshotRaw, 'marketCap');
  const marketCapAt = field(snapshotRaw, 'marketCapAt');
  const freshPct = field(snapshotRaw, 'freshPct');
  const t100Multiple = field(snapshotRaw, 't100Multiple');
  const lf = field(snapshotRaw, 'lf');
  const trackedHoldingPct = field(snapshotRaw, 'trackedHoldingPct');
  const trackerBuyerRaw = field(snapshotRaw, 'trackerBuyer');
  let trackerBuyer: AlertMetricObservation['snapshot']['trackerBuyer'];
  if (trackerBuyerRaw !== undefined && trackerBuyerRaw !== null) {
    const name = field(trackerBuyerRaw, 'name');
    const address = field(trackerBuyerRaw, 'address');
    if (typeof name !== 'string' || name.length > 128 ||
        (address !== undefined && (typeof address !== 'string' || address.length < 1 || address.length > 128))) return null;
    trackerBuyer = typeof address === 'string' ? { name, address } : { name };
  }
  const iconUrlRaw = field(snapshotRaw, 'iconUrl');
  const iconUrl = typeof iconUrlRaw === 'string' && iconUrlRaw.length <= 2048
    ? validatedIconUrl(iconUrlRaw)
    : undefined;
  const xHandleRaw = field(snapshotRaw, 'xHandle');
  const xHandle = typeof xHandleRaw === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(xHandleRaw)
    ? xHandleRaw
    : undefined;
  const tracked = parseTrackedMetadata(field(snapshotRaw, 'tracked'));
  if (!Number.isSafeInteger(capturedAt) || (capturedAt as number) <= 0 ||
      (symbol !== null && typeof symbol !== 'string') ||
      !nullableNumber(marketCap) || !nullableNumber(marketCapAt) || !nullableNumber(freshPct) ||
      !nullableNumber(t100Multiple) || !nullableNumber(lf) || !nullableNumber(trackedHoldingPct)) return null;
  return {
    id: id as number,
    ca,
    chain: chain as AlertMetricObservation['chain'],
    metric,
    value,
    responseAt: responseAt as number,
    snapshot: {
      capturedAt: capturedAt as number,
      symbol: symbol as string | null,
      marketCap,
      marketCapAt,
      freshPct,
      t100Multiple,
      lf,
      trackedHoldingPct,
      ...(trackerBuyer ? { trackerBuyer } : {}),
      ...(iconUrl ? { iconUrl } : {}),
      ...(xHandle ? { xHandle } : {}),
      ...(tracked ? { tracked } : {}),
    } satisfies AlertMetricSnapshot,
  };
}

function responseKind(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}
function parseRules(raw: unknown): TelegramAlertRules | null {
  const fwGrowthPct = field(raw, 'fwGrowthPct');
  const minFwPct = field(raw, 'minFwPct');
  const t100GrowthPct = field(raw, 't100GrowthPct');
  const rawMinMcK = field(raw, 'minMcK');
  const rawMaxMcK = field(raw, 'maxMcK');
  const minMcK = rawMinMcK === undefined ? -1 : rawMinMcK;
  const maxMcK = rawMaxMcK === undefined ? -1 : rawMaxMcK;
  const trackerBuyingK = field(raw, 'trackerBuyingK');
  if (!finite(fwGrowthPct) || fwGrowthPct < 0 || !finite(minFwPct) || minFwPct < 0 || minFwPct > 100 ||
      !finite(t100GrowthPct) || t100GrowthPct < 0 || !finite(minMcK) || (minMcK !== -1 && minMcK < 0) ||
      !finite(maxMcK) || (maxMcK !== -1 && maxMcK < 0) ||
      (minMcK >= 0 && maxMcK >= 0 && minMcK > maxMcK) ||
      !finite(trackerBuyingK) || trackerBuyingK < 0) return null;
  return { fwGrowthPct, minFwPct, t100GrowthPct, minMcK, maxMcK, trackerBuyingK };
}

export class MonitorAlerts {
  private readonly rules: Record<Source, TelegramAlertRules> = {
    A: { ...DEFAULT_TELEGRAM_ALERT_RULES },
    B: { ...DEFAULT_TELEGRAM_ALERT_RULES },
  };
  constructor(
    private readonly store: MonitorStore,
    private readonly config: MonitorConfig,
    private readonly bot: TelegramBot,
    private readonly fetcher: Fetcher = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async tick(): Promise<void> {
    await this.consumeSource('A', this.config.apiAUrl);
    await this.consumeSource('B', this.config.apiBUrl);
    await this.sendPending();
  }

  private async consumeSource(source: Source, baseUrl: string): Promise<void> {
    const cursor = this.store.alertCursor(source);
    const endpoint = new URL('/api/monitor/alerts', baseUrl);
    endpoint.searchParams.set('afterId', String(cursor));
    endpoint.searchParams.set('limit', String(PAGE_SIZE));
    try {
      const response = await this.fetcher(endpoint, {
        headers: { Authorization: `Bearer ${this.config.apiToken}` },
        signal: AbortSignal.timeout(5_000),
      });
      const body: unknown = await response.json().catch(() => null);
      const rawObservations = field(body, 'observations');
      if (!response.ok || !Array.isArray(rawObservations)) throw new Error(`feed_http_${response.status}`);
      const observations: AlertMetricObservation[] = [];
      let previousId = cursor;
      for (const raw of rawObservations) {
        const observation = parseObservation(raw);
        if (observation === null || observation.id <= previousId) throw new Error('invalid_alert_observation');
        observations.push(observation);
        previousId = observation.id;
      }
      this.rules[source] = parseRules(field(body, 'telegramAlertRules')) ?? this.rules[source];
      const committedCursor = this.store.commitAlertObservations(source, observations, this.rules[source]);
      await this.acknowledgeSource(baseUrl, committedCursor);
    } catch (error) {
      console.error(`[monitor] alert feed ${source} failed: ${responseKind(error)}`);
    }
  }

  private async acknowledgeSource(baseUrl: string, throughId: number): Promise<void> {
    const response = await this.fetcher(new URL('/api/monitor/alerts/ack', baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ throughId }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`ack_http_${response.status}`);
  }

  private async sendPending(): Promise<void> {
    if (!this.bot.configured) return;
    for (const pending of this.store.pendingTelegramAlerts(this.now(), OUTBOX_BATCH_SIZE)) {
      if (isSuppressedTelegramAlert(pending.payload, pending.alertId)) {
        this.store.markTelegramAlertSuppressed(pending.alertId);
        continue;
      }
      if (!this.store.markTelegramAlertSending(pending.alertId)) continue;
      try {
        await this.bot.send(pending.payload, {
          sentParts: pending.sentParts,
          deliveryMode: pending.deliveryMode,
          onPartSent: (sentParts, deliveryMode) => {
            if (!this.store.markTelegramAlertPartSent(pending.alertId, sentParts, deliveryMode)) {
              throw new Error('telegram_alert_progress_conflict');
            }
          },
        });
        this.store.markTelegramAlertSent(pending.alertId, this.now());
      } catch (error) {
        const kind = responseKind(error);
        if (error instanceof TelegramSendError && error.deliveryStatus === 'rejected') {
          if (error.retryable) {
            const retryAfterMs = error.retryDelayMs ?? 0;
            const backoffMs = Math.min(3_600_000, 15_000 * 2 ** Math.min(pending.attempts, 8));
            this.store.markTelegramAlertFailure(
              pending.alertId,
              this.now() + Math.max(backoffMs, retryAfterMs),
              kind,
            );
          } else {
            this.store.markTelegramAlertRejected(pending.alertId, kind);
          }
        } else {
          this.store.markTelegramAlertUncertain(pending.alertId, kind);
        }
        break;
      }
    }
  }
}
