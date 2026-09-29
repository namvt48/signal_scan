// REST API — mirrors the frontend DataStore contract (src/services/dataStore.ts)
// exactly: response JSON field names/types are what the components already
// consume. Validation happens at this boundary (Metis: chain ∈ CHAINS,
// address non-empty → 400; duplicate → 409).

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { CHAINS, canonicalCa, type Chain } from './shared/chain.js';
import { TIERS, isTier, type Tier } from './shared/tier.js';
import { type AuthDeps, createAuthMiddleware } from './auth.js';
import { config } from './config.js';
import { limiters } from './ratelimit/index.js';
import {
  deleteFomoUser,
  deleteTier,
  deleteTrackedCa,
  deleteWallet,
  findFomoUserByHandle,
  findTrackedCa,
  findWalletByAddress,
  getWallet,
  importFomoUsers,
  importWallets,
  insertFomoUser,
  insertTrackedCa,
  insertWallet,
  isChain,
  listFomoUsers,
  listTrackedCas,
  listWallets,
  maxTokenFetchedAt,
  setTier,
  setTrackedCaEntryUsd,
  updateFomoUser,
  updateWallet,
  type FomoUserInput,
  type FomoUserRow,
  type ImportCandidate,
  type TrackedCaRow,
  type WalletRow,
} from './db.js';
// Token detail page DISABLED — its 2 endpoints below are commented out too.
// import { buildTokenDetail } from './detail.js';
// import { balanceSeries } from './crawl.js';
import { poolStatsOrNull } from './crawl.js';
import { log } from './log.js';
import { assembleSignals } from './signals.js';
import {
  getDebugAllFactors,
  getThresholds,
  isThresholdValueFor,
  setDebugAllFactors,
  settingsResponse,
  thresholdValueError,
  updateThresholds,
  THRESHOLD_KEYS,
  type NansenThresholds,
} from './settings.js';
import { insertTrades } from './ingest.js';
import { kickCAs, kickWalletRow } from './poller.js';

interface WalletJson {
  id: string;
  address: string;
  name: string;
  tags: string[];
  chain: Chain;
  source: string;
  clan: string;
}

function toWallet(row: WalletRow): WalletJson {
  return {
    id: row.id,
    address: row.address,
    name: row.name,
    tags: JSON.parse(row.tags) as string[], // written by us via JSON.stringify(string[])
    chain: row.chain,
    source: row.source,
    clan: row.clan ?? '',
  };
}

function toTrackedCa(row: TrackedCaRow) {
  return {
    id: row.id,
    address: row.address,
    chain: row.chain,
    note: row.note,
    addedAt: row.added_at,
    status: row.status,
  };
}

/** FOMO user JSON DTO — the wire shape src/types.ts `FomoUser` / restDataStore
 *  expect (camelCase). DB rows are snake_case; nullable columns are OMITTED (the
 *  FE types them optional), never leaked as snake_case or null. */
interface FomoUserJson {
  id: string;
  handle: string;
  name: string;
  clan?: string;
  userId?: string;
  walletSolana?: string;
  walletEvm?: string;
  source: string;
}

function toFomoUser(row: FomoUserRow): FomoUserJson {
  return {
    id: row.id,
    handle: row.handle,
    name: row.name,
    ...(row.clan !== null ? { clan: row.clan } : {}),
    ...(row.user_id !== null ? { userId: row.user_id } : {}),
    ...(row.wallet_solana !== null ? { walletSolana: row.wallet_solana } : {}),
    ...(row.wallet_evm !== null ? { walletEvm: row.wallet_evm } : {}),
    source: row.source,
  };
}

interface WalletBody {
  address: string;
  name: string;
  tags: string[];
  chain: Chain;
  source: string;
  clan: string;
}

type ParseResult<T> = T | { error: string };

function isParseError<T extends object>(r: ParseResult<T>): r is { error: string } {
  return 'error' in r && typeof r.error === 'string';
}

function strField(b: Record<string, unknown>, key: string): string {
  return typeof b[key] === 'string' ? (b[key] as string).trim() : '';
}

function tagsField(b: Record<string, unknown>): string[] {
  return Array.isArray(b.tags) ? b.tags.filter((t): t is string => typeof t === 'string') : [];
}

