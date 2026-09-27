// Setup-cadence phase anchoring (plan setup-fill-on-add T5):
//   - nextPhaseDelayMs fires land on systemDeployAt + n×POLL_SETUP_MS boundaries,
//     never at boot + interval (the old i*20s stagger drifted on every restart)
//   - open() writes systemDeployAt ONCE; a restart never moves the phase anchor
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { getSetting, open } from '../src/db.js';
import { nextPhaseDelayMs } from '../src/poller.js';

const POLL = config.pollSetupMs;

test('nextPhaseDelayMs: fires land on anchor + n×interval boundaries, never at boot + interval', () => {
  const anchor = 1_758_000_000_000;
  // 2.5 intervals after the anchor → next boundary n=3 → half an interval away
  const now = anchor + Math.floor(2.5 * POLL);
  const delay = nextPhaseDelayMs(anchor, now, POLL);
  assert.equal(delay, anchor + 3 * POLL - now);
  assert.equal((now + delay - anchor) % POLL, 0, 'the fire time is exactly on a boundary');
  assert.notEqual(delay, POLL, 'boot + interval is NOT the phase — the anchor is');
  assert.ok(delay > 0 && delay < POLL);
  // exactly ON a boundary → fires immediately (that instant IS boundary n)
  assert.equal(nextPhaseDelayMs(anchor, anchor + 2 * POLL, POLL), 0);
  // fresh deploy (now == anchor) → boundary n=0 → immediate first pass
  assert.equal(nextPhaseDelayMs(anchor, anchor, POLL), 0);
  // a restart mid-cycle never waits more than one interval, and always re-phases
  for (const frac of [0.1, 0.5, 0.9, 1.7, 12.3]) {
    const at = anchor + Math.floor(frac * POLL);
    const d = nextPhaseDelayMs(anchor, at, POLL);
    assert.ok(d >= 0 && d <= POLL, `frac=${frac} delay=${d}`);
    assert.equal((at + d - anchor) % POLL, 0, `frac=${frac} must land on a boundary`);
  }
});

test('systemDeployAt: open() writes the anchor ONCE — restarts never move the phase', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'setup-cadence-')), 'db.sqlite');
  open(file);
  const first = getSetting('systemDeployAt');
  assert.ok(first !== undefined, 'startup must write systemDeployAt when absent');
  assert.ok(Number.isFinite(Number(first)));

  open(file); // restart / redeploy — the same db file
  assert.equal(getSetting('systemDeployAt'), first, 'a second startup must NOT overwrite the anchor');

  // The live schedule computed from the STORED anchor lands on a boundary within one interval
  const now = Date.now();
  const delay = nextPhaseDelayMs(Number(getSetting('systemDeployAt')), now, POLL);
  assert.ok(delay >= 0 && delay <= POLL);
  assert.equal((now + delay - Number(getSetting('systemDeployAt'))) % POLL, 0);
});
