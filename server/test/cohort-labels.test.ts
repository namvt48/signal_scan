import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CohortLabelIndex } from '../src/cohort-labels.js';

const sample = (wallets: unknown[]) => ({
  schema: 'canonical_cohort_label_index_v1',
  total_wallets: wallets.length,
  ready_wallets: 0,
  wallets,
});

const entry = (wallet: string, rank: string | null, groups: string[]) => ({
  wallet,
  data_status: 'PARTIAL',
  label: { labels: { rank } },
  group_labels: { qualified_labels: groups },
});

test('cohort index keeps rank and every qualified group for partial wallet data', () => {
  const index = new CohortLabelIndex(async () => new Response());
  index.replaceFromPayload(sample([
    entry('wallet-multi', 'A', ['G3_NARRATIVE_BASKET', 'G4_UNICON_HOLDER']),
    entry('wallet-empty', null, []),
    { wallet: 'wallet-malformed', group_labels: { qualified_labels: [3, 'G2_WHALE_CONVICTION'] } },
    { wallet: 17, label: { labels: { rank: 'S' } }, group_labels: { qualified_labels: [] } },
  ]));

  assert.deepEqual(index.get('wallet-multi'), {
    rank: 'A',
    groups: ['G3_NARRATIVE_BASKET', 'G4_UNICON_HOLDER'],
  });
  assert.deepEqual(index.get('wallet-empty'), { groups: [] });
  assert.deepEqual(index.get('wallet-malformed'), { groups: ['G2_WHALE_CONVICTION'] });
  assert.equal(index.get('wallet-missing'), undefined);
});

test('refresh coalesces concurrent requests and keeps the last good snapshot on failure', async () => {
  let fetchCount = 0;
  let resolveResponse: ((response: Response) => void) | undefined;
  const pending = new Promise<Response>((resolve) => { resolveResponse = resolve; });
  const index = new CohortLabelIndex(async () => {
    fetchCount += 1;
    return fetchCount === 1 ? pending : new Response('unavailable', { status: 503 });
  });

  const first = index.refresh();
  const concurrent = index.refresh();
  assert.strictEqual(concurrent, first);
  assert.equal(fetchCount, 1);
  resolveResponse?.(new Response(JSON.stringify(sample([entry('wallet-1', 'S', ['G2_WHALE_CONVICTION'])])), {
    headers: { 'Content-Type': 'application/json' },
  }));
  await first;
  assert.deepEqual(index.get('wallet-1'), { rank: 'S', groups: ['G2_WHALE_CONVICTION'] });

  await assert.rejects(index.refresh(), /HTTP 503/);
  assert.deepEqual(index.get('wallet-1'), { rank: 'S', groups: ['G2_WHALE_CONVICTION'] });
});

test('malformed payload does not replace the existing cohort snapshot', () => {
  const index = new CohortLabelIndex(async () => new Response());
  index.replaceFromPayload(sample([entry('wallet-1', 'B', ['G1_EARLY_ENTRY'])]));

  assert.throws(() => index.replaceFromPayload({ schema: 'other', wallets: [] }), /unexpected cohort labels response shape/);
  assert.deepEqual(index.get('wallet-1'), { rank: 'B', groups: ['G1_EARLY_ENTRY'] });
});
