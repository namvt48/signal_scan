export type VolumeSide = 'buy' | 'sell' | 'inflow';

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

/** Compare raw USD, not rounded display text. Thresholds are strictly greater-than. */
export function volumeClass(value: number | undefined, side: VolumeSide): string {
  if (value === undefined || !Number.isFinite(value)) return '';
  if (side === 'sell') return `metric-sell${value > 5_000 ? ' metric-bold' : ''}${value > 10_000 ? ' metric-large' : ''}`;
  if (side === 'inflow') return `${value > 10_000 ? 'metric-bold' : ''}${value > 200_000 ? ' metric-rainbow' : ''}`;
  return `${value > 10_000 ? 'metric-bold metric-large' : ''}${value > 100_000 ? ' metric-rainbow' : value > 50_000 ? ' metric-yellow' : ''}`;
}
