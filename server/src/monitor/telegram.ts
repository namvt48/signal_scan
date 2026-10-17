import { renderCaIdenticon } from '../token-avatar.js';
import type { Chain } from '../shared/chain.js';
import type { AlertTrackedMetadata } from '../alert-feed.js';
import type { PeriodicScanItem } from '../periodic-scan.js';
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
    buyer?: { name: string; address?: string };
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
  if (buyer.address === undefined) return `FOMO user ${name || 'unknown'}`;
  return name && name !== buyer.address ? `${name} (${buyer.address})` : buyer.address;
}

function trackedNamesLines(label: string, group: AlertTrackedMetadata['wallets']): string[] {
  if (group.names.length === 0) return [`${label}: none`];
  const lines: string[] = [];
  let current = `${label}: `;
  let currentCount = 0;
  for (const name of group.names) {
    const escaped = escapeHtml(name);
    const separator = currentCount === 0 ? '' : ', ';
    const candidate = `${current}${separator}${escaped}`;
    if (visibleTextLength(candidate) > 3_000) {
      lines.push(current);
      current = `${label} (cont.): ${escaped}`;
      currentCount = 1;
    } else {
      current = candidate;
      currentCount += 1;
    }
  }
  lines.push(current);
  return lines;
}

function splitTelegramText(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  let currentLength = 0;
  for (const line of text.split('\n')) {
    const lineLength = visibleTextLength(line);
    if (lineLength > 4_000) throw new TelegramSendError('Telegram alert contains an oversized line');
    const separatorLength = current.length === 0 ? 0 : 1;
    if (currentLength + separatorLength + lineLength > 4_000) {
      parts.push(current);
      current = line;
      currentLength = lineLength;
    } else {
      current = current.length === 0 ? line : `${current}\n${line}`;
      currentLength += separatorLength + lineLength;
    }
  }
  if (current.length > 0) parts.push(current);
  return parts;
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
  const rawTicker = alert.symbol?.trim().slice(0, 128) || `${alert.ca.slice(0, 6)}…${alert.ca.slice(-4)}`;
  const ticker = rawTicker.startsWith('$') ? rawTicker : `$${rawTicker}`;
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
      ...trackedNamesLines('Tracked by', alert.tracked.wallets),
    ];
  const fomoLines = alert.source === 'B' && alert.tracked !== undefined
    ? trackedNamesLines('FOMO users', alert.tracked.fomoUsers)
    : [];
  const metricLines = [
    `Nansen: Top100 ${metricValue(alert.nansen.t100Multiple, dashboardNumber)} | Low Float ${metricValue(alert.nansen.lf, dashboardCompact)} | Fresh ${metricValue(alert.nansen.freshPct, dashboardNumber, '%')}`,
    `Tracker holding: ${value(alert.trackedHoldingPct, '%')}`,
    ...trackedLines,
  ];
  const twitterLine = `Twitter: ${xHandle ? `<a href="https://x.com/${xHandle}">@${escapeHtml(xHandle)}</a>` : 'unavailable'} | <a href="${escapeHtml(xSearchUrl)}">CA search on X</a>`;
  return [
    `${escapeHtml(ticker)}\nMC: ${marketCapText(alert.marketCap)}`,
    `CA: <a href="${escapeHtml(url)}">Gmgn</a>`,
    `<b>👌 ${escapeHtml(triggerText)}</b>`,
    metricLines.join('\n'),
    ...(fomoLines.length > 0 ? [fomoLines.join('\n')] : []),
    '——',
    twitterLine,
  ].join('\n\n');
}

export interface PeriodicScanReportEntry {
  source: 'A' | 'B';
  signal: PeriodicScanItem;
}

export interface TelegramThreadIds {
  alerts?: number;
}

export function formatPeriodicScanAlert(signal: PeriodicScanItem): string {
  const rawTicker = signal.symbol?.trim().slice(0, 128) || `${signal.ca.slice(0, 6)}…${signal.ca.slice(-4)}`;
  const ticker = rawTicker.startsWith('$') ? rawTicker : `$${rawTicker}`;
  const xHandle = signal.xHandle && /^[A-Za-z0-9_]{1,15}$/.test(signal.xHandle) ? signal.xHandle : undefined;
  const xSearchUrl = `https://x.com/search?q=${encodeURIComponent(signal.ca)}`;
  const gmgnUrl = `https://gmgn.ai/${signal.chain}/token/${encodeURIComponent(signal.ca)}`;
  return [
    `${escapeHtml(ticker)}\nMC: ${marketCapText(signal.marketCap)}`,
    `CA: <a href="${escapeHtml(gmgnUrl)}">Gmgn</a>`,
    [
      `Nansen: Top100 ${metricValue(signal.nansen.t100?.multiple, dashboardNumber)} | Low Float ${metricValue(signal.nansen.lf, dashboardCompact)} | Fresh Wallet ${metricValue(signal.nansen.rawFresh ?? signal.nansen.fresh, dashboardNumber, '%')}`,
      `24h volume: ${marketCapText(signal.volume24h)}`,
      `Tracker holding: ${value(signal.trackedHolding, '%')}`,
      `Twitter: ${xHandle ? `<a href="https://x.com/${xHandle}">@${escapeHtml(xHandle)}</a>` : 'unavailable'} | <a href="${escapeHtml(xSearchUrl)}">CA search on X</a>`,
    ].join('\n'),
  ].join('\n\n');
}

