/** Legacy native-wallet migration assigned `a` to wallets with no clan. */
export function normalizeClan(value?: string | null): string {
  const clan = value?.trim() ?? '';
  return clan.toLowerCase() === 'a' ? '' : clan;
}
