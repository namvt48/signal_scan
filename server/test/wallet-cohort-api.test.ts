import { after, before, test } from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { insertWallet, open } from '../src/db.js';
import { createApp } from '../src/api.js';
import { cohortLabelIndex } from '../src/cohort-labels.js';

const SERVICE_TOKEN = 'wallet-cohort-api-service-token';
const RANKED_ADDRESS = 'wallet-cohort-ranked';
const GROUPS_ADDRESS = 'wallet-cohort-groups-only';
const MISSING_ADDRESS = 'wallet-cohort-no-labels';

let server: Server;
let base = '';

before(async () => {
  open(':memory:');
  insertWallet({ address: RANKED_ADDRESS, name: 'A-ranked', tags: [], chain: 'sol', source: 'test' });
  insertWallet({ address: GROUPS_ADDRESS, name: 'B-groups', tags: [], chain: 'sol', source: 'test' });
  insertWallet({ address: MISSING_ADDRESS, name: 'C-missing', tags: [], chain: 'sol', source: 'test' });
  cohortLabelIndex.replaceFromPayload({
    schema: 'canonical_cohort_label_index_v1',
    wallets: [
      {
        wallet: RANKED_ADDRESS,
        label: { labels: { rank: 'A' } },
        group_labels: { qualified_labels: ['G2_WHALE_CONVICTION', 'G4_UNICON_HOLDER'] },
      },
      {
        wallet: GROUPS_ADDRESS,
        label: { labels: { rank: null } },
        group_labels: { qualified_labels: ['G3_NARRATIVE_BASKET'] },
      },
    ],
  });
  server = createApp('test', { serviceToken: SERVICE_TOKEN }).listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  cohortLabelIndex.replaceFromPayload({ schema: 'canonical_cohort_label_index_v1', wallets: [] });
  server.close();
});

test('GET /api/wallets enriches by address, returns multiple groups, and omits absent labels', async () => {
  const response = await fetch(`${base}/api/wallets`, {
    headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
  });
  assert.equal(response.status, 200);
  const body: unknown = await response.json();
  assert.ok(Array.isArray(body));
  const wallets = body as Array<Record<string, unknown>>;
  const byAddress = new Map(wallets.map((wallet) => [wallet.address, wallet]));

  assert.deepEqual(
    { rank: byAddress.get(RANKED_ADDRESS)?.rank, groups: byAddress.get(RANKED_ADDRESS)?.groups },
    { rank: 'A', groups: ['G2_WHALE_CONVICTION', 'G4_UNICON_HOLDER'] },
  );
  assert.equal(byAddress.get(GROUPS_ADDRESS)?.rank, undefined);
  assert.deepEqual(byAddress.get(GROUPS_ADDRESS)?.groups, ['G3_NARRATIVE_BASKET']);
  assert.equal(byAddress.get(MISSING_ADDRESS)?.rank, undefined);
  assert.equal(Object.hasOwn(byAddress.get(MISSING_ADDRESS) ?? {}, 'groups'), false);
});
