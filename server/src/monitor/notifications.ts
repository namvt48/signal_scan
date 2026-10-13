import type { MonitorConfig } from './config.js';
import { DiscordBot } from './discord.js';
import { MonitorStore } from './store.js';
import type { MonitorSnapshot } from './types.js';

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
}

function zonedParts(ts: number, timezone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ts));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
  };
}

function zoneOffset(ts: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ts));
  const values = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
  const zonedAsUtc = Date.UTC(values.year!, values.month! - 1, values.day!, values.hour!, values.minute!, values.second!);
  return zonedAsUtc - Math.floor(ts / 1_000) * 1_000;
}

function localDate(ts: number, timezone: string): string {
  const p = zonedParts(ts, timezone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function localMidnight(ts: number, timezone: string): number {
  const p = zonedParts(ts, timezone);
  const localMidnightAsUtc = Date.UTC(p.year, p.month - 1, p.day);
  const firstGuess = localMidnightAsUtc - zoneOffset(ts, timezone);
  return localMidnightAsUtc - zoneOffset(firstGuess, timezone);
}

function retryableError(error: unknown): string {
  if (!(error instanceof Error)) return 'delivery_error';
  return /^discord_http_\d{3}$/.test(error.message) ? error.message : error.name;
}

function numberText(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
}

export class MonitorNotifications {
  private readonly retryAt = new Map<string, number>();
  private lastError: string | null = null;

  constructor(
    private readonly store: MonitorStore,
    private readonly bot: DiscordBot,
    private readonly config: MonitorConfig,
    private readonly now: () => number = Date.now,
  ) {}

  status(): MonitorSnapshot['notifications'] {
    const sentAt = this.store.lastNotificationDeliveryAt();
    return {
      discordConfigured: this.bot.configured,
      lastDeliveryAt: sentAt === null ? null : new Date(sentAt).toISOString(),
      lastError: this.lastError,
    };
  }

  async tick(): Promise<void> {
    if (!this.bot.configured) return;
    const now = this.now();
    await this.sendLowCreditWarnings(now);
    await this.sendDailyReport(now);
  }

  private async sendLowCreditWarnings(now: number): Promise<void> {
    const { credits } = this.store.snapshot(now, this.config.sampleIntervalMs * 3);
    for (const metric of credits) {
      if (metric.provider !== 'FOMO' && metric.provider !== 'Nansen') continue;
      const stateKey = `low:${metric.provider}:${metric.key}`;
      const previous = this.store.notificationState(stateKey);
      const low = metric.status === 'low' || metric.status === 'exhausted';
      if (!low) {
        this.retryAt.delete(stateKey);
        if (previous !== null && previous.state !== 'normal') {
          this.store.setNotificationState(stateKey, 'normal', previous.sentAt, null);
        }
        continue;
      }
      if (previous?.state === 'sent-low' || !this.mayRetry(stateKey, now)) continue;
      const threshold = metric.threshold === null ? '' : ` (ngưỡng ${numberText(metric.threshold)} ${metric.unit})`;
      const message = [
        `⚠️ Credit thấp · ${metric.label}`,
        `Còn ${metric.remaining === null ? 'không rõ' : numberText(metric.remaining)} / ${metric.limit === null ? 'không rõ' : numberText(metric.limit)} ${metric.unit}${threshold}.`,
        metric.source,
      ].join('\n');
      await this.deliver(stateKey, 'sent-low', message, now, previous?.sentAt ?? null);
    }
  }

  private async sendDailyReport(now: number): Promise<void> {
    const parts = zonedParts(now, this.config.timezone);
    if (parts.hour < this.config.dailyReportHour) return;
    const date = localDate(now, this.config.timezone);
    const stateKey = `daily:${date}`;
    const previous = this.store.notificationState(stateKey);
    if (previous?.state === 'sent' || !this.mayRetry(stateKey, now)) return;

    const snapshot = this.store.snapshot(now, this.config.sampleIntervalMs * 3);
    const usage = this.store.usageBetween(localMidnight(now, this.config.timezone), now);
    const healthy = snapshot.services.filter((service) => service.status === 'healthy').length;
    const serviceSummary = `${healthy}/${snapshot.services.length} dịch vụ khỏe mạnh`;
    const fomo = snapshot.credits.find((metric) => metric.provider === 'FOMO');
    const nansenRows = usage.filter((row) => row.provider === 'Nansen');
    const gmgnRows = usage.filter((row) => row.provider === 'GMGN');
    const rpcRows = usage.filter((row) => row.provider.includes('RPC'));
    const observedAmount = (rows: typeof usage): string => rows.length === 0
      ? 'chưa có mẫu'
      : numberText(rows.reduce((sum, row) => sum + row.amount, 0));
    const fomoText = fomo === undefined || fomo.used === null || fomo.limit === null || fomo.remaining === null
      ? 'chưa có balance snapshot'
      : `${numberText(fomo.used)} / ${numberText(fomo.limit)} credits đã dùng trong tháng; còn ${numberText(fomo.remaining)}`;
    const lines = [
      `📊 Signal Scan · Báo cáo ${date} (${this.config.timezone})`,
      `Dịch vụ: ${serviceSummary}.`,
      `Nansen: ${observedAmount(nansenRows)} credits quan sát trên shared internal daily budget.`,
      `FOMO: ${fomoText}.`,
      `GMGN: ${observedAmount(gmgnRows)} request thành công quan sát trong ngày; balance credit không được API tích hợp công bố.`,
      `RPC: ${observedAmount(rpcRows)} outbound request quan sát trong ngày; provider credit balance không khả dụng.`,
      'Lịch sử usage chỉ tính từ các mẫu monitor đã thu thập; không nội suy thời gian trước lần lấy mẫu đầu tiên.',
    ];
    await this.deliver(stateKey, 'sent', lines.join('\n'), now, previous?.sentAt ?? null);
  }

  private mayRetry(key: string, now: number): boolean {
    const last = this.retryAt.get(key);
    if (last !== undefined && now - last < 300_000) return false;
    this.retryAt.set(key, now);
    return true;
  }

  private async deliver(key: string, successState: string, message: string, now: number, previousSentAt: number | null): Promise<void> {
    try {
      await this.bot.send(message);
      this.lastError = null;
      this.store.setNotificationState(key, successState, now, null);
    } catch (error) {
      this.lastError = retryableError(error);
      this.store.setNotificationState(key, 'error', previousSentAt, this.lastError);
    }
  }
}
