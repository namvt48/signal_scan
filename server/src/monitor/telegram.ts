import { validatedIconUrl } from '../providers/dexscreener.js';
import type { AlertTrackedMetadata } from '../alert-feed.js';
export type TelegramAlert = {
  alertId: string;
  chain: 'sol' | 'base' | 'bsc' | 'robinhood';
  ca: string;
  symbol?: string;
  marketCap?: number;
  marketCapAt?: number;
  trigger: {
    metric: 'fresh' | 't100' | 'trackerBuy';
    previous: number;
    current: number;
    responseAt: number;
    buyer?: { name: string; address: string };
  };
  nansen: { freshPct?: number; t100Multiple?: number; lf?: number };
  trackedHoldingPct?: number;
  iconUrl?: string;
  xHandle?: string;
  tracked?: AlertTrackedMetadata;
  source: 'A' | 'B';
};

export class TelegramSendError extends Error {
  readonly retryDelayMs?: number;
  readonly mediaRejected: boolean;
  readonly deliveryStatus: 'rejected' | 'unknown';
  readonly retryable: boolean;

  constructor(
    message: string,
    retryDelayMs?: number,
    mediaRejected = false,
    deliveryStatus: 'rejected' | 'unknown' = 'rejected',
    retryable = retryDelayMs !== undefined,
  ) {
    super(message);
    this.name = 'TelegramSendError';
    this.retryDelayMs = retryDelayMs;
    this.mediaRejected = mediaRejected;
    this.deliveryStatus = deliveryStatus;
    this.retryable = retryable;
  }
}


type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function value(value: number | undefined, suffix = ''): string {
  return value === undefined || !Number.isFinite(value) ? 'chưa có' : `${dashboardNumber(value)}${suffix}`;
}
function marketCapText(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return 'chưa có';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  }).format(value);
}

function dashboardNumber(value: number): string {
  return String(Number(value.toFixed(3)));
}

function dashboardCompact(value: number): string {
  const abs = Math.abs(value);
  for (const [size, suffix] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']] as const) {
    if (abs >= size) return `${dashboardNumber(value / size)}${suffix}`;
  }
  return dashboardNumber(value);
}

function metricValue(value: number | undefined, format: (number: number) => string, suffix = ''): string {
  return value === undefined || !Number.isFinite(value) ? 'chưa có' : `${format(value)}${suffix}`;
}

function usdText(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 8,
  }).format(value);
}

function numberText(value: number): string {
  return dashboardNumber(value);
}

function trackerBuyerText(buyer: TelegramAlert['trigger']['buyer']): string {
  if (buyer === undefined) return 'Unknown wallet (address unavailable)';
  const name = buyer.name.trim();
  return name && name !== buyer.address ? `${name} (${buyer.address})` : buyer.address;
}
function timestampText(value: number): string {
  if (!Number.isFinite(value)) return 'chưa có';
  const localTime = new Date(value + 7 * 60 * 60 * 1000);
  return Number.isNaN(localTime.getTime()) ? 'chưa có' : localTime.toISOString().slice(0, 19).replace('T', ' ');
}

function trackedNamesText(group: AlertTrackedMetadata['wallets']): string {
  const names = group.names.map(escapeHtml).join(', ') || 'none';
  const more = Math.max(0, group.total - group.names.length);
  return more === 0 ? names : `${names} +${more} more`;
}

function visibleTextLength(html: string): number {
  return html
    .replace(/<[^>]*>/g, '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&')
    .length;
}

