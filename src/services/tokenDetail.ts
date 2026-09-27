// CA detail data — REST only (server assembles from its store + Nansen crawl).
// In localStorage mock mode these return null and the page shows a hint.

import type { BalanceChart, TokenDetail } from '../types';

// VITE_API_BASE semantics: '' = same-origin REST (prod), URL = REST, undefined =
// localStorage mock. Must match dataStore's switch (!== undefined), NOT truthiness.
const API_BASE = import.meta.env.VITE_API_BASE;
const BASE = `${API_BASE}/api`;

export async function getTokenDetail(chain: string, ca: string): Promise<TokenDetail | null> {
  if (API_BASE === undefined) return null;
  const res = await fetch(`${BASE}/tokens/${chain}/${ca}/detail`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await res.text().catch(() => `HTTP ${res.status}`));
  return (await res.json()) as TokenDetail;
}

export async function getBalanceChart(chain: string, ca: string, window: 'day' | 'week' | 'month' = 'day'): Promise<BalanceChart | null> {
  if (API_BASE === undefined) return null;
  const res = await fetch(`${BASE}/tokens/${chain}/${ca}/balance-chart?window=${window}`);
  if (!res.ok) throw new Error(await res.text().catch(() => `HTTP ${res.status}`));
  return (await res.json()) as BalanceChart;
}
