export type VolumeSide = 'buy' | 'sell' | 'inflow';

/** Unknown members do not count as zero; return unknown until at least one reading exists. */
export function sumKnownPercentages(values: readonly (number | undefined)[]): number | undefined {
  let total = 0;
  let measured = false;
  for (const value of values) {
    if (value === undefined || !Number.isFinite(value)) continue;
    total += value;
    measured = true;
  }
  return measured ? total : undefined;
}

/** Buy totals are exact only when every contributing user's amount is known. */
export function sumKnownUsd(values: readonly (number | null)[]): number | null {
  let total = 0;
  for (const value of values) {
    if (value === null || !Number.isFinite(value)) return null;
    total += value;
  }
  return total;
}

/** Blank bounds disable filtering; unknown values cannot satisfy an active range. */
export function percentageInRange(value: number | undefined, min: string, max: string): boolean {
  const lower = min.trim() === '' ? undefined : Number(min);
  const upper = max.trim() === '' ? undefined : Number(max);
  if (lower === undefined && upper === undefined) return true;
  if (value === undefined || !Number.isFinite(value)) return false;
  if (lower !== undefined && (!Number.isFinite(lower) || lower < 0 || lower > 100 || value < lower)) return false;
  if (upper !== undefined && (!Number.isFinite(upper) || upper < 0 || upper > 100 || value > upper)) return false;
  return true;
}

interface FreshMetric { fresh?: number; rawFresh?: number }

/** Setup visibility must not hide a known reading from the explicit range filter. */
export function freshPercentageInRange(metric: FreshMetric, min: string, max: string): boolean {
  return percentageInRange(metric.rawFresh ?? metric.fresh, min, max);
}

/** Shared USD emphasis for BAL and tracked inflow; thresholds use unrounded USD. */
export function trackedUsdClass(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '';
  if (value > 20_000) return 'metric-bold metric-large metric-rainbow';
  if (value > 10_000) return 'metric-bold metric-large metric-yellow';
  return value > 5_000 ? 'metric-bold' : '';
}

/** Holder counts become bold only above the strict threshold. */
export function holderCountClass(value: number): string {
  return value > 1_000 ? 'metric-bold' : '';
}

/** Tracked holding emphasis uses the measured percentage, never display rounding. */
export function trackedHoldingClass(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '';
  if (value > 4.5) return 'metric-bold metric-rainbow';
  return value > 3 ? 'metric-bold' : '';
}

/** Low 24h volume is marked green and bold below the strict cutoff. */
export function volume24hClass(value: number): string {
  return value < 300_000 ? 'metric-bold text-pos' : '';
}

/** Compare raw USD, not rounded display text. Thresholds are strictly greater-than. */
export function volumeClass(value: number | undefined, side: VolumeSide): string {
  if (value === undefined || !Number.isFinite(value)) return '';
  if (side === 'sell') return `metric-sell${value > 5_000 ? ' metric-bold' : ''}${value > 10_000 ? ' metric-large' : ''}`;
  if (side === 'inflow') return trackedUsdClass(value);
  return `${value > 10_000 ? 'metric-bold metric-large' : ''}${value > 100_000 ? ' metric-rainbow' : value > 50_000 ? ' metric-yellow' : ''}`;
}