function parseWalletBody(body: unknown): ParseResult<WalletBody> {
  if (typeof body !== 'object' || body === null) return { error: 'body must be a JSON object' };
  const b = body as Record<string, unknown>;
  const address = strField(b, 'address');
  if (!address) return { error: 'address is required' };
  if (!isChain(b.chain)) return { error: `invalid chain (expected one of ${CHAINS.join(', ')})` };
  return { address, name: strField(b, 'name'), tags: tagsField(b), chain: b.chain, source: strField(b, 'source'), clan: strField(b, 'clan') };
}

function parseWalletPatch(body: unknown): ParseResult<Partial<WalletBody>> {
  if (typeof body !== 'object' || body === null) return { error: 'body must be a JSON object' };
  const b = body as Record<string, unknown>;
  const patch: Partial<WalletBody> = {};
  if (b.address !== undefined) {
    const address = strField(b, 'address');
    if (!address) return { error: 'address must be a non-empty string' };
    patch.address = address;
  }
  if (b.chain !== undefined) {
    if (!isChain(b.chain)) return { error: `invalid chain (expected one of ${CHAINS.join(', ')})` };
    patch.chain = b.chain;
  }
  if (b.name !== undefined) patch.name = strField(b, 'name');
  if (b.tags !== undefined) {
    if (!Array.isArray(b.tags)) return { error: 'tags must be an array of strings' };
    patch.tags = tagsField(b);
  }
  if (b.source !== undefined) patch.source = strField(b, 'source');
  if (b.clan !== undefined) patch.clan = strField(b, 'clan');
  return patch;
}

/** POST /api/fomo-users body → db input. Accepts the camelCase DTO keys
 *  restDataStore sends; `handle` required + trimmed (empty → 400), the rest are
 *  optional strings. Unknown extra fields are ignored — never persisted. */
function parseFomoUserBody(body: unknown): ParseResult<FomoUserInput> {
  if (typeof body !== 'object' || body === null) return { error: 'body must be a JSON object' };
  const b = body as Record<string, unknown>;
  const handle = strField(b, 'handle');
  if (!handle) return { error: 'handle is required' };
  const opt = (key: string): string | null => strField(b, key) || null;
  const input: FomoUserInput = {
    handle,
    name: strField(b, 'name'),
    user_id: opt('userId'),
    clan: opt('clan'),
    wallet_solana: opt('walletSolana'),
    wallet_evm: opt('walletEvm'),
  };
  const source = opt('source');
  if (source) input.source = source;
  return input;
}

/** PATCH /api/fomo-users/:id — only provided camelCase keys are written
 *  (mirrors parseWalletPatch); '' clears a nullable field. */
function parseFomoUserPatch(body: unknown): ParseResult<Partial<FomoUserInput>> {
  if (typeof body !== 'object' || body === null) return { error: 'body must be a JSON object' };
  const b = body as Record<string, unknown>;
  const patch: Partial<FomoUserInput> = {};
  if (b.handle !== undefined) {
    const handle = strField(b, 'handle');
    if (!handle) return { error: 'handle must be a non-empty string' };
    patch.handle = handle;
  }
  if (b.name !== undefined) patch.name = strField(b, 'name');
  if (b.userId !== undefined) patch.user_id = strField(b, 'userId') || null;
  if (b.clan !== undefined) patch.clan = strField(b, 'clan') || null;
  if (b.walletSolana !== undefined) patch.wallet_solana = strField(b, 'walletSolana') || null;
  if (b.walletEvm !== undefined) patch.wallet_evm = strField(b, 'walletEvm') || null;
  if (b.source !== undefined) patch.source = strField(b, 'source');
  return patch;
}

function parseTrackedCaBody(
  body: unknown,
): ParseResult<{ address: string; chain: Chain; note: string; entryUsd?: number }> {
  if (typeof body !== 'object' || body === null) return { error: 'body must be a JSON object' };
  const b = body as Record<string, unknown>;
  const address = strField(b, 'address');
  if (!address) return { error: 'address is required' };
  if (!isChain(b.chain)) return { error: `invalid chain (expected one of ${CHAINS.join(', ')})` };
  const usd: unknown = b.usd;
  if (usd !== undefined && (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0)) {
    return { error: 'usd must be a finite number >= 0' };
  }
  return {
    address,
    chain: b.chain,
    note: strField(b, 'note'),
    ...(typeof usd === 'number' ? { entryUsd: usd } : {}),
  };
}

