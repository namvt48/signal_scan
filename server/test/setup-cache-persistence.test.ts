import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Chain } from '../src/shared/chain.js';
import type { SetupCacheEntry } from '../src/setup-cache.js';
import {
  clearSetupRetry,
  getSetupCacheEntry,
  getSetupRetry,
  loadSetupCache,
  putSetupCacheEntry,
  recordSetupRetry,
  stampSetupCacheField,
} from '../src/setup-cache.js';

const CHAIN: Chain = 'sol';

function cacheFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'setup-cache-persistence-')), 'nansen-cache.json');
}

function bareEntry(ca: string, takenAt: number): SetupCacheEntry {
  return {
    ca,
    chain: CHAIN,
    taken_at: takenAt,
    window: '',
    series: [],
    exchange: [],
  };
}

test('LF bucket provenance survives persistence and legacy omission remains compatible', () => {
  const file = cacheFile();
  loadSetupCache(file);
  const now = Date.now();
  putSetupCacheEntry({ ...bareEntry('CACHE-LF-RULE', now), lf_rule: 'bucket-day-v2' });
  assert.equal(getSetupCacheEntry('CACHE-LF-RULE', CHAIN)?.lf_rule, 'bucket-day-v2');
  loadSetupCache(file);
  assert.equal(getSetupCacheEntry('CACHE-LF-RULE', CHAIN)?.lf_rule, 'bucket-day-v2');

  putSetupCacheEntry(bareEntry('CACHE-LF-LEGACY', now));
  loadSetupCache(file);
  assert.equal(getSetupCacheEntry('CACHE-LF-LEGACY', CHAIN)?.lf_rule, undefined);
});

test('marker-only first-add entry stamps only the obtained field and preserves absent markers on reload', () => {
  const file = cacheFile();
  loadSetupCache(file);
  const now = Date.now();
  stampSetupCacheField('CACHE-MARKER-ONLY', CHAIN, 'info_at', now);
  putSetupCacheEntry(bareEntry('CACHE-ABSENT-MARKERS', now));
  stampSetupCacheField('CACHE-SERIES-ONLY', CHAIN, 'series_at', now);

  const firstAdd = getSetupCacheEntry('CACHE-MARKER-ONLY', CHAIN);
  assert.ok(firstAdd, 'stamping an obtained field creates a marker-only cache record');
  assert.equal(firstAdd.info_at, now);
  assert.equal(firstAdd.series_at, undefined, 'info stamping must not fabricate series freshness');
  assert.equal(firstAdd.series.length, 0);
  assert.equal(firstAdd.exchange.length, 0);

  loadSetupCache(file);
  assert.equal(getSetupCacheEntry('CACHE-MARKER-ONLY', CHAIN)?.info_at, now);
  assert.equal(getSetupCacheEntry('CACHE-MARKER-ONLY', CHAIN)?.series_at, undefined);
  assert.equal(getSetupCacheEntry('CACHE-SERIES-ONLY', CHAIN)?.info_at, undefined);
  assert.equal(getSetupCacheEntry('CACHE-SERIES-ONLY', CHAIN)?.series_at, now);
  assert.equal(getSetupCacheEntry('CACHE-ABSENT-MARKERS', CHAIN)?.info_at, undefined);
  assert.equal(getSetupCacheEntry('CACHE-ABSENT-MARKERS', CHAIN)?.series_at, undefined);
});

test('info, series and LF retry states persist independently and clear by field', () => {
  const file = cacheFile();
  loadSetupCache(file);
  const ca = 'CACHE-RETRY-INDEPENDENT';
  const infoRetry = { misses: 2, nextAt: 10_000 };
  const seriesRetry = { misses: 3, nextAt: 20_000 };
  const lfRetry = { misses: 4, nextAt: 30_000 };

  recordSetupRetry(ca, CHAIN, 'info', infoRetry.misses, infoRetry.nextAt);
  recordSetupRetry(ca, CHAIN, 'series', seriesRetry.misses, seriesRetry.nextAt);
  recordSetupRetry(ca, CHAIN, 'lf', lfRetry.misses, lfRetry.nextAt);
  loadSetupCache(file);

  assert.deepEqual(getSetupRetry(ca, CHAIN, 'info'), infoRetry);
  assert.deepEqual(getSetupRetry(ca, CHAIN, 'series'), seriesRetry);
  assert.deepEqual(getSetupRetry(ca, CHAIN, 'lf'), lfRetry);
  clearSetupRetry(ca, CHAIN, 'series');
  assert.equal(getSetupRetry(ca, CHAIN, 'series'), undefined);
  assert.deepEqual(getSetupRetry(ca, CHAIN, 'info'), infoRetry);
  assert.deepEqual(getSetupRetry(ca, CHAIN, 'lf'), lfRetry);
  loadSetupCache(file);
  assert.equal(getSetupRetry(ca, CHAIN, 'series'), undefined);
  assert.deepEqual(getSetupRetry(ca, CHAIN, 'info'), infoRetry);
  assert.deepEqual(getSetupRetry(ca, CHAIN, 'lf'), lfRetry);
});
