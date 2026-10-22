import { getSetting, setSetting } from './db.js';

export interface TelegramAlertRules {
  fwGrowthPct: number;
  minFwPct: number;
  t100GrowthPct: number;
  minMcK: number;
  maxMcK: number;
  /** Min holder count; -1 disables this bound. */
  minHolders: number;
  /** Max holder count; -1 disables this bound. */
  maxHolders: number;
  /** Thousands of USD; 0 disables Tracker Buying alerts. */
  trackerBuyingK: number;
}

export const DEFAULT_TELEGRAM_ALERT_RULES: TelegramAlertRules = {
  fwGrowthPct: 30,
  minFwPct: 15,
  t100GrowthPct: 30,
  minMcK: -1,
  maxMcK: -1,
  minHolders: -1,
  maxHolders: -1,
  trackerBuyingK: 0,
};

export const TELEGRAM_ALERT_RULE_KEYS: readonly (keyof TelegramAlertRules)[] = [
  'fwGrowthPct',
  'minFwPct',
  't100GrowthPct',
  'minMcK',
  'maxMcK',
  'minHolders',
  'maxHolders',
  'trackerBuyingK',
];
function validRuleValue(key: keyof TelegramAlertRules, value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (key === 'minMcK' || key === 'maxMcK') return value === -1 || value >= 0;
  if (key === 'minHolders' || key === 'maxHolders') return value === -1 || (Number.isSafeInteger(value) && value >= 0);
  if (key === 'minFwPct') return value >= 0 && value <= 100;
  return value >= 0;
}


function readRules(prefix: string, fallback: TelegramAlertRules = DEFAULT_TELEGRAM_ALERT_RULES): TelegramAlertRules {
  const rules = { ...fallback };
  for (const key of TELEGRAM_ALERT_RULE_KEYS) {
    const raw = getSetting(`${prefix}.${key}`);
    if (raw === undefined) continue;
    const value = Number(raw);
    if (validRuleValue(key, value)) rules[key] = value;
  }
  if (rules.minMcK >= 0 && rules.maxMcK >= 0 && rules.minMcK > rules.maxMcK) {
    rules.minMcK = -1;
    rules.maxMcK = -1;
  }
  if (rules.minHolders >= 0 && rules.maxHolders >= 0 && rules.minHolders > rules.maxHolders) {
    rules.minHolders = -1;
    rules.maxHolders = -1;
  }
  return rules;
}

function updateRules(
  prefix: string,
  patch: Record<string, unknown>,
  fallback: TelegramAlertRules = DEFAULT_TELEGRAM_ALERT_RULES,
): TelegramAlertRules | { error: string } {
  const next = readRules(prefix, fallback);
  for (const key of TELEGRAM_ALERT_RULE_KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    if (!validRuleValue(key, value)) {
      const rangeHint = key === 'minMcK' || key === 'maxMcK' || key === 'minHolders' || key === 'maxHolders' ? ' or -1' : '';
      const message = key === 'minFwPct'
        ? `${key} must be a finite number between 0 and 100`
        : key === 'minHolders' || key === 'maxHolders'
          ? `${key} must be an integer >= 0 or -1`
          : `${key} must be a finite number >= 0${rangeHint}`;
      return { error: message };
    }
    next[key] = value;
  }
  if (next.minMcK >= 0 && next.maxMcK >= 0 && next.minMcK > next.maxMcK) {
    return { error: 'minMcK must be less than or equal to maxMcK when both are enabled' };
  }
  if (next.minHolders >= 0 && next.maxHolders >= 0 && next.minHolders > next.maxHolders) {
    return { error: 'minHolders must be less than or equal to maxHolders when both are enabled' };
  }
  for (const key of TELEGRAM_ALERT_RULE_KEYS) {
    if (patch[key] !== undefined) setSetting(`${prefix}.${key}`, String(next[key]));
  }
  return readRules(prefix, fallback);
}

export function getTelegramAlertRules(): TelegramAlertRules {
  return readRules('telegramAlert');
}

export function updateTelegramAlertRules(patch: Record<string, unknown>): TelegramAlertRules | { error: string } {
  return updateRules('telegramAlert', patch);
}

export function getFomoTelegramAlertRules(): TelegramAlertRules {
  return readRules('fomoTelegramAlert', getTelegramAlertRules());
}

export function updateFomoTelegramAlertRules(patch: Record<string, unknown>): TelegramAlertRules | { error: string } {
  return updateRules('fomoTelegramAlert', patch, getTelegramAlertRules());
}