function parseTierBody(body: unknown): ParseResult<{ ca: string; chain: Chain; tier: Tier | null }> {
  if (typeof body !== 'object' || body === null) return { error: 'body must be a JSON object' };
  const b = body as Record<string, unknown>;
  const ca = strField(b, 'ca');
  if (!ca) return { error: 'ca is required' };
  if (!isChain(b.chain)) return { error: `invalid chain (expected one of ${CHAINS.join(', ')})` };
  const raw = b.tier;
  if (raw === undefined || raw === null || raw === '') return { ca, chain: b.chain, tier: null };
  if (!isTier(raw)) return { error: `tier must be one of ${TIERS.join(', ')} or null` };
  return { ca, chain: b.chain, tier: raw };
}

/** One event a wallet-watch daemon detected (POST /api/wallet-watch/trades). */
interface WatchTrade {
  wallet: string;
  ca: string;
  tx: string;
  ts: number;
  side: 'buy' | 'sell' | 'transfer';
  chain: Chain;
  amountUsd?: number;
  price?: number;
}

/**
 * wallet+ca+chain+tx+side identify the event (UNIQUE(wallet_id, ca, chain, tx,
 * side)). `side` defaults to 'buy' so the pre-existing BUY-only daemon keeps
 * working; `chain` defaults to 'sol' so the DEPLOYED Sol daemon (which predates
 * the field) keeps working during rollout — an unknown chain is a 400. A
 * `transfer` is NOT a trade row — it only triggers the balance refresh below.
 * amountUsd/price are optional: a buy the daemon could not price still proves
 * the wallet bought, and `Tracked by` never reads them.
 */
function parseWatchTradeBody(body: unknown): ParseResult<WatchTrade> {
  if (typeof body !== 'object' || body === null) return { error: 'body must be a JSON object' };
  const b = body as Record<string, unknown>;
  const wallet = strField(b, 'wallet');
  const ca = strField(b, 'ca');
  const tx = strField(b, 'tx');
  if (!wallet) return { error: 'wallet is required' };
  if (!ca) return { error: 'ca is required' };
  if (!tx) return { error: 'tx is required' };
  const ts: unknown = b.ts;
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) {
    return { error: 'ts must be a finite epoch-ms number > 0' };
  }
  const rawSide = strField(b, 'side') || 'buy';
  if (rawSide !== 'buy' && rawSide !== 'sell' && rawSide !== 'transfer') {
    return { error: "side must be 'buy', 'sell' or 'transfer'" };
  }
  let chain: Chain = 'sol';
  if (b.chain !== undefined) {
    if (!isChain(b.chain)) return { error: `invalid chain (expected one of ${CHAINS.join(', ')})` };
    chain = b.chain;
  }
  const trade: WatchTrade = { wallet, ca, tx, ts, side: rawSide, chain };
  for (const key of ['amountUsd', 'price'] as const) {
    const v: unknown = b[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      return { error: `${key} must be a finite number >= 0` };
    }
    trade[key] = v;
  }
  return trade;
}

/** PUT /api/settings body — any subset of the numeric threshold keys AND/OR the boolean `allFactors`. */
interface SettingsPatch {
  thresholds: Partial<NansenThresholds>;
  allFactors?: boolean;
}

/**
 * Keeps only known keys (unknown ignored, EXCEPT the retired pre-2026-09-17
 * threshold names below — those 400 so stale clients fail loud), validates each
 * via isThresholdValueFor; allFactors must be a real boolean.
 */
const RETIRED_THRESHOLD_KEYS: readonly string[] = ['t100MinPct', 'lfMaxPct'];

function parseSettingsBody(body: unknown): ParseResult<SettingsPatch> {
  if (typeof body !== 'object' || body === null) return { error: 'body must be a JSON object' };
  const b = body as Record<string, unknown>;
  for (const old of RETIRED_THRESHOLD_KEYS) {
    if (b[old] !== undefined) return { error: `${old} was retired — use t100MinMultiple / lfMin + lfMax` };
  }
  const thresholds: Partial<NansenThresholds> = {};
  for (const key of THRESHOLD_KEYS) {
    const v: unknown = b[key];
    if (v === undefined) continue;
    if (!isThresholdValueFor(key, v)) return { error: thresholdValueError(key) };
    thresholds[key] = v;
  }
  const af: unknown = b.allFactors;
  if (af !== undefined && typeof af !== 'boolean') return { error: 'allFactors must be a boolean' };
  const patch: SettingsPatch = { thresholds };
  if (typeof af === 'boolean') patch.allFactors = af;
  return patch;
}

