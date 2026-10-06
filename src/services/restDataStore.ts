// REST-backed DataStore — used when VITE_API_BASE is set (docker-compose/dev-proxy
// deployments). Same contract as the localStorage implementation; components
// cannot tell them apart.

import type { Chain, FomoUser, Settings, SettingsPatch, Tier, TokenSignal, Wallet } from '../types';
import { byHandle, byName, type DataStore, type FomoImportRow, type ImportResult, type ImportRow } from './dataStore';

const BASE = `${import.meta.env.VITE_API_BASE}/api`;

// Auth bridge, set once by AuthProvider. Keeping it here (rather than importing the
// auth module) means the data layer never depends on React/Firebase.
let tokenGetter: () => Promise<string | null> = async () => null;
let onUnauthorized: () => void = () => {};

/** Wired by AuthProvider: supplies the bearer token and reacts to a 401. */
export function setAuthBridge(getToken: () => Promise<string | null>, handleUnauthorized: () => void): void {
  tokenGetter = getToken;
  onUnauthorized = handleUnauthorized;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await tokenGetter();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    // Merge, never replace: json() and the inline PATCH literal set Content-Type.
    headers: { ...(init?.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) {
    // No token / expired token: drop the session so the login wall returns.
    if (res.status === 401) {
      onUnauthorized();
      throw new Error('Session expired — please sign in again.');
    }
    // The server sends a bare {error:'forbidden'}; say something a viewer understands.
    if (res.status === 403) throw new Error('You do not have permission to do that.');
    const body = await res.text().catch(() => '');
    throw new Error(body || `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T; // server mirrors the frontend DTO shapes exactly
}

function json(method: 'POST' | 'PUT', body: unknown): { method: string; headers: Record<string, string>; body: string } {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export const restDataStore: DataStore = {
  async listWallets(): Promise<Wallet[]> {
    const wallets = await request<Wallet[]>('/wallets');
    return wallets.slice().sort(byName);
  },

  async addWallet(input: Omit<Wallet, 'id'>): Promise<Wallet> {
    return request<Wallet>('/wallets', json('POST', input));
  },

  async updateWallet(id: string, patch: Partial<Omit<Wallet, 'id'>>): Promise<Wallet> {
    return request<Wallet>(`/wallets/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  },

  async deleteWallet(id: string): Promise<void> {
    await request<void>(`/wallets/${id}`, { method: 'DELETE' });
  },

  async importWallets(rows: ImportRow[]): Promise<ImportResult> {
    return request<ImportResult>('/wallets/import', json('POST', { rows }));
  },

  async listFomoUsers(): Promise<FomoUser[]> {
    const users = await request<FomoUser[]>('/fomo-users');
    return users.slice().sort(byHandle);
  },

  async addFomoUser(input: Omit<FomoUser, 'id'>): Promise<FomoUser> {
    return request<FomoUser>('/fomo-users', json('POST', input));
  },

  async updateFomoUser(id: string, patch: Partial<Omit<FomoUser, 'id'>>): Promise<FomoUser> {
    return request<FomoUser>(`/fomo-users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  },

  async deleteFomoUser(id: string): Promise<void> {
    await request<void>(`/fomo-users/${id}`, { method: 'DELETE' });
  },

  async importFomoUsers(rows: FomoImportRow[]): Promise<ImportResult> {
    return request<ImportResult>('/fomo-users/import', json('POST', { rows }));
  },

  async listSignals(allFactors?: boolean): Promise<TokenSignal[]> {
    return request<TokenSignal[]>(`/signals?allFactors=${allFactors ? '1' : '0'}`);
  },

  async getSettings(): Promise<Settings> {
    return request<Settings>('/settings');
  },

  async updateSettings(patch: SettingsPatch): Promise<Settings> {
    return request<Settings>('/settings', json('PUT', patch));
  },

  async setTier(ca: string, chain: Chain, tier: Tier | null): Promise<void> {
    await request<void>('/tier', json('PUT', { ca, chain, tier }));
  },

  async setNote(ca: string, chain: Chain, note: string): Promise<void> {
    await request<{ ca: string; chain: Chain; note: string }>(
      `/tokens/${encodeURIComponent(chain)}/${encodeURIComponent(ca)}/note`,
      json('PUT', { note }),
    );
  },
};
