import type { TokenSignal } from '../types';

type ActivitySignal = Pick<TokenSignal, 'fomoUsers' | 'trackedActivityAt'>;

function latestTrackedActivityAt(signal: ActivitySignal): number {
  let latest = signal.trackedActivityAt;
  for (const user of signal.fomoUsers) {
    if (user.lastTs > latest) latest = user.lastTs;
  }
  return latest;
}

export function compareTrackedActivity(a: ActivitySignal, b: ActivitySignal): number {
  return latestTrackedActivityAt(b) - latestTrackedActivityAt(a);
}