function parseImportRows(body: unknown): ImportCandidate[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const rows = (body as Record<string, unknown>).rows;
  if (!Array.isArray(rows)) return null;
  // Keep every entry (even junk → empty address) so `row` indices reference the
  // caller's input array, matching the frontend ImportResult contract.
  return rows.map((r) => {
    if (typeof r !== 'object' || r === null) {
      return { address: '', name: '', tags: [], chain: '', source: '', clan: '' };
    }
    const b = r as Record<string, unknown>;
    return {
      address: strField(b, 'address'),
      name: strField(b, 'name'),
      tags: tagsField(b),
      chain: strField(b, 'chain'),
      source: strField(b, 'source'),
      clan: strField(b, 'clan'),
    };
  });
}

/** POST /api/fomo-users/import body — the same { rows: [...] } envelope as
 *  parseImportRows, rows being camelCase FomoImportRow (parseFomoUsersCsv output).
 *  Junk entries are kept as empty-handle so `row` indices reference the caller's
 *  array. The CSV parser emits no source → absent source stamps 'csv' (DDL
 *  fomo_users.source); a caller-supplied source wins. */
function parseFomoImportRows(body: unknown): FomoUserInput[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const rows = (body as Record<string, unknown>).rows;
  if (!Array.isArray(rows)) return null;
  return rows.map((r) => {
    if (typeof r !== 'object' || r === null) return { handle: '', source: 'csv' };
    const b = r as Record<string, unknown>;
    return {
      handle: strField(b, 'handle'),
      name: strField(b, 'name'),
      user_id: strField(b, 'userId') || null,
      clan: strField(b, 'clan') || null,
      wallet_solana: strField(b, 'walletSolana') || null,
      wallet_evm: strField(b, 'walletEvm') || null,
      source: strField(b, 'source') || 'csv',
    };
  });
}

