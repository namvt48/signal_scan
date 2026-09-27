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
  /** Epoch ms of the requested window start (seriesFromMs, deploy-clamped). */
  series_from: number;
  /** Raw seriesAtRung points (hourly-stats, top_100_holders). */
  series: SeriesPoint[];
  /** Raw label='exchange' points (the exchangeLf request). */
  exchange: SeriesPoint[];
  /** Derived token_state columns — written straight through on rehydrate (T3). */
  t100_pct: number;
  t100_multiple: number;
  anchor_at: number;
  genesis_bal: number;
}

const FILE_VERSION = 1;
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

function parseEntry(v: unknown): SetupCacheEntry | undefined {
  if (!isRecord(v)) return undefined;
  const ca = v['ca'];
  const chain = v['chain'];
  const window = v['window'];
  if (typeof ca !== 'string' || ca === '') return undefined;
  if (!isChain(chain)) return undefined;
  if (typeof window !== 'string') return undefined;
  const takenAt = v['taken_at'];
  const seriesFrom = v['series_from'];
  const t100Pct = v['t100_pct'];
  const t100Multiple = v['t100_multiple'];
  const anchorAt = v['anchor_at'];
  const genesisBal = v['genesis_bal'];
  if (!isNum(takenAt) || !isNum(seriesFrom)) return undefined;
  if (!isNum(t100Pct) || !isNum(t100Multiple) || !isNum(anchorAt) || !isNum(genesisBal)) return undefined;
  const series = parsePoints(v['series']);
  const exchange = parsePoints(v['exchange']);
  if (!series || !exchange) return undefined;
  return {
    ca,
    chain,
    taken_at: takenAt,
    window,
    series_from: seriesFrom,
    series,
    exchange,
    t100_pct: t100Pct,
    t100_multiple: t100Multiple,
    anchor_at: anchorAt,
    genesis_bal: genesisBal,
  };
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
  loaded = true;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    log.warn(`[setup-cache] no usable cache at ${file} (${msg(err)}) — starting empty`);
    return entries;
  }
  if (!isRecord(raw) || raw['version'] !== FILE_VERSION || !Array.isArray(raw['entries'])) {
    log.warn(`[setup-cache] unrecognized envelope in ${file} (want {version:${FILE_VERSION}, entries:[]}) — starting empty`);
    return entries;
  }
  const items: unknown[] = raw['entries'];
  let skipped = 0;
  for (const item of items) {
    const e = parseEntry(item);
    if (e) entries.set(cacheKey(e.ca, e.chain), e);
    else skipped += 1;
  }
  if (skipped > 0) log.warn(`[setup-cache] skipped ${skipped} malformed entries in ${file}`);
  return entries;
}

/** The loaded record for a (ca, chain), or undefined (miss / not loaded yet). */
export function getSetupCacheEntry(ca: string, chain: Chain): SetupCacheEntry | undefined {
  return entries.get(cacheKey(ca, chain));
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
      `[setup-cache] skipped cache write for ${entry.chain}:${entry.ca.slice(0, 8) || '<empty>'} — incomplete pass (need finite derived fields + non-empty series/exchange)`,
    );
    return;
  }
  ensureLoaded();
  entries.set(cacheKey(entry.ca, entry.chain), entry);
  persist();
}

/** Valid inside ONE setup cadence: `now - taken_at < POLL_SETUP_MS` — exactly POLL_SETUP_MS ⇒ stale (plan §4). */
export function isSetupCacheFresh(entry: SetupCacheEntry, now: number): boolean {
  return now - entry.taken_at < config.pollSetupMs;
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
  if (dropped > 0) persist();
  return dropped;
}

/** C1 guard: the FIRST persist of a process must never clobber an existing file
 * with a single-entry map — hydrate from disk before writing anything. */
function ensureLoaded(): void {
  if (!loaded) loadSetupCache(activeFile);
}

/** C3 guard: an entry parseEntry would silently DROP on the next load must never
 * reach the file — every numeric field finite (a NaN/±Infinity derived value
 * vanishes at reload) and both point arrays non-empty (plan setup-fill-on-add T3). */
function isStorable(e: SetupCacheEntry): boolean {
  return (
    e.ca !== '' &&
    isChain(e.chain) &&
    isNum(e.taken_at) &&
    isNum(e.series_from) &&
    isNum(e.t100_pct) &&
    isNum(e.t100_multiple) &&
    isNum(e.anchor_at) &&
    isNum(e.genesis_bal) &&
    e.series.length > 0 &&
    e.exchange.length > 0
  );
}

function persist(): void {
  const tmp = `${activeFile}.tmp`;
  try {
    mkdirSync(dirname(activeFile), { recursive: true });
    writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, entries: [...entries.values()] }));
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