function periodicScanSlotLabel(slot: string): string {
  return slot.replace('T', ' ').replace('+07:00', ' UTC+7');
}

function formatPeriodicScanHeader(
  entries: readonly PeriodicScanReportEntry[],
  slot: string,
  intervalHours: readonly number[],
): string {
  const sources = [...new Set(entries.map(({ source }) => source))].join('+');
  const intervals = [...new Set(intervalHours)].sort((left, right) => left - right);
  const cadence = intervals.length === 0 ? '' : ` · ${intervals.map((hours) => `${hours}h`).join('/')}`;
  return `Periodic scan · Dashboard ${sources} · ${periodicScanSlotLabel(slot)}${cadence} · ${entries.length} CA`;
}


export class TelegramBot {
  readonly configured: boolean;

  constructor(
    private readonly token: string,
    private readonly alertChatId: string,
    private readonly fetcher: Fetcher = fetch,
    private readonly renderAvatar?: (symbol?: string, ca?: string, chain?: Chain, source?: 'A' | 'B') => Promise<Uint8Array>,
    private readonly threads: TelegramThreadIds = {},
    private readonly periodicChatId: string = '',
  ) {
    this.configured = token.trim().length > 0 && alertChatId.trim().length > 0;
  }

  async send(
    alert: TelegramAlert,
    progress: {
      sentParts?: number;
      deliveryMode?: 'photo' | 'text';
      onPartSent?: (sentParts: number, deliveryMode: 'photo' | 'text') => void;
    } = {},
  ): Promise<void> {
    if (!this.configured) throw new TelegramSendError('Telegram is not configured');
    const text = formatTelegramAlert(alert);
    const sentParts = progress.sentParts ?? 0;
    const deliveryMode = progress.deliveryMode ?? 'photo';
    const paragraphs = text.split('\n\n');
    const photoCaption = visibleTextLength(text) <= 1024 ? text : paragraphs[0]!;
    const remainder = visibleTextLength(text) <= 1024 ? '' : paragraphs.slice(1).join('\n\n');
    const photoParts = remainder === '' ? [] : splitTelegramText(remainder);
    const textParts = splitTelegramText(text);
    const maximumParts = deliveryMode === 'photo' ? photoParts.length + 1 : textParts.length;
    if (!Number.isSafeInteger(sentParts) || sentParts < 0 || sentParts > maximumParts) {
      throw new TelegramSendError('Telegram alert delivery progress is invalid');
    }

    if (deliveryMode === 'photo' && sentParts === 0) {
      let avatar: Uint8Array;
      try {
        avatar = this.renderAvatar
          ? await this.renderAvatar(alert.symbol, alert.ca, alert.chain, alert.source)
          : await renderCaIdenticon(alert.chain, alert.ca);
      } catch {
        avatar = await renderCaIdenticon(alert.chain, alert.ca);
      }
      if (avatar.byteLength === 0) throw new TelegramSendError('Token avatar is empty');
      try {
        await this.request('sendPhoto', {
          chat_id: this.alertChatId,
          photo: 'attach://photo',
          caption: photoCaption,
          parse_mode: 'HTML',
        }, { fieldName: 'photo', bytes: avatar, filename: 'token-avatar.jpg', mediaType: 'image/jpeg' }, this.threads.alerts);
        progress.onPartSent?.(1, 'photo');
      } catch (error) {
        if (!(error instanceof TelegramSendError) || !error.mediaRejected) throw error;
        return this.sendTextParts(textParts, 0, progress.onPartSent);
      }
      return this.sendTextParts(photoParts, 1, progress.onPartSent, 'photo');
    }

    if (deliveryMode === 'photo') {
      return this.sendTextParts(photoParts, sentParts, progress.onPartSent, 'photo');
    }
    return this.sendTextParts(textParts, sentParts, progress.onPartSent, 'text');
  }

