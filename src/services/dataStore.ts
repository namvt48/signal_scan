import { CHAINS, type Chain, type FomoUser, type NansenThresholds, type Settings, type SettingsPatch, type Tier, type TokenSignal, type Wallet } from '../types';
import { restDataStore } from './restDataStore';

// ---------------------------------------------------------------------------
// Public contract. Components import `dataStore` only; swap this file's
// implementation for fetch() calls later without touching any component.
// ---------------------------------------------------------------------------

export interface ImportRow {
  address: string;
  name: string;
  tags: string[];
  chain: Chain;
  source: string;
  /** Display-only clan label (user 2026-09-24). */
  clan?: string;
}

export interface ImportResult {
  added: number;
  skipped: { row: number; reason: string }[];
}

/** One row of the CSV import preview: either valid data or a skip reason. */
export interface ParsedImportRow {
  row: number;
  data?: ImportRow;
  reason?: string;
}

/** A FOMO watch-list row as produced by `parseFomoUsersCsv` / consumed by `importFomoUsers`. */
export type FomoImportRow = Omit<FomoUser, 'id'>;

/** One row of the FOMO CSV import preview: either valid data or a skip reason. */
export interface ParsedFomoImportRow {
  row: number;
  data?: FomoImportRow;
  reason?: string;
}

export interface DataStore {
  listWallets(): Promise<Wallet[]>;
  addWallet(input: Omit<Wallet, 'id'>): Promise<Wallet>;
  updateWallet(id: string, patch: Partial<Omit<Wallet, 'id'>>): Promise<Wallet>;
  deleteWallet(id: string): Promise<void>;
  importWallets(rows: ImportRow[]): Promise<ImportResult>;
  listFomoUsers(): Promise<FomoUser[]>;
  addFomoUser(input: Omit<FomoUser, 'id'>): Promise<FomoUser>;
  updateFomoUser(id: string, patch: Partial<Omit<FomoUser, 'id'>>): Promise<FomoUser>;
  deleteFomoUser(id: string): Promise<void>;
  importFomoUsers(rows: FomoImportRow[]): Promise<ImportResult>;
  listSignals(allFactors?: boolean): Promise<TokenSignal[]>;
  getSettings(): Promise<Settings>;
  updateSettings(patch: SettingsPatch): Promise<Settings>;
  setTier(ca: string, chain: Chain, tier: Tier | null): Promise<void>;
}

// ---------------------------------------------------------------------------
// localStorage implementation
// ---------------------------------------------------------------------------

const WALLET_KEY = 'signal_scan:wallets';
const FOMO_USER_KEY = 'signal_scan:fomo_users';
const SETTINGS_KEY = 'signal_scan:settings';
const TIER_KEY = 'signal_scan:tiers';

/** Stored tier overrides, keyed `${chain}:${ca}`. */
function readTiers(): Record<string, Tier> {
  try {
    const raw = localStorage.getItem(TIER_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, Tier>;
  } catch {
    return {};
  }
}

function writeTiers(map: Record<string, Tier>): void {
  try {
    localStorage.setItem(TIER_KEY, JSON.stringify(map));
  } catch {
    // storage blocked or full: keep working in-memory for this session
  }
}

const DEFAULT_THRESHOLDS: NansenThresholds = { freshMinPct: 10, t100MinMultiple: 1.2, lfMin: 1000000, lfMax: 300000000, minUsd: 50, minMc: 0, maxMc: 0 };

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Debug flags live under the same settings key as the numeric thresholds. */
function readDebug(): { allFactors: boolean } {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw === null) return { allFactors: false };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return { allFactors: parsed.allFactors === true };
  } catch {
    return { allFactors: false };
  }
}

