import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const helperSource = await readFile(new URL('./activitySort.ts', import.meta.url), 'utf8');
const helperJavaScript = ts.transpileModule(helperSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { compareTrackedActivity } = await import(`data:text/javascript;base64,${Buffer.from(helperJavaScript).toString('base64')}`);

const SAPLING = {
  symbol: 'SAPLING',
  fomoUsers: [{ lastTs: Date.parse('2026-10-13T23:03:40.000Z') }],
  trackedActivityAt: 0,
};
const BONER = {
  symbol: 'BONER',
  fomoActivityAt: Date.parse('2026-10-14T10:53:10.000Z'),
  fomoUsers: [{ lastTs: Date.parse('2026-10-14T10:53:10.000Z') }],
  trackedActivityAt: 0,
};

test('default FOMO sort follows the latest user trade when no wallet activity exists', () => {
  const ordered = [SAPLING, BONER].sort(compareTrackedActivity);
  assert.deepEqual(ordered.map(({ symbol }) => symbol), ['BONER', 'SAPLING']);
});

test('uses the maximum FOMO timestamp and wallet timestamp', () => {
  const newerUserTrade = { trackedActivityAt: 0, fomoUsers: [{ lastTs: 10 }, { lastTs: 30 }] };
  const olderUserTrade = { trackedActivityAt: 0, fomoUsers: [{ lastTs: 20 }] };
  assert.ok(compareTrackedActivity(newerUserTrade, olderUserTrade) < 0);
});

test('empty or zero-timestamp sources tie at zero', () => {
  assert.equal(compareTrackedActivity({ trackedActivityAt: 0, fomoUsers: [] }, { trackedActivityAt: 0, fomoUsers: [{ lastTs: 0 }] }), 0);
});

test('recent native-wallet activity ranks above an older FOMO-user trade after merge', () => {
  const native = { symbol: 'NATIVE', trackedActivityAt: 30, fomoUsers: [] };
  const fomo = { symbol: 'FOMO', trackedActivityAt: 0, fomoUsers: [{ lastTs: 20 }] };
  assert.deepEqual([fomo, native].sort(compareTrackedActivity).map((row) => row.symbol), ['NATIVE', 'FOMO']);
});

test('mixed wallet and FOMO rows use the newest tracked event, not source priority', () => {
  const mixed = { symbol: 'MIXED', trackedActivityAt: 30, fomoUsers: [{ lastTs: 10 }] };
  const fomo = { symbol: 'FOMO', trackedActivityAt: 0, fomoUsers: [{ lastTs: 40 }] };
  const native = { symbol: 'NATIVE', trackedActivityAt: 20, fomoUsers: [] };
  assert.deepEqual([native, mixed, fomo].sort(compareTrackedActivity).map((row) => row.symbol), ['FOMO', 'MIXED', 'NATIVE']);
});
