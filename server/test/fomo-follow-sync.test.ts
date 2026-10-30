import assert from 'node:assert/strict';
import { before, beforeEach, after, test } from 'node:test';
import { config } from '../src/config.js';
import { getDb, getFomoApiRequestState, open, insertFomoUser, insertFomoTrade, listFomoUsers, getFomoFollowSync, listFomoFollowMissing } from '../src/db.js';
import { runAlitaFollowSync } from '../src/fomo-follow-sync.js';
import type { FomoFollowingUser } from '../src/fomo-api.js';

const original = { ...config };
const owner = '2c43be94-b528-5fe2-9dc3-27837e009cc8';
const tag = 'Alita follow';
const a = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', handle: 'Alice', displayName: 'Alice', private: false };
const b = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', handle: 'Bob', displayName: 'Bob', private: false };
let clock = 1_800_000_000_000;
before(() => open(':memory:'));
beforeEach(() => {
  getDb().exec('DELETE FROM fomo_users; DELETE FROM fomo_follow_sync; DELETE FROM fomo_follow_missing;');
  Object.assign(config, { showFomo: true, fomoAlitaSync: true, fomoProdUrl: 'http://bridge.test', fomoAlitaUserId: owner, fomoAlitaTag: tag });
});
after(() => Object.assign(config, original));
function run(users: FomoFollowingUser[], count = users.length, fail = false) {
  clock += config.fomoAlitaPollMs;
  return runAlitaFollowSync({ now: clock, deps: {
    fetchPage: async (_id, cursor) => fail
      ? { ok: false, users: [], status: 503, error: 'upstream_failure' }
      : { ok: true, users: cursor ? [] : users, status: 200, error: null },
    fetchProfile: async () => ({ ok: true, status: 200, error: null,
      profile: { id: owner, handle: 'ItsAlita', private: false, following: count } }),
  } });
}
function watched(user = a, source = 'alita_follow') {
  return insertFomoUser({ handle: user.handle, user_id: user.id, source, tags: ['Unicon', tag] });
}
function trades() { return (getDb().prepare('SELECT COUNT(*) AS n FROM fomo_trades').get() as { n: number }).n; }

test('count mismatch never deletes or untags an absent user or destroys trade history', async () => {
  const row = watched();
  insertFomoTrade({ fomo_user_id: row.id, event_id: 'preserve', ca: 'CA', chain: 'base', type: 'buy', ts: clock });
  await run([b], 2);
  const result = await run([b], 2);
  assert.equal(result.deleted, 0);
  assert.ok(listFomoUsers().some((u) => u.id === row.id && JSON.parse(u.tags).includes(tag)));
  assert.equal(trades(), 1);
  assert.equal(listFomoFollowMissing(owner).size, 0);
  assert.equal(getFomoFollowSync(owner)?.last_complete, 0);
});

test('complete absence must repeat in distinct polling periods before auto removal', async () => {
  const row = watched();
  const first = await run([b]);
  assert.equal(first.deleted, 0);
  assert.ok(listFomoUsers().some((u) => u.id === row.id));
  const second = await run([b]);
  assert.equal(second.deleted, 1);
  assert.equal(listFomoUsers().some((u) => u.id === row.id), false);
});

test('owner identity mismatch prevents any user-list write', async () => {
  const row = watched();
  const result = await runAlitaFollowSync({ now: clock + config.fomoAlitaPollMs, deps: {
    fetchPage: async (_id, cursor) => ({ ok: true, users: cursor ? [] : [b], status: 200, error: null }),
    fetchProfile: async () => ({ ok: true, status: 200, error: null,
      profile: { id: 'wrong-owner', handle: 'Other', private: false, following: 1 } }),
  } });
  assert.equal(result.ok, false);
  assert.deepEqual(listFomoUsers().map((user) => user.id), [row.id]);
  assert.equal(listFomoFollowMissing(owner).size, 0);
});