function readThresholds(): NansenThresholds {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw === null) return { ...DEFAULT_THRESHOLDS };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      freshMinPct: num(parsed.freshMinPct, DEFAULT_THRESHOLDS.freshMinPct),
      t100MinMultiple: num(parsed.t100MinMultiple, DEFAULT_THRESHOLDS.t100MinMultiple),
      lfMin: num(parsed.lfMin, DEFAULT_THRESHOLDS.lfMin),
      lfMax: num(parsed.lfMax, DEFAULT_THRESHOLDS.lfMax),
      minUsd: num(parsed.minUsd, DEFAULT_THRESHOLDS.minUsd),
      minMc: num(parsed.minMc, DEFAULT_THRESHOLDS.minMc),
      maxMc: num(parsed.maxMc, DEFAULT_THRESHOLDS.maxMc),
    };
  } catch {
    return { ...DEFAULT_THRESHOLDS };
  }
}

function persist<T>(key: string, value: T[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage blocked or full: keep working in-memory for this session
  }
}

function read<T>(key: string, fallback: T[]): T[] {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) {
      persist(key, fallback); // seed only when storage is empty
      return fallback;
    }
    const parsed = JSON.parse(raw) as T[];
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

const uid = (): string => crypto.randomUUID();

function isChain(v: unknown): v is Chain {
  return typeof v === 'string' && (CHAINS as readonly string[]).includes(v);
}

export function byName(a: Wallet, b: Wallet): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true });
}

export function byHandle(a: FomoUser, b: FomoUser): number {
  return a.handle.localeCompare(b.handle, undefined, { numeric: true });
}

// --- CSV parsing (import) ---------------------------------------------------

const CSV_HEADER = ['address', 'name', 'tags', 'chain', 'source'];
const CSV_CLAN_COL = 'clan';

/** Minimal RFC-4180-ish CSV parser: quoted fields, escaped quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      pushField();
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      pushRow();
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) pushRow();
  return rows;
}

/**
 * Parse + validate a wallets CSV. Header is address,name,tags,chain,source with
 * an OPTIONAL trailing `clan` column (legacy 5-column exports still parse); tags
 * inside one cell separated by ";". Throws on a bad header.
 */
export function parseWalletsCsv(text: string): ParsedImportRow[] {
  const rows = parseCsv(text);
  const header = rows[0]?.map((c) => c.trim().toLowerCase()) ?? [];
  const extra = header.length > CSV_HEADER.length;
  if (
    header.slice(0, CSV_HEADER.length).join(',') !== CSV_HEADER.join(',') ||
    (extra && header[CSV_HEADER.length] !== CSV_CLAN_COL)
  ) {
    throw new Error(`CSV header must be: ${CSV_HEADER.join(',')} (optional trailing ,${CSV_CLAN_COL})`);
  }
  return rows.slice(1).map((cells, i) => {
    const rowNo = i + 2; // 1-based file line, header is line 1
    const address = (cells[0] ?? '').trim();
    const chainRaw = (cells[3] ?? '').trim().toLowerCase();
    if (!address) return { row: rowNo, reason: 'address is empty' };
    if (!isChain(chainRaw)) {
      return { row: rowNo, reason: `invalid chain "${chainRaw}" (expected one of ${CHAINS.join(', ')})` };
    }
    return {
      row: rowNo,
      data: {
        address,
        name: (cells[1] ?? '').trim(),
        tags: (cells[2] ?? '')
          .split(';')
          .map((t) => t.trim())
          .filter(Boolean),
        chain: chainRaw,
        source: (cells[4] ?? '').trim(),
        clan: (cells[5] ?? '').trim(),
      },
    };
  });
}

/**
 * Parse + validate a FOMO users CSV. Header-driven (column order varies between
 * the pre-pulled fomo/ exports): requires a `handle` column, maps
 * `displayName`/`name` -> name, `clanName`/`clan` -> clan, and treats `userId`,
 * `walletSolana`, `walletEvm` as optional. Strips a leading UTF-8 BOM.
 * Throws when the `handle` column is missing.
 */
