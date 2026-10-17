export interface MonitorConfig {
  port: number;
  apiToken: string;
  dbPath: string;
  sampleIntervalMs: number;
  apiAUrl: string;
  apiBUrl: string;
  gatewayUrl: string;
  webAUrl: string;
  webBUrl: string;
  chromeAUrl: string;
  chromeBUrl: string;
  gatewayChromeUrl: string;
  publicSiteUrl: string;
  fomoUsagePath: string;
  fomoHeartbeatPath: string;
  walletHeartbeatPath: string;
  fomoStaleMs: number;
  fomoWarnPercent: number;
  nansenWarnRemaining: number;
  dailyReportHour: number;
  timezone: string;
  discordBotToken: string;
  discordChannelId: string;
  telegramBotToken: string;
  telegramChatId: string;
  telegramPeriodicChatId: string;
  telegramAlertThreadId?: number;
}

function integer(raw: string | undefined, fallback: number, name: string, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in ${min}..${max}`);
  }
  return value;
}

function nonNegative(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a finite number >= 0`);
  return value;
}

function percentage(raw: string | undefined, fallback: number, name: string): number {
  const value = nonNegative(raw, fallback, name);
  if (value > 100) throw new Error(`${name} must be <= 100`);
  return value;
}

function required(raw: string | undefined, name: string): string {
  if (raw === undefined || raw.trim() === '') throw new Error(`${name} is required`);
  return raw;
}

function optionalThreadId(raw: string | undefined, name: string): number | undefined {
  return raw === undefined || raw.trim() === ''
    ? undefined
    : integer(raw, 0, name, 1, Number.MAX_SAFE_INTEGER);
}

export function readMonitorConfig(env: NodeJS.ProcessEnv = process.env): MonitorConfig {
  const timezone = env.MONITOR_TIMEZONE?.trim() || 'Asia/Ho_Chi_Minh';
  new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
  const telegramChatId = env.TELEGRAM_CHAT_ID?.trim() || '';
  const telegramPeriodicChatId = env.TELEGRAM_PERIODIC_CHAT_ID?.trim() || '';
  const telegramAlertThreadId = optionalThreadId(env.TELEGRAM_ALERT_THREAD_ID, 'TELEGRAM_ALERT_THREAD_ID');
  if (telegramAlertThreadId !== undefined && telegramChatId === '') {
    throw new Error('TELEGRAM_CHAT_ID is required when Telegram alert topics are configured');
  }
  if (telegramPeriodicChatId !== '' && telegramPeriodicChatId.toLowerCase() === telegramChatId.toLowerCase()) {
    throw new Error('TELEGRAM_PERIODIC_CHAT_ID must differ from TELEGRAM_CHAT_ID');
  }

  return {
    apiToken: required(env.MONITOR_API_TOKEN, 'MONITOR_API_TOKEN'),
    port: integer(env.MONITOR_PORT, 8126, 'MONITOR_PORT', 1, 65535),
    dbPath: env.MONITOR_DB_PATH?.trim() || '/data/monitor.sqlite3',
    sampleIntervalMs: integer(env.MONITOR_SAMPLE_INTERVAL_MS, 60_000, 'MONITOR_SAMPLE_INTERVAL_MS', 5_000, 3_600_000),
    apiAUrl: env.MONITOR_API_A_URL?.trim() || 'http://signal-scan-api-a:3001',
    apiBUrl: env.MONITOR_API_B_URL?.trim() || 'http://signal-scan-api-b:3001',
    gatewayUrl: env.MONITOR_GATEWAY_URL?.trim() || 'http://gateway:8130',
    webAUrl: env.MONITOR_WEB_A_URL?.trim() || 'http://signal-scan-web-a/',
    webBUrl: env.MONITOR_WEB_B_URL?.trim() || 'http://signal-scan-web-b/',
    chromeAUrl: env.MONITOR_CHROME_A_URL?.trim() || 'http://signal-scan-chrome-a:3000/pressure',
    chromeBUrl: env.MONITOR_CHROME_B_URL?.trim() || 'http://signal-scan-chrome-b:3000/pressure',
    gatewayChromeUrl: env.MONITOR_GATEWAY_CHROME_URL?.trim() || 'http://signal-scan-gateway-chrome:3000/pressure',
    publicSiteUrl: env.MONITOR_PUBLIC_SITE_URL?.trim() || 'https://signal-scan.duckdns.org:8443/healthz',
    fomoUsagePath: env.MONITOR_FOMO_USAGE_PATH?.trim() || '/run/host-monitor/fomo-usage.json',
    fomoHeartbeatPath: env.MONITOR_FOMO_HEARTBEAT_PATH?.trim() || '/run/watcher-heartbeats/fomo',
    walletHeartbeatPath: env.MONITOR_WALLET_HEARTBEAT_PATH?.trim() || '/run/watcher-heartbeats/wallet',
    fomoStaleMs: integer(env.MONITOR_FOMO_STALE_MS, 45 * 60_000, 'MONITOR_FOMO_STALE_MS', 60_000, 86_400_000),
    fomoWarnPercent: percentage(env.MONITOR_FOMO_WARN_PERCENT, 10, 'MONITOR_FOMO_WARN_PERCENT'),
    nansenWarnRemaining: nonNegative(env.MONITOR_NANSEN_WARN_REMAINING, 2, 'MONITOR_NANSEN_WARN_REMAINING'),
    dailyReportHour: integer(env.MONITOR_DAILY_REPORT_HOUR, 8, 'MONITOR_DAILY_REPORT_HOUR', 0, 23),
    timezone,
    discordBotToken: env.DISCORD_BOT_TOKEN?.trim() || '',
    discordChannelId: env.DISCORD_CHANNEL_ID?.trim() || '',
    telegramBotToken: env.TELEGRAM_BOT_TOKEN?.trim() || '',
    telegramChatId,
    telegramPeriodicChatId,
    ...(telegramAlertThreadId !== undefined ? { telegramAlertThreadId } : {}),
  };
}
