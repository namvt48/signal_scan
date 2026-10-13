import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createMonitorApp } from './app.js';
import { MonitorCollector } from './collector.js';
import { readMonitorConfig } from './config.js';
import { DiscordBot } from './discord.js';
import { MonitorNotifications } from './notifications.js';
import { MonitorAlerts } from './alerts.js';
import { TelegramBot } from './telegram.js';
import { DashboardAvatarRenderer } from './avatar.js';
import { MonitorStore } from './store.js';

function main(): void {
  const config = readMonitorConfig();
  const store = new MonitorStore(config.dbPath);
  const collector = new MonitorCollector(store, config);
  const notifications = new MonitorNotifications(store, new DiscordBot(config.discordBotToken, config.discordChannelId), config);
  const avatarRenderer = new DashboardAvatarRenderer(config.webAUrl, config.chromeAUrl);
  const alerts = new MonitorAlerts(
    store,
    config,
    new TelegramBot(config.telegramBotToken, config.telegramChatId, fetch, (symbol) => avatarRenderer.render(symbol)),
  );
  const server = createServer(createMonitorApp({ config, store, notifications }));
  let collecting = false;

  const collect = async (): Promise<void> => {
    if (collecting) return;
    collecting = true;
    try {
      await collector.collect();
      await notifications.tick();
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
