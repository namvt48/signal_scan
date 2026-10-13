export interface HistoryPoint {
  t: number;
  value: number;
  peakBalance?: number;
  troughBalance?: number;
}

export interface AggregatedHistoryPoint extends HistoryPoint {
  sampleCount: number;
}

export const MAX_CHART_POINTS = 32;
export const MAX_MARKET_CAP_OVERLAY_POINTS = 12;

interface Bucket {
  timeTotal: number;
  valueTotal: number;
  sampleCount: number;
}

/** Keep a readable time-series while preserving its endpoints and all source samples. */
export function aggregateHistoryPoints(
  points: readonly HistoryPoint[],
  maxPoints = MAX_CHART_POINTS,
): AggregatedHistoryPoint[] {
  if (!Number.isInteger(maxPoints) || maxPoints < 3) {
    throw new RangeError('maxPoints must be an integer of at least 3');
  }
  const pointLimit = maxPoints;
  const ordered = points
    .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.value))
    .sort((left, right) => left.t - right.t);
  if (ordered.length <= pointLimit) {
    return ordered.map((point) => ({ ...point, sampleCount: 1 }));
  }
  const first = ordered[0]!;
  const last = ordered[ordered.length - 1]!;

  const bucketCount = pointLimit - 2;
  const timeSpan = last.t - first.t;
  const buckets = new Map<number, Bucket>();

  for (let index = 1; index < ordered.length - 1; index += 1) {
    const point = ordered[index]!;
    const bucketIndex = timeSpan > 0
      ? Math.min(bucketCount - 1, Math.floor(((point.t - first.t) / timeSpan) * bucketCount))
      : 0;
    const bucket = buckets.get(bucketIndex);
    if (bucket) {
      bucket.timeTotal += point.t;
      bucket.valueTotal += point.value;
      bucket.sampleCount += 1;
    } else {
      buckets.set(bucketIndex, { timeTotal: point.t, valueTotal: point.value, sampleCount: 1 });
    }
  }

  return [
    { ...first, sampleCount: 1 },
    ...Array.from(buckets.values(), ({ timeTotal, valueTotal, sampleCount }) => ({
      t: Math.round(timeTotal / sampleCount),
      value: valueTotal / sampleCount,
      sampleCount,
    })),
    { ...last, sampleCount: 1 },
  ];
}
