import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const helperSource = await readFile(new URL('./fomoSort.ts', import.meta.url), 'utf8');
const helperJavaScript = ts.transpileModule(helperSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { compareFomoUserActivity } = await import(`data:text/javascript;base64,${Buffer.from(helperJavaScript).toString('base64')}`);

const SAPLING = {
  symbol: 'SAPLING',
  fomoActivityAt: Date.parse('2026-10-14T11:08:45.000Z'),
  fomoUsers: [{ lastTs: Date.parse('2026-10-13T23:03:40.000Z') }],
};
const BONER = {
  symbol: 'BONER',
  fomoActivityAt: Date.parse('2026-10-14T10:53:10.000Z'),
  fomoUsers: [{ lastTs: Date.parse('2026-10-14T10:53:10.000Z') }],
};

test('default FOMO sort follows the latest user trade in the stats window', () => {
  const ordered = [SAPLING, BONER].sort(compareFomoUserActivity);
  assert.deepEqual(ordered.map(({ symbol }) => symbol), ['BONER', 'SAPLING']);
});

test('uses the maximum user timestamp even if FOMO rows are not pre-sorted', () => {
  const newerUserTrade = { fomoUsers: [{ lastTs: 10 }, { lastTs: 30 }] };
  const olderUserTrade = { fomoUsers: [{ lastTs: 20 }] };
  assert.ok(compareFomoUserActivity(newerUserTrade, olderUserTrade) < 0);
});

test('empty or zero-timestamp user lists tie at zero', () => {
  assert.equal(compareFomoUserActivity({ fomoUsers: [] }, { fomoUsers: [{ lastTs: 0 }] }), 0);
});