export function parseFomoUsersCsv(text: string): ParsedFomoImportRow[] {
  const rows = parseCsv(text.replace(/^\uFEFF/, ''));
  const header = rows[0]?.map((c) => c.trim().toLowerCase()) ?? [];
  const col = (...names: string[]): number => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i !== -1) return i;
    }
    return -1;
  };
  const handleIdx = col('handle');
  if (handleIdx === -1) throw new Error('CSV header must contain a "handle" column');
  const nameIdx = col('name', 'displayname');
  const clanIdx = col('clan', 'clanname');
  const userIdIdx = col('userid');
  const solIdx = col('walletsolana');
  const evmIdx = col('walletevm');
  const cell = (cells: string[], idx: number): string => (idx === -1 ? '' : (cells[idx] ?? '').trim());
  return rows.slice(1).map((cells, i) => {
    const rowNo = i + 2; // 1-based file line, header is line 1
    if (cells.length <= handleIdx) return { row: rowNo, reason: 'malformed row (too few columns)' };
    const handle = cell(cells, handleIdx);
    if (!handle) return { row: rowNo, reason: 'handle is empty' };
    const clan = cell(cells, clanIdx);
    const userId = cell(cells, userIdIdx);
    const walletSolana = cell(cells, solIdx);
    const walletEvm = cell(cells, evmIdx);
    return {
      row: rowNo,
      data: {
        handle,
        name: cell(cells, nameIdx),
        ...(clan ? { clan } : {}),
        ...(userId ? { userId } : {}),
        ...(walletSolana ? { walletSolana } : {}),
        ...(walletEvm ? { walletEvm } : {}),
      },
    };
  });
}

// --- Seed data (used only when localStorage is empty) -----------------------

const SEED_WALLETS: Wallet[] = [
  { id: 'w-01', address: '7QmK9xR2vT5pLwZn3cBd8FhJ4sGa6EyUuVoNbMxTkAqP', name: 'CT01', tags: ['sniper', 'fresh-wallet', 'Unicon'], chain: 'sol', source: 'gmgn' },
  { id: 'w-02', address: '3HdF8nK2mV5qTxPb9cZr4WfJ7sLa6EyUuQoNbMxYkAc', name: 'CT02', tags: ['kol'], chain: 'sol', source: 'nansen' },
  { id: 'w-03', address: 'Fg9xK2mR7qT4vBn8cLd3Ws6Za1Py5Ue9HjA', name: 'CT03', tags: ['whale'], chain: 'sol', source: 'birdeye' },
  { id: 'w-04', address: 'Gk2vN7mT4rJxP5cBwZ9aF3dHs8gYqQeUuRtMiNoVbXy', name: 'CT04', tags: ['smart-money'], chain: 'sol', source: 'gmgn' },
  { id: 'w-05', address: 'Bq7Xk2mR9vT4pLwZn5cJd8FhM3sGa6EyUuVoNbRxTkAq', name: 'CT05', tags: ['whale', 'kol'], chain: 'sol', source: 'birdeye' },
  { id: 'w-06', address: '8nQd4FxR7vJt2Kb9mL5sWc3Yp6Za1Ee4Hg7Du', name: 'CT06', tags: ['smart-money'], chain: 'sol', source: 'manual' },
  { id: 'w-07', address: 'Dn4FxR7vJt2Kb9mL5sWc3Yp6ZaQeHg7DuXkTmVrPB', name: 'CT07', tags: ['sniper', 'smart-money'], chain: 'sol', source: 'gmgn' },
  { id: 'w-08', address: 'Eu9HjAFg5xK2mR7qT4vBn8cLd3Ws6ZaPvTkQrMxNb', name: 'CT08', tags: ['fresh-wallet'], chain: 'sol', source: 'nansen' },
];

