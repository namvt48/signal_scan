import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { config } from '../src/config.js';
import {
  cacheKey,
  getSetupCacheEntry,
  isSetupCacheFresh,
  loadSetupCache,
  pruneSetupCache,
  putSetupCacheEntry,
  type SetupCacheEntry,
} from '../src/setup-cache.js';

const POLL = config.pollSetupMs; // 43_200_000 (config.ts:56) — the freshness/prune clock
const PRUNE_MAX_AGE = 7 * POLL; // plan §4: entries older than 7×POLL_SETUP_MS are dropped

/** Fresh temp file path in its own mkdtemp dir — tests never touch a real ./data. */
function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'setup-cache-test-')), 'nansen-cache.json');
}

function sampleEntry(ca: string, takenAt: number): SetupCacheEntry {
  return {
    ca,
    chain: 'sol',
    taken_at: takenAt,
    window: 'week',
    series_from: takenAt - 7 * 86_400_000,
    series: [{ t: '2026-09-16T02:00:00Z', total: 616_080_000, totalUsd: 1.5, holders: 100, inflow: 5 }],
    exchange: [{ t: '2026-09-16T02:00:00Z', total: 128_890_000 }],
    t100_pct: 12.3,
    t100_multiple: 1.42,
    anchor_at: takenAt - 7 * 86_400_000,
    genesis_bal: 128_890_000,
  };
}

test('round-trip: put → version-1 envelope on disk → load preserves every field', () => {
  // Given a cache bound to a temp file and one fully-populated entry
  const file = tmpFile();
  loadSetupCache(file);
  const e = sampleEntry('caRT', Date.now());

  // When the entry is put
  putSetupCacheEntry(e);

  // Then the file holds the plan §4 envelope {version:1, entries:[…]}
  const raw: { version: number; entries: SetupCacheEntry[] } = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.entries.length, 1);

  // And a fresh load rebuilds the map keyed `${chain}:${ca}` with every field intact
  const map = loadSetupCache(file);
  assert.equal(map.size, 1);
  assert.equal(cacheKey('caRT', 'sol'), 'sol:caRT'); // key format pinned for T3
  assert.ok(map.has('sol:caRT'));
  assert.deepEqual(getSetupCacheEntry('caRT', 'sol'), e);
});

test('put upserts: second put for the same (ca, chain) replaces the record', () => {
  // Given two successive puts for one (ca, chain)
  const file = tmpFile();
  loadSetupCache(file);
  putSetupCacheEntry(sampleEntry('caUp', 1_000));
  putSetupCacheEntry(sampleEntry('caUp', 2_000));

  // When the file is loaded again
  const map = loadSetupCache(file);

  // Then exactly one record survives — the latest
  assert.equal(map.size, 1);
  assert.equal(getSetupCacheEntry('caUp', 'sol')?.taken_at, 2_000);
});

test('isSetupCacheFresh: age == POLL_SETUP_MS is stale, age == POLL_SETUP_MS - 1 is fresh', () => {
  // Given a fixed now and entries at exact ages
  const now = Date.now();

  // When/Then the boundary is `<` (plan §4: exactly POLL_SETUP_MS → NOT fresh)
  assert.equal(isSetupCacheFresh(sampleEntry('b', now - POLL), now), false);
  assert.equal(isSetupCacheFresh(sampleEntry('b', now - (POLL - 1)), now), true);
  assert.equal(isSetupCacheFresh(sampleEntry('b', now), now), true);
});

test('missing file: load → empty map, never throws; put then creates dir + file', () => {
  // Given a path whose parent dir does not exist yet
  const file = join(mkdtempSync(join(tmpdir(), 'setup-cache-test-')), 'sub', 'nansen-cache.json');

  // When loading the missing file
  const map = loadSetupCache(file);

  // Then: empty map, no throw
  assert.equal(map.size, 0);
  assert.equal(getSetupCacheEntry('x', 'sol'), undefined);

  // And a subsequent put creates the parent dir and the file (atomic write)
  const e = sampleEntry('x', Date.now());
  putSetupCacheEntry(e);
  assert.deepEqual(readdirSync(dirname(file)), ['nansen-cache.json']);
  assert.deepEqual(getSetupCacheEntry('x', 'sol'), e);
});

