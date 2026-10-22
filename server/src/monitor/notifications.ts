import { DiscordBot } from './discord.js';
import { MonitorStore } from './store.js';
import type { MonitorSnapshot } from './types.js';

/**
 * Telegram carries CA alerts and the periodic shark report only. Health,
 * credit, provider-incident and daily usage reports are not delivered.
 * Keep status() so the dashboard can still show notification configuration.
 */
export class MonitorNotifications {
  constructor(
    private readonly store: MonitorStore,
    private readonly bot: DiscordBot,
  ) {}

  status(): MonitorSnapshot['notifications'] {
    const sentAt = this.store.lastNotificationDeliveryAt();
    return {
      discordConfigured: this.bot.configured,
      lastDeliveryAt: sentAt === null ? null : new Date(sentAt).toISOString(),
      lastError: null,
    };
  }
}
