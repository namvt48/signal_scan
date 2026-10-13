export interface ChartPointPosition {
  x: number;
  y: number;
  series: 'primary' | 'secondary';
}

export const CHART_POINT_HIT_RADIUS = 9;

export function findNearestChartPointIndex(
  points: readonly ChartPointPosition[],
  x: number,
  y: number,
  maxDistance = CHART_POINT_HIT_RADIUS,
): number | null {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(maxDistance) || maxDistance < 0) {
    return null;
  }

  let nearestIndex: number | null = null;
  let nearestDistance = maxDistance * maxDistance;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const dx = point.x - x;
    const dy = point.y - y;
    const distance = dx * dx + dy * dy;
    if (distance > nearestDistance) continue;
    if (distance === nearestDistance && nearestIndex !== null) {
      const current = points[nearestIndex]!;
      if (current.series === 'secondary' || point.series !== 'secondary') continue;
    }
    nearestDistance = distance;
    nearestIndex = index;
  }
  return nearestIndex;
}