// Sorted at seed level by Nansen score desc, then tracked inflow desc.
const SEED_TS = Date.parse('2026-09-23T00:00:00Z');
const SEED_RAW: Omit<TokenSignal, 'trackedActivityAt' | 'fomoUsers'>[] = [
  {
    id: 'sig-1',
    ca: '0x9aF2cB47dE81a3F6b5C04d9E17f2A83b6C5d1E7c2',
    chain: 'sol',
    trackedWallets: [
      { name: 'CT01', tags: ['sniper', 'fresh-wallet', 'Unicon'], inflow: 52000, buys: 4, sells: 1, balUsd: 18500, lastTs: SEED_TS - 1_800_000 },
      { name: 'CT02', inflow: 6000, buys: 1, sells: 0, balUsd: 2800, lastTs: SEED_TS - 3_600_000 },
      { name: 'CT05', inflow: 21000, buys: 2, sells: 0, balUsd: 9200, lastTs: SEED_TS - 7_200_000 },
      { name: 'CT07', inflow: 11000, buys: 3, sells: 2, balUsd: 6400, lastTs: SEED_TS - 19_800_000 },
    ],
    nansen: { score: 3, pass: { fresh: true, t100: true, lf: true }, fresh: 18.4, t100: { pct: 8.7, multiple: 1.5 }, lf: 2200000 },
    holders: 12400,
    trackedInflow: 84000,
    trackedHolding: 3.82,
    volume24h: 182000,
    marketCap: 2450000,
    tier: 'S',
  },
  {
    id: 'sig-2',
    ca: '7KpQm2VxRn9dJfLsB4tGcA8wEuYhZ3NkXvT6DgMyHqU',
    chain: 'sol',
    trackedWallets: [
      { name: 'CT03', inflow: 98000, buys: 5, sells: 1, balUsd: 41000, lastTs: SEED_TS - 10_800_000 },
      { name: 'CT06', inflow: 47000, buys: 3, sells: 0, lastTs: SEED_TS - 21_600_000 },
      { name: 'CT08', inflow: 11000, buys: 2, sells: 1, balUsd: 3300, lastTs: SEED_TS - 43_200_000 },
    ],
    nansen: { score: 3, pass: { fresh: true, t100: true, lf: true }, fresh: 21.2, t100: { pct: 12.4, multiple: 1.8 }, lf: 1800000 },
    holders: 8900,
    trackedInflow: 156000,
    trackedHolding: 5.17,
    volume24h: 640000,
    marketCap: 8900000,
    tier: 'S',
  },
  {
    id: 'sig-3',
    ca: '0x3E7b9C1d5A8f2B6e4C0d7F9a1B3c5E7d9F0a2C4e3',
    chain: 'sol',
    trackedWallets: [
      { name: 'CT01', tags: ['sniper', 'fresh-wallet', 'Unicon'], inflow: 30000, buys: 2, sells: 1, balUsd: 12000, lastTs: SEED_TS - 1_500_000 },
      { name: 'CT02', inflow: 67000, buys: 4, sells: 2, balUsd: 26000, lastTs: SEED_TS - 32_400_000 },
    ],
    nansen: { score: 2, pass: { fresh: true, t100: true, lf: false }, fresh: 12.1, t100: { pct: 6.2, multiple: 1.2 } },
    holders: 6200,
    trackedInflow: 97000,
    trackedHolding: 2.44,
    volume24h: 95000,
    marketCap: 1180000,
    tier: 'A',
  },
  {
    id: 'sig-4',
    ca: '0x51Bd8e3F7a2C9d4E6b1f8A0c3D5e7F9b1A2c4D6e7',
    chain: 'sol',
    trackedWallets: [
      { name: 'CT04', inflow: -8000, buys: 1, sells: 2, balUsd: 1500, lastTs: SEED_TS - 16_200_000 },
      { name: 'CT07', inflow: 49000, buys: 3, sells: 0, balUsd: 21000, lastTs: SEED_TS - 37_800_000 },
    ],
    nansen: { score: 2, pass: { fresh: true, t100: false, lf: true }, fresh: 15.6, lf: 2400000 },
    holders: 18300,
    trackedInflow: 41000,
    trackedHolding: 1.08,
    volume24h: 210000,
    marketCap: 4300000,
    tier: 'A',
  },
  {
    id: 'sig-5',
    ca: '0xC7e2A9f4D1b6c8E3a5F0d7B9c2E4f6A8d1B3C5e7b',
    chain: 'sol',
    trackedWallets: [
      { name: 'CT02', inflow: 9000, buys: 2, sells: 1, balUsd: 4100, lastTs: SEED_TS - 27_000_000 },
      { name: 'CT05', inflow: -14000, buys: 1, sells: 3, lastTs: SEED_TS - 54_000_000 },
    ],
    nansen: { score: 2, pass: { fresh: false, t100: true, lf: true }, t100: { pct: 5.4, multiple: 1.3 }, lf: 2500000 },
    holders: 4100,
    trackedInflow: 23000,
    trackedHolding: 0.92,
    volume24h: 388000,
    marketCap: 15600000,
    tier: 'B',
  },
  {
    id: 'sig-6',
    ca: '5RnWk9pQd3FjXhT8vBm2Ly7Gc4ZuAe6Ns1KxDcHgTqV',
    chain: 'sol',
    trackedWallets: [
      { name: 'CT06', inflow: 44000, buys: 3, sells: 1, balUsd: 17000, lastTs: SEED_TS - 43_200_000 },
      { name: 'CT08', inflow: 22000, buys: 2, sells: 0, balUsd: 7800, lastTs: SEED_TS - 64_800_000 },
    ],
    nansen: { score: 1, pass: { fresh: false, t100: false, lf: true }, lf: 2800000 },
    holders: 2800,
    trackedInflow: 66000,
    trackedHolding: 4.61,
    volume24h: 46000,
    marketCap: 640000,
    tier: 'B',
  },
  {
    id: 'sig-7',
    ca: '0xD4f1B8a6C3e9d2F7b5A0c8E1f4D6b9C2a7E3F5d8a',
    chain: 'sol',
      trackedWallets: [{ name: 'CT01', tags: ['sniper', 'fresh-wallet', 'Unicon'], inflow: 12000, buys: 1, sells: 0, balUsd: 5200, lastTs: SEED_TS - 57_600_000 }],
    nansen: { score: 1, pass: { fresh: true, t100: false, lf: false }, fresh: 10.4 },
    holders: 9500,
    trackedInflow: 12000,
    trackedHolding: 0.37,
    volume24h: 512000,
    marketCap: 27800000,
    tier: 'B',
  },
  {
    id: 'sig-8',
    ca: '0x8C3e7F1a9B5d2C4e6F8a0D2b4E6c8A0f2B4D6e8cF',
    chain: 'sol',
    trackedWallets: [{ name: 'CT03', inflow: 8000, buys: 2, sells: 0, lastTs: SEED_TS - 75_600_000 }],
    nansen: { score: 1, pass: { fresh: true, t100: false, lf: false }, fresh: 11.3, t100: { pct: 2.3, multiple: 1.0 } },
    holders: 1900,
    trackedInflow: 8000,
    trackedHolding: 0.58,
    volume24h: 74000,
    tier: 'B',
  },
];

