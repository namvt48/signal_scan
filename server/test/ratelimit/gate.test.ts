import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gate } from '../../src/ratelimit/gate.js';

test('Gate: 429 with a reset header arms until reset+margin, and renews', () => {
  const g = new Gate({ statuses: [429], header: 'x-ratelimit-reset' });
  g.note(429, '1000', 0);
  assert.equal(g.until, 1_002_000);
  assert.equal(g.blocked(1_001_000), true);
  g.note(429, '1400', 0);
  assert.ok(g.until > 1_002_000, 'renewed');
});

test('Gate: a configured quota status closes for its cooldown', () => {
  const g = new Gate({ statuses: [429], statusesWithCooldown: [{ status: 403, cooldownMs: 600_000 }] });
  g.note(403, null, 5_000);
  assert.equal(g.until, 605_000);
  assert.equal(g.blocked(600_000), true);
  assert.equal(g.blocked(605_001), false);
});

test('Gate: an unlisted status is ignored', () => {
  const g = new Gate({ statuses: [429], header: 'x-ratelimit-reset' });
  g.note(500, '1000', 0);
  assert.equal(g.blocked(0), false);
});

test('Gate: a non-numeric reset header does not arm', () => {
  const g = new Gate({ statuses: [429], header: 'x-ratelimit-reset' });
  g.note(429, 'abc', 0);
  assert.equal(g.blocked(0), false);
});
