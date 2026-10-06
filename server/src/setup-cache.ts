// File cache for the setup indicators (t100/lf) — plan setup-fill-on-add §4 (T2).
// One record per (ca, chain), written after a successful refreshSeries pass and
// loaded at startup so a DB-table reset (nansen_series/token_state wiped) no
// longer forces a re-crawl through the browser door.
//
// LEAF module: runtime imports are config + log + shared/chain only (SeriesPoint is a
// type-only import from db.ts, erased at runtime). poller.ts (T3) imports THIS.
// File I/O is node:fs only; writes are atomic (tmp + rename).
// Note: `make ssh-rm` deletes REMOTE_DIR incl. data/ — this file does not
// survive that, destructive-by-design (plan §4).

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';
import { log } from './log.js';
import type { SeriesPoint } from './db.js';
import { CHAINS, type Chain } from './shared/chain.js';

/** One cached setup pass for a (ca, chain) — the plan §4 record shape. */
export interface SetupCacheEntry {
  ca: string;
  chain: Chain;
  /** Epoch ms when the pass completed — the freshness/prune clock. */
  taken_at: number;
  /** Rung the series was fetched at (e.g. 'week') — the nansen_series replay key. */
  window: string;
  /** Epoch ms of the requested window start (seriesFromMs, deploy-clamped).
   * Optional: a marker-only entry (payload arrays empty) carries no window start. */
  series_from?: number;
  /** Raw seriesAtRung points (hourly-stats, top_100_holders). MAY be []. */
  series: SeriesPoint[];
  /** Raw label='exchange' points (the exchangeLf request). MAY be []. */
  exchange: SeriesPoint[];
  /** Derived token_state columns — written straight through on rehydrate (T3).
   * Optional: absent on a marker-only entry whose payload came back empty. */
  t100_pct?: number;
  t100_multiple?: number;
  anchor_at?: number;
  genesis_bal?: number;
  /** Epoch ms we OBTAINED the gini/fresh% field — its own 6h TTL (isInfoFresh).
   * Optional: absent at runtime means "never obtained" (stale); a legacy entry
   * gets it backfilled from `taken_at` once, at load time (parseEntry). */
  info_at?: number;
  series_at?: number;
  /** LF query bucket provenance; absent on legacy entries until revalidated. */
  lf_rule?: 'bucket-hour-v2' | 'bucket-day-v2';
}


const FILE_VERSION = 2;
const LEGACY_FILE_VERSION = 1;
export interface SetupRetryState {
  misses: number;
  nextAt: number;
}
type SetupRetryField = 'info' | 'series' | 'lf';
let retries = new Map<string, SetupRetryState>();
/** Entries strictly older than 7 × POLL_SETUP_MS are pruned (plan §4). */
const PRUNE_AGE_FACTOR = 7;

let activeFile = config.setupCacheFile;
let entries = new Map<string, SetupCacheEntry>();
/** False until the map was populated from disk (explicit load or the lazy C1 load). */
let loaded = false;

