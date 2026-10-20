import type { TrackedWalletStat } from '../types';

export type WalletBalanceSort = 'asc' | 'desc' | null;

/** Sort one CA's wallets by current USD balance without mutating their source order. */
export function sortTrackedWalletsByBalance(
  wallets: readonly TrackedWalletStat[],
  direction: WalletBalanceSort,
): readonly TrackedWalletStat[] {
  if (direction === null) return wallets;
  return [...wallets].sort((left, right) => {
    const leftBalance = left.balUsd;
    const rightBalance = right.balUsd;
    if (leftBalance === undefined || !Number.isFinite(leftBalance)) {
      return rightBalance === undefined || !Number.isFinite(rightBalance) ? 0 : 1;
    }
    if (rightBalance === undefined || !Number.isFinite(rightBalance)) return -1;
    return direction === 'desc' ? rightBalance - leftBalance : leftBalance - rightBalance;
  });
}
