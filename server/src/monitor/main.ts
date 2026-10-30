import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createMonitorApp } from './app.js';
import { MonitorCollector } from './collector.js';
import { readMonitorConfig } from './config.js';
import { DiscordBot } from './discord.js';
import { MonitorNotifications } from './notifications.js';
import { MonitorAlerts } from './alerts.js';
import { TelegramBot } from './telegram.js';
import { renderCaIdenticon } from '../token-avatar.js';
import { MonitorStore } from './store.js';
import { PeriodicScanRunner } from './periodic-scan.js';
import type { Chain } from '../shared/chain.js';

async function fetchTokenAvatar(
  baseUrl: string,
  token: string,
  chain: Chain,
  ca: string,
): Promise<Uint8Array> {
  const url = new URL(`/api/token-avatar/${chain}/${encodeURIComponent(ca)}`, baseUrl);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(7_000),
  });
  const size = Number(response.headers.get('content-length') ?? 0);
  if (!response.ok || response.headers.get('content-type') !== 'image/jpeg' || size > 2 * 1024 * 1024) {
    throw new Error('token_avatar_unavailable');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > 2 * 1024 * 1024) throw new Error('token_avatar_invalid');
  return bytes;
}

function main(): void {
  const config = readMonitorConfig();
  const store = new MonitorStore(config.dbPath);
  const collector = new MonitorCollector(store, config);
  const notifications = new MonitorNotifications(store, new DiscordBot(config.discordBotToken, config.discordChannelId));
  const telegramBot = new TelegramBot(
    config.telegramBotToken,
    config.telegramChatId,
    fetch,
    async (symbol, ca, chain, source) => {
      if (ca !== undefined && chain !== undefined && source !== undefined) {
        return fetchTokenAvatar(source === 'B' && config.apiBUrl ? config.apiBUrl : config.apiAUrl, config.apiToken, chain, ca);
      }
      return renderCaIdenticon(chain ?? 'sol', ca ?? symbol ?? '-');
    },
    {
      ...(config.telegramAlertThreadId !== undefined ? { alerts: config.telegramAlertThreadId } : {}),
    },
    config.telegramPeriodicChatId,
  );
  const alerts = new MonitorAlerts(store, config, telegramBot);
  const periodicScan = new PeriodicScanRunner(store, config, telegramBot);
  const server = createServer(createMonitorApp({ config, store, notifications }));
  let collecting = false;

  const collect = async (): Promise<void> => {
    if (collecting) return;
    collecting = true;
    try {
      await collector.collect();
      await periodicScan.tick();
      await alerts.tick();
    } catch (error) {
      const kind = error instanceof Error ? error.name : 'Error';
      console.error(`[monitor] collection failed: ${kind}`);
    } finally {
      collecting = false;
    }
  };

  const timer = setInterval(() => void collect(), config.sampleIntervalMs);
  server.listen(config.port, '0.0.0.0', () => {
    console.info(`[monitor] listening on :${config.port}; sample interval ${config.sampleIntervalMs}ms`);
    void collect();
  });

  const shutdown = (signal: string): void => {
    console.info(`[monitor] ${signal} received; shutting down`);
    clearInterval(timer);
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
