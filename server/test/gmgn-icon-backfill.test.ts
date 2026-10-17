import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { config } from '../src/config.js';
import { getDb, insertTrackedCa, open, saveMetricPollResponse } from '../src/db.js';
import { updateTokenMetrics } from '../src/ingest.js';
import { assembleSignals } from '../src/signals.js';
import type { Chain } from '../src/types.js';
import * as poller from '../src/poller.js';

const GMGN_ICON = 'https://gmgn.ai/external-res/gmgn_v2.webp';
const DEX_ICON = 'https://cdn.dexscreener.com/cms/images/dex-icon';
const POLL_INTERVAL_MS = config.pollIconMs;
const PACE_FACTOR = config.sweepPaceFactor;
const ICON_SWEEP = Reflect.get(poller, 'gmgnIconSweep') as (provider: { tokenIcon(ca: string, chain: Chain): Promise<string | undefined> }) => Promise<void>;

before(() => {
  open(':memory:');
  config.pollIconMs = 5_000;
  config.sweepPaceFactor = 0.1;
  for (const address of ['caAvatar', 'caRace']) {
    insertTrackedCa({ address, chain: 'sol', note: '', entryUsd: 100 });
    const old = new Date(Date.now() - 45 * 86_400_000).toISOString();
    getDb().prepare('UPDATE tracked_cas SET added_at = ? WHERE address = ?').run(old, address);
  }
});

test('GMGN retries missing avatars without attributing a rejected icon to GMGN', async () => {
  const requestTimes: number[] = [];
  let avatarAttempts = 0;
  let dexResponseAt = 0;
  await ICON_SWEEP({
    tokenIcon: async (ca) => {
      requestTimes.push(Date.now());
      if (ca === 'caAvatar') return ++avatarAttempts === 1 ? undefined : GMGN_ICON;
      dexResponseAt = Date.now();
      updateTokenMetrics('caRace', 'sol', { iconUrl: DEX_ICON }, dexResponseAt);
      saveMetricPollResponse('caRace', 'sol', 'dexMeta', dexResponseAt, dexResponseAt + POLL_INTERVAL_MS, { iconUrl: DEX_ICON });
      return GMGN_ICON;
    },
  });

  assert.equal(getDb().prepare('SELECT icon_url FROM token_state WHERE ca = ?').get('caAvatar')?.icon_url, undefined);
  assert.equal(getDb().prepare('SELECT icon_url FROM token_state WHERE ca = ?').get('caRace')?.icon_url, DEX_ICON);
  assert.equal(requestTimes.length, 2);
  assert.ok(requestTimes[1]! - requestTimes[0]! >= 200, 'GMGN requests must be paced');
  saveMetricPollResponse('caRace', 'sol', 'essential', dexResponseAt + 1_000, dexResponseAt + POLL_INTERVAL_MS, { iconUrl: GMGN_ICON });
  const raceSignal = assembleSignals().find((item) => item.ca === 'caRace');
  assert.equal(raceSignal?.iconUrl, '/api/token-avatar/sol/caRace');
  assert.equal(raceSignal?.dataUpdatedAt?.icon, dexResponseAt, 'the retained Dex icon keeps its own source timestamp');
  const rejectedGmgnResponse = getDb().prepare('SELECT response_json FROM metric_poll_cache WHERE ca = ? AND kind = ?')
    .get('caRace', 'gmgnIcon') as { response_json: string | null };
  assert.equal(rejectedGmgnResponse.response_json, null, 'a rejected GMGN logo must not enter the provenance cache');
  const retry = getDb().prepare('SELECT failure_count, next_allowed_at FROM metric_poll_cache WHERE ca = ? AND kind = ?')
    .get('caAvatar', 'gmgnIcon') as { failure_count: number; next_allowed_at: number };
  assert.equal(retry.failure_count, 1);
  assert.ok(retry.next_allowed_at > Date.now());

  getDb().prepare('UPDATE metric_poll_cache SET next_allowed_at = 0 WHERE ca = ? AND kind = ?').run('caAvatar', 'gmgnIcon');
  await ICON_SWEEP({ tokenIcon: async () => { avatarAttempts++; return GMGN_ICON; } });

  const avatar = getDb().prepare('SELECT icon_url FROM token_state WHERE ca = ?').get('caAvatar') as { icon_url: string };
  assert.equal(avatar.icon_url, GMGN_ICON);
  const signal = assembleSignals().find((item) => item.ca === 'caAvatar');
  assert.equal(signal?.iconUrl, '/api/token-avatar/sol/caAvatar');
  assert.ok(signal?.dataUpdatedAt.icon);
});

after(() => {
  config.pollIconMs = POLL_INTERVAL_MS;
  config.sweepPaceFactor = PACE_FACTOR;
});