export function createApp(providerName: string, authDeps?: AuthDeps): Express {
  const app = express();
  app.use(express.json());

  app.use((req, res, next) => {
    const t0 = Date.now();
    res.on('finish', () => {
      const fields = { method: req.method, path: req.path, status: res.statusCode, dur: Date.now() - t0 };
      if (req.path === '/api/health') log.debug('[api]', fields);
      else log.info('[api]', fields);
    });
    next();
  });

  // AUTH CONTRACT v1 (src/auth.ts): everything below except /api/health sits
  // behind the Bearer gate; the policy table is deny-by-default.
  app.use(createAuthMiddleware(authDeps));

  app.get('/api/health', (_req, res) => {
    res.json({
      mode: config.mode,
      provider: providerName,
      lastTokenFetchAt: maxTokenFetchedAt(),
      healthy: true,
      // Door table (null until the crawl pool is built): state=retired on every door is
      // the 2026-09-23 blackout signature — no T100/LF factors are landing.
      doors: poolStatsOrNull(),
      ratelimit: limiters.snapshot(),
    });
  });

  // The FE's session probe: who the Bearer token authenticated as. The service
  // token has no email identity → { email: null, role: 'service' }.
  app.get('/api/me', (req, res) => {
    const principal = req.principal;
    if (!principal) {
      // Unreachable: /api/me is gated. Defensive — never answer unauthenticated.
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    res.json({ email: principal.email, role: principal.role });
  });

  // allFactors is PER REQUEST (session-scoped per browser tab): the query param wins,
  // the persisted server setting is only the default when the param is absent.
  app.get('/api/signals', (req, res) => {
    const af = req.query.allFactors;
    res.json(assembleSignals(Date.now(), af === undefined ? getDebugAllFactors() : af === '1'));
  });

  // Nansen factor thresholds + the allFactors debug flag — runtime-adjustable gates behind the X/3 score above.
  app.get('/api/settings', (_req, res) => {
    res.json(settingsResponse(getThresholds()));
  });

  app.put('/api/settings', (req, res) => {
    const parsed = parseSettingsBody(req.body);
    if (isParseError(parsed)) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const result = updateThresholds(parsed.thresholds);
    if ('error' in result) {
      res.status(400).json({ error: result.error });
      return;
    }
    // Set the debug flag after validation (no partial write on 400), before the response reads it back.
    if (parsed.allFactors !== undefined) setDebugAllFactors(parsed.allFactors);
    res.json(settingsResponse(result));
  });

  app.get('/api/wallets', (_req, res) => {
    res.json(listWallets().map(toWallet));
  });

  app.post('/api/wallets', (req, res) => {
    const parsed = parseWalletBody(req.body);
    if (isParseError(parsed)) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    if (findWalletByAddress(parsed.address, parsed.chain)) {
      res.status(409).json({ error: 'wallet address already exists' });
      return;
    }
    const inserted = insertWallet(parsed);
    kickWalletRow(inserted);
    res.status(201).json(toWallet(inserted));
  });

  app.patch('/api/wallets/:id', (req, res) => {
    const cur = getWallet(req.params.id);
    if (!cur) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const parsed = parseWalletPatch(req.body);
    if (isParseError(parsed)) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const current = toWallet(cur);
    const next: WalletBody = { ...current, ...parsed };
    // Identity key is (address, chain): a change to EITHER half can collide.
    if (
      (next.address !== current.address || next.chain !== current.chain) &&
      findWalletByAddress(next.address, next.chain)
    ) {
      res.status(409).json({ error: 'wallet address already exists' });
      return;
    }
    const updated = updateWallet(cur.id, next);
    if (!updated) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    kickWalletRow(updated);
    res.json(toWallet(updated));
  });

  app.delete('/api/wallets/:id', (req, res) => {
    // FK cascade cleans wallet_token_state + wallet_trades.
    deleteWallet(req.params.id);
    res.status(204).end();
  });

  app.post('/api/wallets/import', (req, res) => {
    const rows = parseImportRows(req.body);
    if (!rows) {
      res.status(400).json({ error: 'body must be { rows: [...] }' });
      return;
    }
    res.json(importWallets(rows));
  });

  // FOMO watch-list: a FOMO user is NOT a wallet — own table, own accessors,
  // never resolved through findWalletByAddress.
  app.get('/api/fomo-users', (_req, res) => {
    res.json(listFomoUsers().map(toFomoUser));
  });

  app.post('/api/fomo-users', (req, res) => {
    const parsed = parseFomoUserBody(req.body);
    if (isParseError(parsed)) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    if (findFomoUserByHandle(parsed.handle)) {
      res.status(409).json({ error: 'fomo user handle already exists' });
      return;
    }
    res.status(201).json(toFomoUser(insertFomoUser(parsed)));
  });

  app.patch('/api/fomo-users/:id', (req, res) => {
    const parsed = parseFomoUserPatch(req.body);
    if (isParseError(parsed)) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    // Identity key is `handle`: a change can collide with another row.
    if (parsed.handle !== undefined) {
      const other = findFomoUserByHandle(parsed.handle);
      if (other && other.id !== req.params.id) {
        res.status(409).json({ error: 'fomo user handle already exists' });
        return;
      }
    }
    const updated = updateFomoUser(req.params.id, parsed);
    if (!updated) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(toFomoUser(updated));
  });

  app.delete('/api/fomo-users/:id', (req, res) => {
    // FK cascade cleans fomo_trades.
    deleteFomoUser(req.params.id);
    res.status(204).end();
  });

  app.post('/api/fomo-users/import', (req, res) => {
    const rows = parseFomoImportRows(req.body);
    if (!rows) {
      res.status(400).json({ error: 'body must be { rows: [...] }' });
      return;
    }
    res.json(importFomoUsers(rows));
  });

  app.get('/api/tracked-cas', (_req, res) => {
    res.json(listTrackedCas().map(toTrackedCa));
  });

  app.post('/api/tracked-cas', (req, res) => {
    const parsed = parseTrackedCaBody(req.body);
    if (isParseError(parsed)) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const existing = findTrackedCa(parsed.address, parsed.chain);
    if (existing) {
      // Repost carrying a price backfills an entry_usd unknown at insert time.
      // No kickCAs — the CA is already tracked and polls on its own cadence.
      if (existing.entry_usd == null && parsed.entryUsd != null) {
        const updated = setTrackedCaEntryUsd(parsed.address, parsed.chain, parsed.entryUsd);
        res.status(200).json(toTrackedCa(updated ?? existing));
        return;
      }
      res.status(409).json({ error: 'CA already tracked on this chain' });
      return;
    }
    // Entry-size gate (moved from scripts/wallet_watch.py, which now posts every
    // detected buy): a KNOWN entryUsd below minUsd is refused — 200, not 4xx, so
    // the daemon's 2xx-is-ok client stays quiet. Absent usd fails open. Read per
    // request so a settings change takes effect without restart.
    if (parsed.entryUsd !== undefined && parsed.entryUsd < getThresholds().minUsd) {
      res.status(200).json({ skipped: 'below-min-usd' });
      return;
    }
    const row = insertTrackedCa(parsed);
    kickCAs([{ address: row.address, chain: row.chain }]);
    res.status(201).json(toTrackedCa(row));
  });

  app.delete('/api/tracked-cas/:id', (req, res) => {
    deleteTrackedCa(req.params.id);
    res.status(204).end();
  });

  // User-set tier for a tracked CA (dashboard Tier column). Absent/null tier clears it.
  app.put('/api/tier', (req, res) => {
    const parsed = parseTierBody(req.body);
    if (isParseError(parsed)) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    if (!findTrackedCa(parsed.ca, parsed.chain)) {
      res.status(404).json({ error: 'CA not tracked' });
      return;
    }
    if (parsed.tier === null) {
      deleteTier(parsed.ca, parsed.chain);
    } else {
      setTier(parsed.ca, parsed.chain, parsed.tier);
    }
    res.json({ ca: canonicalCa(parsed.ca, parsed.chain), chain: parsed.chain, tier: parsed.tier });
  });

  // wallet_watch (Solana RPC) detected event. BUY rows are what `Tracked by`
  // counts (user 2026-09-21), separate from /api/tracked-cas which only queues
  // the CA. Reposting is a no-op: UNIQUE(wallet_id, ca, tx, side).
  app.post('/api/wallet-watch/trades', (req, res) => {
    const parsed = parseWatchTradeBody(req.body);
    if (isParseError(parsed)) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const wallet = findWalletByAddress(parsed.wallet, parsed.chain);
    if (!wallet) {
      // Inserting would violate the wallets FK. The daemon only watches tracked
      // wallets, so this means the wallet was deleted between watch and post.
      res.status(404).json({ error: 'wallet not tracked' });
      return;
    }
    // A `transfer` is not a trade row — it only means "this wallet's balance moved".
    const inserted =
      parsed.side === 'transfer'
        ? 0
        : insertTrades(
            wallet.id,
            [
              {
                tx: parsed.tx,
                ts: parsed.ts,
                side: parsed.side,
                ca: parsed.ca,
                chain: wallet.chain,
                amountUsd: parsed.amountUsd ?? 0,
                price: parsed.price ?? 0,
              },
            ],
            'watch',
          );
    // Re-read the wallet's balance now (user 2026-09-23) rather than waiting up to
    // POLL_WALLETS_MS for walletSweep, so a sell/transfer moves trackedHolding at once.
    // One query, for the pair this event landed on.
    kickWalletRow(wallet, parsed.ca);
    res.json({ inserted });
  });

  /* Token detail page DISABLED (2026-09-16) — no /detail, no /balance-chart.
   * Both endpoints only ever served TokenDetailPage, which is no longer rendered.
   * /balance-chart was the heavy one: it drives the Nansen browser-sidecar crawl.
   * Re-enable by uncommenting this block + the 2 imports at the top of the file.
  // CA detail: 5 Nansen distribution metrics + top-100 table (from local store).
  app.get('/api/tokens/:chain/:ca/detail', (req, res) => {
    const { chain, ca } = req.params;
    if (!(CHAINS as readonly string[]).includes(chain)) {
      res.status(400).json({ error: `invalid chain "${chain}"` });
      return;
    }
    const detail = buildTokenDetail(ca, chain as Chain);
    if (!detail) {
      res.status(404).json({ error: 'token not tracked (waiting for first poll)' });
      return;
    }
    res.json(detail);
  });

  // Balance chart (the yellow Nansen series): Nansen crawl via browser sidecar,
  // falls back to our own snapshot series.
  app.get('/api/tokens/:chain/:ca/balance-chart', (req, res) => {
    const { chain, ca } = req.params;
    const window = ['day', 'week', 'month'].includes(String(req.query.window)) ? (req.query.window as 'day' | 'week' | 'month') : 'day';
    if (!(CHAINS as readonly string[]).includes(chain)) {
      res.status(400).json({ error: `invalid chain "${chain}"` });
      return;
    }
    balanceSeries(ca, chain as Chain, window)
      .then((series) => res.json(series))
      .catch((e: unknown) => res.status(502).json({ error: String(e).slice(0, 200) }));
  });
  */

  app.use((_req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    log.error('[api] unhandled', err);
    res.status(500).json({ error: message });
  });

  return app;
}
