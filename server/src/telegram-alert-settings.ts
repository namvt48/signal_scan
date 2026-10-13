import { getSetting, setSetting } from './db.js';

export interface TelegramAlertRules {
  fwGrowthPct: number;
  minFwPct: number;
  t100GrowthPct: number;
  minMcK: number;
  maxMcK: number;
  /** Thousands of USD; 0 disables Tracker Buying alerts. */
  trackerBuyingK: number;
}

export const DEFAULT_TELEGRAM_ALERT_RULES: TelegramAlertRules = {
  fwGrowthPct: 30,
  minFwPct: 15,
  t100GrowthPct: 30,
  minMcK: -1,
  maxMcK: -1,
  trackerBuyingK: 0,
};

const RULE_KEYS: readonly (keyof TelegramAlertRules)[] = [
  'fwGrowthPct',
  'minFwPct',
  't100GrowthPct',
  'minMcK',
  'maxMcK',
  'trackerBuyingK',
];
function validRuleValue(key: keyof TelegramAlertRules, value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (key === 'minMcK' || key === 'maxMcK') return value === -1 || value >= 0;
  if (key === 'minFwPct') return value >= 0 && value <= 100;
  return value >= 0;
}


export function getTelegramAlertRules(): TelegramAlertRules {
  const rules = { ...DEFAULT_TELEGRAM_ALERT_RULES };
  for (const key of RULE_KEYS) {
    const raw = getSetting(`telegramAlert.${key}`);
    if (raw === undefined) continue;
    const value = Number(raw);
    if (validRuleValue(key, value)) rules[key] = value;
  }
  if (rules.minMcK >= 0 && rules.maxMcK >= 0 && rules.minMcK > rules.maxMcK) {
    rules.minMcK = -1;
    rules.maxMcK = -1;
  }
  return rules;
}

export function updateTelegramAlertRules(patch: Record<string, unknown>): TelegramAlertRules | { error: string } {
  const next = getTelegramAlertRules();
  for (const key of RULE_KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    if (!validRuleValue(key, value)) {
      const rangeHint = key === 'minMcK' || key === 'maxMcK' ? ' or -1' : '';
      const message = key === 'minFwPct'
        ? `${key} must be a finite number between 0 and 100`
        : `${key} must be a finite number >= 0${rangeHint}`;
      return { error: message };
    }
    next[key] = value;
  }
  if (next.minMcK >= 0 && next.maxMcK >= 0 && next.minMcK > next.maxMcK) {
    return { error: 'minMcK must be less than or equal to maxMcK when both are enabled' };
  }
  for (const key of RULE_KEYS) {
    if (patch[key] !== undefined) setSetting(`telegramAlert.${key}`, String(next[key]));
  }
  return getTelegramAlertRules();
}
