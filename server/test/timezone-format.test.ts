import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ago, fmtDate, formatTime, formatTimestamp } from '../../src/lib/format.js';

test('absolute timestamps always render in UTC+7, independent of browser timezone', () => {
  const timestamp = Date.parse('2026-10-08T17:15:00Z');
  assert.equal(formatTimestamp(timestamp), '09 Oct 2026, 00:15');
  assert.equal(formatTime(timestamp), '00:15');
  assert.equal(fmtDate('2026-10-08T17:15:00Z'), '09 Oct 2026');
});

test('invalid timestamps stay explicit and relative ages remain durations', () => {
  assert.equal(formatTimestamp('not-a-timestamp'), '—');
  assert.equal(formatTime(Number.NaN), '—');
  const now = Date.parse('2026-10-08T17:15:00Z');
  assert.equal(ago(now - 61 * 60_000, now), '1h 1m ago');
});