export function formatTelegramAlert(alert: TelegramAlert): string {
  const ticker = alert.symbol?.trim().slice(0, 128) || `${alert.ca.slice(0, 6)}…${alert.ca.slice(-4)}`;
  const url = `https://gmgn.ai/${alert.chain}/token/${encodeURIComponent(alert.ca)}`;
  const triggerText = alert.trigger.metric === 'fresh'
    ? alert.trigger.previous > 0
      ? `Fresh wallet growth: +${numberText(((alert.trigger.current - alert.trigger.previous) / alert.trigger.previous) * 100)}% (${numberText(alert.trigger.previous)}% → ${numberText(alert.trigger.current)}%)`
      : `Fresh wallet growth: unavailable (0% → ${numberText(alert.trigger.current)}%)`
    : alert.trigger.metric === 't100'
      ? `Top100 increase: ${numberText(alert.trigger.previous)} → ${numberText(alert.trigger.current)}`
      : `Tracker Buying: ${trackerBuyerText(alert.trigger.buyer)} bought ${usdText(alert.trigger.current)}`;
  const xHandle = alert.xHandle && /^[A-Za-z0-9_]{1,15}$/.test(alert.xHandle) ? alert.xHandle : undefined;
  const xSearchUrl = `https://x.com/search?q=${encodeURIComponent(alert.ca)}`;
  const trackedLines = alert.tracked === undefined
    ? []
    : [
      `Tracked in: ${alert.tracked.count}`,
      `Tracked by: ${trackedNamesText(alert.tracked.wallets)}`,
      ...(alert.source === 'B' ? [`FOMO users: ${trackedNamesText(alert.tracked.fomoUsers)}`] : []),
    ];
  return [
    `<a href="${escapeHtml(url)}">${escapeHtml(ticker)}</a>`,
    `MC: ${marketCapText(alert.marketCap)}`,
    `<b>${escapeHtml(triggerText)}</b>`,
    `Nansen: Top100 ${metricValue(alert.nansen.t100Multiple, dashboardNumber)} | Low Float ${metricValue(alert.nansen.lf, dashboardCompact)} | Fresh ${metricValue(alert.nansen.freshPct, dashboardNumber, '%')}`,
    `Tracker holding: ${value(alert.trackedHoldingPct, '%')}`,
    ...trackedLines,
    `Twitter: ${xHandle ? `<a href="https://x.com/${xHandle}">@${escapeHtml(xHandle)}</a>` : 'unavailable'} | <a href="${escapeHtml(xSearchUrl)}">CA search on X</a>`,
    `Time: ${timestampText(alert.trigger.responseAt)}`,
  ].join('\n');
}


export class TelegramBot {
  readonly configured: boolean;

  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly fetcher: Fetcher = fetch,
    private readonly renderAvatar?: (symbol?: string) => Promise<Uint8Array>,
  ) {
    this.configured = token.trim().length > 0 && chatId.trim().length > 0;
  }

  async send(alert: TelegramAlert): Promise<void> {
    if (!this.configured) throw new TelegramSendError('Telegram is not configured');
    const text = formatTelegramAlert(alert);
    const textLength = visibleTextLength(text);
    if (textLength > 4096) throw new TelegramSendError('Telegram alert exceeds the message limit');
    const photo = validatedIconUrl(alert.iconUrl);
    let avatar: Uint8Array | undefined;
    if (!photo && textLength <= 1024 && this.renderAvatar) {
      try {
        avatar = await this.renderAvatar(alert.symbol);
      } catch (error) {
        const kind = error instanceof Error ? error.name : 'UnknownError';
        console.warn(`[monitor] Telegram avatar render failed: ${kind}; falling back to text`);
      }
    }
    if ((photo || avatar) && textLength <= 1024) {
      try {
        await this.request('sendPhoto', {
          chat_id: this.chatId,
          ...(photo ? { photo } : {}),
          caption: text,
          parse_mode: 'HTML',
        }, avatar);
        return;
      } catch (error) {
        if (!(error instanceof TelegramSendError) || !error.mediaRejected) throw error;
      }
    }
    await this.request('sendMessage', {
      chat_id: this.chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  }

  private async request(
    method: 'sendPhoto' | 'sendMessage',
    body: Record<string, unknown>,
    photoBytes?: Uint8Array,
  ): Promise<void> {
    let response: Response;
    try {
      const init: RequestInit = photoBytes
        ? { method: 'POST', body: multipartBody(body, photoBytes), signal: AbortSignal.timeout(10_000) }
        : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        };
      response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, init);
    } catch {
      throw new TelegramSendError('Telegram request failed', undefined, false, 'unknown');
    }
    let result: {
      ok?: boolean;
      error_code?: number;
      description?: string;
      parameters?: { retry_after?: number };
    };
    try {
      result = await response.json() as typeof result;
    } catch {
      throw new TelegramSendError(
        `Telegram returned invalid JSON (HTTP ${response.status})`,
        undefined,
        false,
        'unknown',
      );
    }
    if (!response.ok || result.ok !== true) {
      const delay = result.parameters?.retry_after;
      const errorCode = typeof result.error_code === 'number' ? result.error_code : response.status;
      const definitelyRejected = result.ok === false && response.status < 500;
      throw new TelegramSendError(
        result.description ?? `Telegram send failed (HTTP ${response.status})`,
        typeof delay === 'number' && Number.isFinite(delay) && delay >= 0 ? delay * 1000 : undefined,
        method === 'sendPhoto' && definitelyRejected && errorCode === 400,
        definitelyRejected ? 'rejected' : 'unknown',
        definitelyRejected && response.status === 429,
      );
    }
  }
}

function multipartBody(body: Record<string, unknown>, photoBytes: Uint8Array): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(body)) form.append(key, String(value));
  form.append('photo', new Blob([photoBytes], { type: 'image/jpeg' }), 'token-avatar.jpg');
  return form;
}