// Mock mirror of the server payload: descending activity timestamps keep the seed order
// above identical under the default newest-activity-first sort.
const SEED_SIGNALS: TokenSignal[] = SEED_RAW.map((s, i) => ({ ...s, fomoUsers: [], trackedActivityAt: SEED_TS - i * 600_000 }));

// --- Implementation ----------------------------------------------------------

export const localDataStore: DataStore = {
  async listWallets(): Promise<Wallet[]> {
    return read<Wallet>(WALLET_KEY, SEED_WALLETS)
      .slice()
      .sort(byName);
  },

  async addWallet(input: Omit<Wallet, 'id'>): Promise<Wallet> {
    const wallet: Wallet = { id: uid(), ...input };
    persist(WALLET_KEY, [...read<Wallet>(WALLET_KEY, SEED_WALLETS), wallet]);
    return wallet;
  },

  async updateWallet(id: string, patch: Partial<Omit<Wallet, 'id'>>): Promise<Wallet> {
    const list = read<Wallet>(WALLET_KEY, SEED_WALLETS);
    const idx = list.findIndex((w) => w.id === id);
    if (idx === -1) throw new Error(`Wallet ${id} not found`);
    const updated: Wallet = { ...list[idx], ...patch };
    const next = list.slice();
    next[idx] = updated;
    persist(WALLET_KEY, next);
    return updated;
  },

  async deleteWallet(id: string): Promise<void> {
    persist(
      WALLET_KEY,
      read<Wallet>(WALLET_KEY, SEED_WALLETS).filter((w) => w.id !== id),
    );
  },

  async importWallets(rows: ImportRow[]): Promise<ImportResult> {
    const list = read<Wallet>(WALLET_KEY, SEED_WALLETS);
    const added: Wallet[] = rows.map((r) => ({ id: uid(), ...r }));
    persist(WALLET_KEY, [...list, ...added]);
    return { added: added.length, skipped: [] };
  },

  async listFomoUsers(): Promise<FomoUser[]> {
    return read<FomoUser>(FOMO_USER_KEY, []).slice().sort(byHandle);
  },

  async addFomoUser(input: Omit<FomoUser, 'id'>): Promise<FomoUser> {
    const user: FomoUser = { id: uid(), ...input };
    persist(FOMO_USER_KEY, [...read<FomoUser>(FOMO_USER_KEY, []), user]);
    return user;
  },

  async updateFomoUser(id: string, patch: Partial<Omit<FomoUser, 'id'>>): Promise<FomoUser> {
    const list = read<FomoUser>(FOMO_USER_KEY, []);
    const idx = list.findIndex((u) => u.id === id);
    if (idx === -1) throw new Error(`FomoUser ${id} not found`);
    const updated: FomoUser = { ...list[idx], ...patch };
    const next = list.slice();
    next[idx] = updated;
    persist(FOMO_USER_KEY, next);
    return updated;
  },

  async deleteFomoUser(id: string): Promise<void> {
    persist(
      FOMO_USER_KEY,
      read<FomoUser>(FOMO_USER_KEY, []).filter((u) => u.id !== id),
    );
  },

  async importFomoUsers(rows: FomoImportRow[]): Promise<ImportResult> {
    const list = read<FomoUser>(FOMO_USER_KEY, []);
    const added: FomoUser[] = rows.map((r) => ({ id: uid(), ...r }));
    persist(FOMO_USER_KEY, [...list, ...added]);
    return { added: added.length, skipped: [] };
  },

  async listSignals(): Promise<TokenSignal[]> {
    const tiers = readTiers();
    return SEED_SIGNALS.map((s) => ({ ...s, tier: tiers[`${s.chain}:${s.ca}`] ?? s.tier ?? null }));
  },

  async getSettings(): Promise<Settings> {
    return { values: readThresholds(), defaults: { ...DEFAULT_THRESHOLDS }, debug: readDebug() };
  },

  async updateSettings(patch: SettingsPatch): Promise<Settings> {
    const { allFactors, ...thresholds } = patch;
    const values: NansenThresholds = { ...readThresholds(), ...thresholds };
    const debug = { allFactors: allFactors ?? readDebug().allFactors };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...values, ...debug }));
    } catch {
      // storage blocked or full: keep working in-memory for this session
    }
    return { values, defaults: { ...DEFAULT_THRESHOLDS }, debug };
  },

  async setTier(ca: string, chain: Chain, tier: Tier | null): Promise<void> {
    const map = readTiers();
    const key = `${chain}:${ca}`;
    if (tier === null) delete map[key];
    else map[key] = tier;
    writeTiers(map);
  },
};

// VITE_API_BASE semantics: undefined (not configured) → localStorage mock;
// '' (same-origin, nginx/vite proxy) or a URL → REST store. Docker prod build
// bakes VITE_API_BASE="" so the deployed dashboard reads the API via nginx.
export const dataStore: DataStore =
  import.meta.env.VITE_API_BASE !== undefined ? restDataStore : localDataStore;
