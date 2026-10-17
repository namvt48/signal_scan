import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, open } from '../src/db.js';
import {
  DEFAULT_PERIODIC_SCAN_SETTINGS,
  getPeriodicScanSettings,
  updatePeriodicScanSettings,
} from '../src/periodic-scan-settings.js';

test('periodic scan settings default, persist, and reject invalid updates atomically', () => {
  open(':memory:');
  try {
    assert.deepEqual(getPeriodicScanSettings(), DEFAULT_PERIODIC_SCAN_SETTINGS);
    const configured = { enabled: false, intervalHours: 3, maxVolume24hUsd: 220_000, maxLowFloatTokens: 44_000_000 };
    assert.deepEqual(updatePeriodicScanSettings(configured), configured);
    assert.deepEqual(updatePeriodicScanSettings({ ...configured, maxVolume24hUsd: Infinity }), {
      error: 'maxVolume24hUsd must be a finite number >= 0',
    });
    assert.deepEqual(updatePeriodicScanSettings({ ...configured, intervalHours: 5 }), {
      error: 'intervalHours must be one of 1, 2, 3, 4, 6, 8, 12, 24',
    });
    assert.deepEqual(getPeriodicScanSettings(), configured);
    assert.deepEqual(updatePeriodicScanSettings({ ...configured, extra: 1 }), {
      error: 'unknown periodic scan setting',
    });
    assert.deepEqual(getPeriodicScanSettings(), configured);
  } finally {
    getDb().close();
  }
});
