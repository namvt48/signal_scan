// REST-backed DataStore — used when VITE_API_BASE is set (docker-compose/dev-proxy
// deployments). Same contract as the localStorage implementation; components
// cannot tell them apart.

import type { Settings, SettingsPatch, TokenSignal, Wallet } from '../types';
import { byName, type DataStore, type ImportResult, type ImportRow } from './dataStore';

const BASE = `${import.meta.env.VITE_API_BASE}/api`;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) {
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

  async listSignals(allFactors?: boolean): Promise<TokenSignal[]> {
    return request<TokenSignal[]>(`/signals?allFactors=${allFactors ? '1' : '0'}`);
  },

  async getSettings(): Promise<Settings> {
    return request<Settings>('/settings');
  },

  async updateSettings(patch: SettingsPatch): Promise<Settings> {
    return request<Settings>('/settings', json('PUT', patch));
  },
};