test('incomplete snapshot or HTTP failure breaks consecutive absence confirmation', async () => {
  for (const failure of [false, true]) {
    getDb().exec('DELETE FROM fomo_users; DELETE FROM fomo_follow_missing; DELETE FROM fomo_follow_sync;');
    const row = watched();
    await run([b]);
    await run([b], 2, failure);
    await run([b]);
    assert.ok(listFomoUsers().some((u) => u.id === row.id));
    assert.equal((await run([b])).deleted, 1);
  }
});

test('reappearance resets pending absence', async () => {
  const row = watched();
  await run([b]);
  await run([a, b]);
  await run([b]);
  assert.ok(listFomoUsers().some((u) => u.id === row.id));
});

test('manual source and other tags survive confirmed unfollow', async () => {
  const row = watched(a, 'manual');
  await run([b]);
  await run([b]);
  const saved = listFomoUsers().find((u) => u.id === row.id)!;
  assert.equal(saved.source, 'manual');
  assert.deepEqual(JSON.parse(saved.tags), ['Unicon']);
});

test('new users have stable identity and repeated snapshot is idempotent', async () => {
  assert.equal((await run([a, b])).added, 2);
  const ids = listFomoUsers().map((user) => user.id);
  assert.ok(ids.every((id) => getFomoApiRequestState(id, 'balances')?.last_outcome === 'discovery_queued'));
  const again = await run([a, b]);
  assert.equal(again.added, 0);
  assert.equal(again.tagged, 0);
  assert.deepEqual(listFomoUsers().map((u) => u.user_id).sort(), [a.id, b.id]);
});

test('case-insensitive handle enriches missing UUID without overwriting manual name or tags', async () => {
  const row = insertFomoUser({ handle: 'alice', name: 'My Alice', tags: ['Unicon'] });
  await run([a]);
  const saved = listFomoUsers().find((u) => u.id === row.id)!;
  assert.equal(saved.user_id, a.id);
  assert.equal(saved.name, 'My Alice');
  assert.equal(saved.source, 'manual');
  assert.deepEqual(JSON.parse(saved.tags), ['Unicon', tag]);
  assert.equal(getFomoApiRequestState(row.id, 'balances')?.last_outcome, 'discovery_queued');
});

test('identity conflict rolls back all user updates and records failure', async () => {
  insertFomoUser({ handle: 'Bob', user_id: a.id });
  const result = await run([a, b]);
  assert.equal(result.ok, false);
  assert.equal(listFomoUsers().length, 1);
  assert.deepEqual(JSON.parse(listFomoUsers()[0]!.tags), []);
  assert.equal(getFomoFollowSync(owner)?.consecutive_failures, 1);
});

test('duplicate stored IDs fail closed before changing either FOMO row', async () => {
  const first = watched(a);
  const second = insertFomoUser({ handle: 'Alice-legacy', user_id: a.id, tags: ['Legacy'] });
  const result = await run([a]);
  assert.equal(result.ok, false);
  const rows = listFomoUsers();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.id).sort(), [first.id, second.id].sort());
  assert.equal(listFomoFollowMissing(owner).size, 0);
});

test('duplicate identities across pages cannot authorize removal', async () => {
  watched();
  clock += config.fomoAlitaPollMs;
  const result = await runAlitaFollowSync({ now: clock, deps: {
    fetchPage: async () => ({ ok: true, users: [b], status: 200, error: null }),
    fetchProfile: async () => ({ ok: true, status: 200, error: null, profile: { id: owner, handle: 'ItsAlita', private: false, following: 1 } }),
  } });
  assert.equal(result.ok, false);
  assert.equal(listFomoUsers().length, 1);
  assert.equal(listFomoFollowMissing(owner).size, 0);
});

test('non-FOMO instance and disabled sync perform no writes or fetches', async () => {
  config.showFomo = false;
  const result = await run([a]);
  assert.equal(result.skipped, true);
  assert.equal(listFomoUsers().length, 0);
  assert.equal(getFomoFollowSync(owner), undefined);
});
