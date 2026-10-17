import type { TelegramAlert } from './telegram.js';

export function isSuppressedTelegramAlert(
  alert: Pick<TelegramAlert, 'source' | 'chain'>,
  alertId?: string,
): boolean {
  return alert.chain === 'sol' && (alert.source === 'B' || alertId?.startsWith('B:') === true);
}
