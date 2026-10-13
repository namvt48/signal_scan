import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HeliusUsagePoller } from '../src/providers/helius-usage.js';

const projectIds = [
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  'b1b2c3d4-e5f6-7890-abcd-ef1234567890',
  'c1b2c3d4-e5f6-7890-abcd-ef1234567890',
  'd1b2c3d4-e5f6-7890-abcd-ef1234567890',
  'e1b2c3d4-e5f6-7890-abcd-ef1234567890',
  'f1b2c3d4-e5f6-7890-abcd-ef1234567890',
];

function endpoints(): string[] {
  return projectIds.map((_, index) => `https://rpc-${index}.example/?api-key=private-key-${index}`);
}

function usageResponse(creditsRemaining = 100, prepaidCreditsRemaining = 10): Response {
  return new Response(JSON.stringify({
    creditsRemaining,
    creditsUsed: 7,
    prepaidCreditsRemaining,
    prepaidCreditsUsed: 2,
    creditCycle: { start: '2026-04-01', end: '2026-05-01' },
    subscriptionDetails: { creditsLimit: 1_000 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

test('Helius poller sums available and prepaid balance without exposing RPC keys', async () => {
  const requests: Array<{ url: string; apiKey: string | null }> = [];
  const poller = new HeliusUsagePoller(async (input, init) => {
    requests.push({ url: String(input), apiKey: new Headers(init?.headers).get('X-Api-Key') });
    return usageResponse();
  }, () => 12_345);

  const usage = await poller.refreshNow(endpoints(), projectIds);

  assert.equal(usage.length, 6);
  assert.equal(usage[0]?.remaining, 110);
  assert.equal(usage[0]?.limit, 1_012);
  assert.equal(usage[0]?.creditsUsed, 7);
  assert.equal(usage[0]?.cycleStart, '2026-04-01');
  assert.equal(usage[0]?.fetchedAtMs, 12_345);
  assert.equal(requests.length, 6);
  assert.match(requests[0]?.url ?? '', /\/v0\/admin\/projects\/[a-f0-9-]+\/usage$/);
  assert.equal(requests[0]?.apiKey, 'private-key-0');
  assert.equal(requests.some(({ url }) => url.includes('private-key')), false);
});

test('Helius poller preserves explicit zero balance and deduplicates shared projects', async () => {
  let requests = 0;
  const poller = new HeliusUsagePoller(async () => {
    requests += 1;
    return usageResponse(0, 0);
  }, () => 1_000);
  const usage = await poller.refreshNow(endpoints(), Array(6).fill(projectIds[0]!));

  assert.equal(requests, 1);
  assert.equal(usage.length, 1);
  assert.equal(usage[0]?.remaining, 0);
  assert.equal(usage[0]?.endpointIndexes.length, 6);
});

test('Helius poller reports unknown when project IDs are absent or misaligned', async () => {
  let requests = 0;
  const poller = new HeliusUsagePoller(async () => {
    requests += 1;
    return usageResponse();
  }, () => 1_000);

  const absent = await poller.refreshNow(endpoints(), []);
  const mismatched = await poller.refreshNow(endpoints(), projectIds.slice(0, 5));

  assert.equal(absent[0]?.remaining, null);
  assert.equal(absent[0]?.error, 'project_ids_not_configured');
  assert.equal(mismatched[0]?.remaining, null);
  assert.equal(mismatched[0]?.error, 'project_id_count_mismatch');
  assert.equal(requests, 0);
});