  private async sendTextParts(
    parts: readonly string[],
    sentParts: number,
    onPartSent?: (sentParts: number, deliveryMode: 'photo' | 'text') => void,
    deliveryMode: 'photo' | 'text' = 'text',
  ): Promise<void> {
    for (let index = Math.max(0, sentParts - (deliveryMode === 'photo' ? 1 : 0)); index < parts.length; index += 1) {
      const completedParts = deliveryMode === 'photo' ? index + 2 : index + 1;
      const partText = parts.length === 1 ? parts[index]! : `Part ${completedParts}/${parts.length + (deliveryMode === 'photo' ? 1 : 0)}\n${parts[index]!}`;
      await this.request('sendMessage', {
        chat_id: this.alertChatId,
        text: partText,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }, undefined, this.threads.alerts);
      onPartSent?.(completedParts, deliveryMode);
    }
  }

  async sendPeriodicScanReport(
    entries: readonly PeriodicScanReportEntry[],
    slot: string,
    intervalHours: readonly number[] = [],
  ): Promise<void> {
    if (entries.length === 0) return;
    if (!this.token.trim() || !this.periodicChatId.trim()) {
      throw new TelegramSendError('Periodic scan Telegram channel is not configured');
    }
    const slotLabel = periodicScanSlotLabel(slot);
    const prepared = await Promise.all(entries.map(async ({ source, signal }, index) => {
      let bytes: Uint8Array;
      try {
        bytes = this.renderAvatar
          ? await this.renderAvatar(signal.symbol, signal.ca, signal.chain, source)
          : await renderCaIdenticon(signal.chain, signal.ca);
      } catch {
        bytes = await renderCaIdenticon(signal.chain, signal.ca);
      }
      if (bytes.byteLength === 0) throw new TelegramSendError('Periodic scan token avatar is empty');
      const upload = {
        fieldName: `periodic_avatar_${index}`,
        bytes,
        filename: `periodic-scan-avatar-${index}.jpg`,
        mediaType: 'image/jpeg',
      };
      const caption = `Dashboard ${source} · ${slotLabel}\n\n${formatPeriodicScanAlert(signal)}`;
      if (visibleTextLength(caption) > 1024) {
        throw new TelegramSendError('Periodic scan item exceeds Telegram photo caption limit');
      }
      return { upload, caption };
    }));

    const header = formatPeriodicScanHeader(entries, slot, intervalHours);
    let headerSent = false;
    try {
      await this.request('sendMessage', {
        chat_id: this.periodicChatId,
        text: header,
        disable_web_page_preview: true,
      });
      headerSent = true;

      for (let offset = 0; offset < prepared.length; offset += 10) {
        const group = prepared.slice(offset, offset + 10);
        if (group.length === 1) {
          const item = group[0]!;
          await this.request('sendPhoto', {
            chat_id: this.periodicChatId,
            photo: `attach://${item.upload.fieldName}`,
            caption: item.caption,
            parse_mode: 'HTML',
          }, item.upload);
          continue;
        }
        const media = group.map((item) => ({
          type: 'photo',
          media: `attach://${item.upload.fieldName}`,
          caption: item.caption,
          parse_mode: 'HTML',
        }));
        const uploads = group.map((item) => item.upload);
        await this.request('sendMediaGroup', {
          chat_id: this.periodicChatId,
          media: JSON.stringify(media),
        }, uploads, undefined, group.length);
      }
    } catch (error) {
      if (!headerSent) throw error;
      throw new TelegramSendError(
        error instanceof Error ? error.message : 'Periodic scan report delivery failed',
        undefined,
        false,
        'unknown',
        false,
      );
    }
  }

  private async request(
    method: 'sendPhoto' | 'sendMessage' | 'sendMediaGroup',
    body: Record<string, unknown>,
    upload?: TelegramUpload | readonly TelegramUpload[],
    threadId?: number,
    expectedResultCount?: number,
  ): Promise<void> {
    const payload = threadId === undefined ? body : { ...body, message_thread_id: threadId };
    const uploads: readonly TelegramUpload[] = upload === undefined
      ? []
      : Array.isArray(upload) ? upload : [upload as TelegramUpload];
    let response: Response;
    try {
      const init: RequestInit = upload !== undefined
        ? { method: 'POST', body: multipartBody(payload, uploads), signal: AbortSignal.timeout(10_000) }
        : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
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
      result?: unknown;
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
    if (expectedResultCount !== undefined &&
        (!Array.isArray(result.result) || result.result.length !== expectedResultCount)) {
      throw new TelegramSendError('Telegram returned an invalid media-group receipt', undefined, false, 'unknown');
    }
  }
}

interface TelegramUpload {
  fieldName: string;
  bytes: Uint8Array;
  filename: string;
  mediaType: string;
}

function multipartBody(body: Record<string, unknown>, uploads: readonly TelegramUpload[]): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(body)) {
    if (uploads.some((upload) => upload.fieldName === key && value === `attach://${key}`)) continue;
    form.append(key, String(value));
  }
  for (const upload of uploads) {
    form.append(upload.fieldName, new Blob([upload.bytes], { type: upload.mediaType }), upload.filename);
  }
  return form;
}