test('corrupt / empty / wrong-envelope file: load → empty map, never throws', () => {
  const file = tmpFile();

  // Given/When/Then — every unreadable shape degrades to an empty map
  writeFileSync(file, '{not json');
  assert.equal(loadSetupCache(file).size, 0);

  writeFileSync(file, '');
  assert.equal(loadSetupCache(file).size, 0);

  writeFileSync(file, JSON.stringify({ version: 2, entries: [] })); // future envelope
  assert.equal(loadSetupCache(file).size, 0);

  writeFileSync(file, JSON.stringify({ version: 1, entries: 'nope' })); // entries not an array
  assert.equal(loadSetupCache(file).size, 0);

  writeFileSync(file, JSON.stringify([1, 2, 3])); // not an envelope at all
  assert.equal(loadSetupCache(file).size, 0);
  assert.equal(getSetupCacheEntry('anything', 'sol'), undefined);
});

test('malformed entries are skipped; the valid sibling survives', () => {
  // Given one good record, one missing a derived field, one with an unknown chain
  const file = tmpFile();
  const good = sampleEntry('good', Date.now());
  const badDerived: Record<string, unknown> = { ...sampleEntry('badDerived', Date.now()), genesis_bal: null };
  const badChain: Record<string, unknown> = { ...sampleEntry('badChain', Date.now()), chain: 'eth' };
  writeFileSync(file, JSON.stringify({ version: 1, entries: [good, badDerived, badChain] }));

  // When loading
  const map = loadSetupCache(file);

  // Then only the well-formed entry is in the map
  assert.equal(map.size, 1);
  assert.deepEqual(getSetupCacheEntry('good', 'sol'), good);
  assert.equal(getSetupCacheEntry('badDerived', 'sol'), undefined);
  assert.equal(getSetupCacheEntry('badChain', 'sol'), undefined); // rejected at load → no key to find
});

test('put leaves no *.tmp behind — success path and blocked-target failure path', () => {
  // Given a working cache file
  const dir = mkdtempSync(join(tmpdir(), 'setup-cache-test-'));
  const file = join(dir, 'nansen-cache.json');
  loadSetupCache(file);

  // When a put succeeds
  putSetupCacheEntry(sampleEntry('ok', Date.now()));

  // Then the dir holds only the cache file — the tmp was renamed away
  assert.deepEqual(readdirSync(dir), ['nansen-cache.json']);

  // Given a target path that is a DIRECTORY (rename onto it must fail)
  const blockedDir = mkdtempSync(join(tmpdir(), 'setup-cache-test-'));
  const blocked = join(blockedDir, 'nansen-cache.json');
  mkdirSync(blocked);
  loadSetupCache(blocked); // unreadable target → empty map, no throw

  // When a put fails to persist
  const e2 = sampleEntry('t2', Date.now());
  putSetupCacheEntry(e2); // must not throw

  // Then no *.tmp survives and the in-memory entry is still there (cache degrades, never crashes)
  assert.deepEqual(readdirSync(blockedDir), ['nansen-cache.json']);
  assert.deepEqual(getSetupCacheEntry('t2', 'sol'), e2);
});

test('pruneSetupCache drops untracked keys and entries older than 7×POLL_SETUP_MS, and persists', () => {
  // Given four records around the prune rule
  const file = tmpFile();
  loadSetupCache(file);
  const now = Date.now();
  putSetupCacheEntry(sampleEntry('keepFresh', now)); // tracked + fresh → keep
  putSetupCacheEntry(sampleEntry('dropUntracked', now)); // not in trackedKeys → drop
  putSetupCacheEntry(sampleEntry('dropAncient', now - PRUNE_MAX_AGE - 1)); // tracked but too old → drop
  putSetupCacheEntry(sampleEntry('keepBoundary', now - PRUNE_MAX_AGE)); // exactly 7× → not "older than" → keep
  const tracked = new Set([
    cacheKey('keepFresh', 'sol'),
    cacheKey('dropAncient', 'sol'),
    cacheKey('keepBoundary', 'sol'),
  ]);

  // When pruning
  const dropped = pruneSetupCache(now, tracked);

  // Then the map holds exactly the two survivors
  assert.equal(dropped, 2);
  assert.notEqual(getSetupCacheEntry('keepFresh', 'sol'), undefined);
  assert.equal(getSetupCacheEntry('dropUntracked', 'sol'), undefined);
  assert.equal(getSetupCacheEntry('dropAncient', 'sol'), undefined);
  assert.notEqual(getSetupCacheEntry('keepBoundary', 'sol'), undefined);

  // And the file shrank with it (prune persists)
  assert.equal(loadSetupCache(file).size, 2);
});

test('config: setupCacheFile defaults beside dbPath (prod DB_PATH=/data/… → /data/nansen-cache.json)', () => {
  // The default must land in the SAME directory as the SQLite DB (bind mount ./data:/data),
  // so a DB reset and `make deploy` both leave the cache alive.
  assert.equal(config.setupCacheFile, join(dirname(config.dbPath), 'nansen-cache.json'));
});