/** Map/file key of a (ca, chain) record: `${chain}:${ca}` (T3 builds trackedKeys with this). */
export function cacheKey(ca: string, chain: Chain): string {
  return `${chain}:${ca}`;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isChain(v: unknown): v is Chain {
  return typeof v === 'string' && (CHAINS as readonly string[]).includes(v);
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function parsePoint(v: unknown): SeriesPoint | undefined {
  if (!isRecord(v)) return undefined;
  const t = v['t'];
  const total = v['total'];
  if (!(typeof t === 'string' || isNum(t))) return undefined;
  if (!isNum(total)) return undefined;
  const p: SeriesPoint = { t, total };
  const usd = v['totalUsd'];
  const holders = v['holders'];
  const inflow = v['inflow'];
  if (isNum(usd)) p.totalUsd = usd;
  if (isNum(holders)) p.holders = holders;
  if (isNum(inflow)) p.inflow = inflow;
  return p;
}

/** All-or-nothing: one malformed point rejects the whole record. */
function parsePoints(v: unknown): SeriesPoint[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const items: unknown[] = v;
  const out: SeriesPoint[] = [];
  for (const item of items) {
    const p = parsePoint(item);
    if (!p) return undefined;
    out.push(p);
  }
  return out;
}

function parseEntry(v: unknown, legacy: boolean): SetupCacheEntry | undefined {
  if (!isRecord(v)) return undefined;
  const ca = v['ca'];
  const chain = v['chain'];
  const takenAt = v['taken_at'];
  if (typeof ca !== 'string' || ca === '') return undefined;
  if (!isChain(chain)) return undefined;
  if (!isNum(takenAt)) return undefined;
  const window = v['window'] === undefined ? '' : v['window'];
  if (typeof window !== 'string') return undefined;
  const seriesFrom = v['series_from'];
  const lfRule = v['lf_rule'];
  if (lfRule !== undefined && lfRule !== 'bucket-hour-v2' && lfRule !== 'bucket-day-v2') return undefined;
  const t100Pct = v['t100_pct'];
  const t100Multiple = v['t100_multiple'];
  const anchorAt = v['anchor_at'];
  const genesisBal = v['genesis_bal'];
  const infoAt = v['info_at'];
  const seriesAt = v['series_at'];
  // Optional numerics: absent is fine (a marker-only entry carries no payload), but a
  // PRESENT value must be finite — an entry with a NaN/Infinity field is dropped whole,
  // never round-tripped (the original C3 intent).
  for (const n of [seriesFrom, t100Pct, t100Multiple, anchorAt, genesisBal, infoAt, seriesAt]) {
    if (n !== undefined && !isNum(n)) return undefined;
  }
  const series = v['series'] === undefined ? [] : parsePoints(v['series']);
  const exchange = v['exchange'] === undefined ? [] : parsePoints(v['exchange']);
  if (!series || !exchange) return undefined;
  return {
    ca,
    chain,
    taken_at: takenAt,
    window,
    series_from: isNum(seriesFrom) ? seriesFrom : undefined,
    series,
    exchange,
    t100_pct: isNum(t100Pct) ? t100Pct : undefined,
    t100_multiple: isNum(t100Multiple) ? t100Multiple : undefined,
    anchor_at: isNum(anchorAt) ? anchorAt : undefined,
    genesis_bal: isNum(genesisBal) ? genesisBal : undefined,
    info_at: isNum(infoAt) ? infoAt : legacy ? takenAt : undefined,
    series_at: isNum(seriesAt) ? seriesAt : legacy ? takenAt : undefined,
    ...(lfRule !== undefined ? { lf_rule: lfRule } : {}),
  };
}

function retryKey(ca: string, chain: Chain, field: SetupRetryField): string {
  return `${cacheKey(ca, chain)}:${field}`;
}

function parseRetryState(v: unknown): SetupRetryState | undefined {
  if (!isRecord(v)) return undefined;
  const misses = v['misses'];
  const nextAt = v['nextAt'];
  if (!isNum(misses) || !Number.isSafeInteger(misses) || misses < 0 || !isNum(nextAt) || nextAt < 0) return undefined;
  return { misses, nextAt };
}

/**
 * Read the cache file into the in-memory map (replacing any previous content)
 * and return it. Missing / empty / corrupt / unreadable → empty map plus ONE
 * warning line; never throws. `file` defaults to config.setupCacheFile — the
 * same explicit-path seam as db.ts open(); tests pass a temp path.
 */
export function loadSetupCache(file: string = config.setupCacheFile): Map<string, SetupCacheEntry> {
  activeFile = file;
  entries = new Map();
  retries = new Map();
  loaded = true;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    log.warn(`[setup-cache] no usable cache at ${file} (${msg(err)}) — starting empty`);
    return entries;
  }
  if (!isRecord(raw) || (raw['version'] !== FILE_VERSION && raw['version'] !== LEGACY_FILE_VERSION) || !Array.isArray(raw['entries'])) {
    log.warn(`[setup-cache] unrecognized envelope in ${file} (want {version:${FILE_VERSION}, entries:[]}) — starting empty`);
    return entries;
  }
  const legacy = raw['version'] === LEGACY_FILE_VERSION;
  const items: unknown[] = raw['entries'];
  let skipped = 0;
  for (const item of items) {
    const e = parseEntry(item, legacy);
    if (e) entries.set(cacheKey(e.ca, e.chain), e);
    else skipped += 1;
  }
  if (!legacy && isRecord(raw['retries'])) {
    for (const [key, value] of Object.entries(raw['retries'])) {
      const state = parseRetryState(value);
      const split = key.indexOf(':');
      const field = key.slice(key.lastIndexOf(':') + 1);
      if (state && isChain(key.slice(0, split)) && key.lastIndexOf(':') > split + 1 &&
        (field === 'info' || field === 'series' || field === 'lf')) retries.set(key, state);
      else skipped += 1;
    }
  }
  if (skipped > 0) log.warn(`[setup-cache] skipped ${skipped} malformed entries/retries in ${file}`);
  return entries;
}
export function getSetupRetry(ca: string, chain: Chain, field: SetupRetryField): SetupRetryState | undefined {
  ensureLoaded();
  return retries.get(retryKey(ca, chain, field));
}

export function recordSetupRetry(ca: string, chain: Chain, field: SetupRetryField, misses: number, nextAt: number): void {
  ensureLoaded();
  if (!ca || !isChain(chain) || !Number.isSafeInteger(misses) || misses < 0 || !isNum(nextAt) || nextAt < 0) {
    log.warn('[setup-cache] skipped invalid retry state', chain, field);
    return;
  }
  retries.set(retryKey(ca, chain, field), { misses, nextAt });
  persist();
}

export function clearSetupRetry(ca: string, chain: Chain, field: SetupRetryField): void {
  ensureLoaded();
  if (retries.delete(retryKey(ca, chain, field))) persist();
}

/** Read a cached record, hydrating once before any eligibility or credit decision. */
export function getSetupCacheEntry(ca: string, chain: Chain): SetupCacheEntry | undefined {
  ensureLoaded();
  return entries.get(cacheKey(ca, chain));
}

/** Number of entries currently in the cache — hydrates from disk first (ensureLoaded). */
export function setupCacheSize(): number {
  ensureLoaded();
  return entries.size;
}

/**
 * Upsert one record and persist the whole file atomically (tmp + rename, parent
 * dir created). A persist failure warns and keeps the in-memory entry (a cache
 * write must never kill a poll pass); the tmp file is removed so no stale *.tmp
 * survives. Call loadSetupCache() first to bind the target file — the C1 guard
 * lazily loads anyway, so a put can never clobber an on-disk cache.
 */
export function putSetupCacheEntry(entry: SetupCacheEntry): void {
  if (!isStorable(entry)) {
    log.warn(
      `[setup-cache] skipped cache write for ${entry.chain}:${entry.ca.slice(0, 8) || '<empty>'} — unusable entry (need a non-empty ca, a known chain, a finite taken_at and no non-finite field)`,
    );
    return;
  }
  ensureLoaded();
  entries.set(cacheKey(entry.ca, entry.chain), entry);
  persist();
}


/** gini/fresh% freshness: the marker means "we OBTAINED this field at info_at".
 * No marker ⇒ never obtained ⇒ stale — a series-only pass can never park a CA on
 * the gini clock. (Legacy entries are backfilled once at LOAD — see parseEntry.) */
export function isInfoFresh(e: SetupCacheEntry, now: number): boolean {
  return e.info_at !== undefined && now - e.info_at < config.pollSetupMs;
}

/** T100-series freshness: marker = "we OBTAINED the series at series_at"; absent ⇒
 * never obtained ⇒ stale (a legacy entry is backfilled once at LOAD, parseEntry). */
export function isSeriesFresh(e: SetupCacheEntry, now: number): boolean {
  return e.series_at !== undefined && now - e.series_at < config.pollFlowsMs;
}

/** Record an obtained field, including first-add before any series has been fetched. */
export function stampSetupCacheField(ca: string, chain: Chain, field: 'info_at' | 'series_at', now: number): void {
  if (!ca || !isChain(chain) || !isNum(now)) return;
  ensureLoaded();
  const key = cacheKey(ca, chain);
  const entry = entries.get(key) ?? { ca, chain, taken_at: now, window: '', series: [], exchange: [] };
  entries.set(key, { ...entry, taken_at: now, [field]: now });
  persist();
}

/**
 * Drop entries whose key is absent from `trackedKeys` (`${chain}:${ca}`, built
 * with cacheKey) or strictly older than 7 × POLL_SETUP_MS (age == 7× survives).
 * Persists when anything was dropped. Returns the drop count for caller logging.
 */
export function pruneSetupCache(now: number, trackedKeys: ReadonlySet<string>): number {
  // C2 guard: a just-reset DB leaves tracked_cas EMPTY — pruning against the
  // empty set would wipe the whole cache, the exact thing this file exists to
  // survive. No-op (no persist) until the queue is populated again.
  if (trackedKeys.size === 0) return 0;
  ensureLoaded();
  const maxAgeMs = PRUNE_AGE_FACTOR * config.pollSetupMs;
  let dropped = 0;
  for (const [key, e] of entries) {
    if (!trackedKeys.has(key) || now - e.taken_at > maxAgeMs) {
      entries.delete(key);
      dropped += 1;
    }
  }
  let retriesDropped = false;
  for (const key of retries.keys()) {
    if (!trackedKeys.has(key.slice(0, key.lastIndexOf(':')))) {
      retries.delete(key);
      retriesDropped = true;
    }
  }
  if (dropped > 0 || retriesDropped) persist();
  return dropped;
}

/** C1 guard: the FIRST persist of a process must never clobber an existing file
 * with a single-entry map — hydrate from disk before writing anything. */
function ensureLoaded(): void {
  if (!loaded) loadSetupCache(activeFile);
}

/** Reject non-finite analytics or marker timestamps before persisting an entry. */
function isStorable(e: SetupCacheEntry): boolean {
  const numericsOk =
    (e.series_from === undefined || isNum(e.series_from)) &&
    (e.t100_pct === undefined || isNum(e.t100_pct)) &&
    (e.t100_multiple === undefined || isNum(e.t100_multiple)) &&
    (e.anchor_at === undefined || isNum(e.anchor_at)) &&
    (e.genesis_bal === undefined || isNum(e.genesis_bal)) &&
    (e.info_at === undefined || isNum(e.info_at)) &&
    (e.series_at === undefined || isNum(e.series_at)) &&
    (e.lf_rule === undefined || e.lf_rule === 'bucket-hour-v2' || e.lf_rule === 'bucket-day-v2');
  return e.ca !== '' && isChain(e.chain) && isNum(e.taken_at) && numericsOk;
}

function persist(): void {
  const tmp = `${activeFile}.tmp`;
  try {
    mkdirSync(dirname(activeFile), { recursive: true });
    writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, entries: [...entries.values()], retries: Object.fromEntries(retries) }));
    renameSync(tmp, activeFile);
  } catch (err) {
    try {
      rmSync(tmp, { force: true }); // never leave a *.tmp behind
    } catch {
      // best-effort cleanup — the warning below is the signal
    }
    log.warn(`[setup-cache] persist to ${activeFile} failed (${msg(err)}) — in-memory only`);
  }
}
