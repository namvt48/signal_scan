// Safety guards for the setup file cache (plan setup-fill-on-add T3, C1–C3):
//   C1 — the FIRST persist of a process must lazily load, never clobber the file
//   C2 — prune against an EMPTY tracked set (a just-reset DB) must be a no-op
//   C3 — an entry parseEntry would silently drop on reload must never be stored
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'setup-cache-safety-'));
const defaultFile = join(dir, 'default-nansen-cache.json');
// config.ts reads SETUP_CACHE_FILE at module evaluation — set it BEFORE the first
// src import so the module's default activeFile can never point at the real ./data.
process.env['SETUP_CACHE_FILE'] = defaultFile;
const {
  getSetupCacheEntry,
  loadSetupCache,
  pruneSetupCache,
  putSetupCacheEntry,
} = await import('../src/setup-cache.js');
type SetupCacheEntry = import('../src/setup-cache.js').SetupCacheEntry;

function sampleEntry(ca: string, takenAt: number, over: Partial<SetupCacheEntry> = {}): SetupCacheEntry {
  return {
    ca,
    chain: 'sol',
    taken_at: takenAt,
    window: 'week',
    series_from: takenAt - 7 * 86_400_000,
    series: [{ t: '2026-09-16T02:00:00Z', total: 616_080_000 }],
    exchange: [{ t: '2026-09-16T02:00:00Z', total: 128_890_000 }],
    t100_pct: 12.3,
    t100_multiple: 1.42,
    anchor_at: takenAt - 7 * 86_400_000,
    genesis_bal: 128_890_000,
    ...over,
  };
}

// MUST stay the first test in the file: it depends on the module having NEVER
// loaded (loaded === false) when the first put of the process happens.
test('C1: put with NO prior load lazily loads — 3 on-disk entries + 1 put = 4, nothing clobbered', () => {
  // Given an existing cache file with 3 entries and a process that never called loadSetupCache
  writeFileSync(
    defaultFile,
    JSON.stringify({ version: 1, entries: [sampleEntry('a', 1), sampleEntry('b', 2), sampleEntry('c', 3)] }),
  );

  // When the FIRST persist of the process happens without any load
  putSetupCacheEntry(sampleEntry('d', 4));

  // Then all 4 entries are on disk — the pre-existing file was not overwritten
  const raw = JSON.parse(readFileSync(defaultFile, 'utf8')) as { entries: { ca: string }[] };
  assert.equal(raw.entries.length, 4);
  assert.deepEqual(raw.entries.map((e) => e.ca).sort(), ['a', 'b', 'c', 'd']);
  assert.notEqual(getSetupCacheEntry('a', 'sol'), undefined, 'the on-disk entries are queryable after the lazy load');
});

test('C2: prune against an EMPTY tracked set is a no-op — a DB reset cannot wipe the cache', () => {
  // Given a loaded cache with two fresh entries
  const file = join(dir, 'prune-empty.json');
  loadSetupCache(file);
  const now = Date.now();
  putSetupCacheEntry(sampleEntry('keep1', now));
  putSetupCacheEntry(sampleEntry('keep2', now - 60_000));
  const before = readFileSync(file, 'utf8');

  // When pruning against the empty set (exactly what a just-reset DB produces)
  const dropped = pruneSetupCache(now, new Set());

  // Then nothing is dropped and the file is not even rewritten
  assert.equal(dropped, 0);
  assert.notEqual(getSetupCacheEntry('keep1', 'sol'), undefined);
  assert.notEqual(getSetupCacheEntry('keep2', 'sol'), undefined);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('C3: unparseable entries are never stored — non-finite derived fields or empty point arrays are refused', () => {
  // Given a loaded cache with one good entry
  const file = join(dir, 'refuse.json');
  loadSetupCache(file);
  const now = Date.now();
  putSetupCacheEntry(sampleEntry('good', now));

  // When persisting entries parseEntry would silently DROP on the next reload
  putSetupCacheEntry(sampleEntry('nanPct', now, { t100_pct: Number.NaN }));
  putSetupCacheEntry(sampleEntry('infMult', now, { t100_multiple: Number.POSITIVE_INFINITY }));
  putSetupCacheEntry(sampleEntry('nanAnchor', now, { anchor_at: Number.NaN }));
  putSetupCacheEntry(sampleEntry('nanGenesis', now, { genesis_bal: Number.NaN }));
  putSetupCacheEntry(sampleEntry('nanTaken', now, { taken_at: Number.NaN }));
  putSetupCacheEntry(sampleEntry('nanFrom', now, { series_from: Number.NaN }));
  putSetupCacheEntry(sampleEntry('emptySeries', now, { series: [] }));
  putSetupCacheEntry(sampleEntry('emptyExchange', now, { exchange: [] }));
  putSetupCacheEntry(sampleEntry('', now, { ca: '' }));

  // Then the in-memory map holds ONLY the good entry...
  assert.equal(getSetupCacheEntry('good', 'sol')?.taken_at, now);
  for (const ca of ['nanPct', 'infMult', 'nanAnchor', 'nanGenesis', 'nanTaken', 'nanFrom', 'emptySeries', 'emptyExchange', '']) {
    assert.equal(getSetupCacheEntry(ca, 'sol'), undefined, `${ca || '<empty>'} must be refused`);
  }
  // ...and the file agrees after a reload — nothing storable was lost, nothing droppable was kept
  const map = loadSetupCache(file);
  assert.equal(map.size, 1);
  assert.equal(map.get('sol:good')?.t100_multiple, 1.42);
});
