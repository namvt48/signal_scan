import type { TokenSignal } from '../types';

type FomoSortSignal = Pick<TokenSignal, 'fomoUsers'>;

function latestFomoUserActivityAt(signal: FomoSortSignal): number {
  let latest = 0;
  for (const user of signal.fomoUsers) {
    if (user.lastTs > latest) latest = user.lastTs;
  }
  return latest;
}

export function compareFomoUserActivity(a: FomoSortSignal, b: FomoSortSignal): number {
  return latestFomoUserActivityAt(b) - latestFomoUserActivityAt(a);
}
