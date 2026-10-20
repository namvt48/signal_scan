import assert from 'node:assert/strict';
import test from 'node:test';
import { tokenAmount } from '../../src/lib/format.js';

test('token amount formatting groups thousands and preserves measured precision', () => {
  const cases: Array<[number | undefined, string | undefined]> = [
    [0, '0'],
    [1234, '1,234'],
    [1234567.123456, '1,234,567.123456'],
    [0.000000000001, '0.000000000001'],
    [1e21, '1,000,000,000,000,000,000,000'],
    [undefined, undefined],
    [Number.NaN, undefined],
  ];
  for (const [value, expected] of cases) assert.equal(tokenAmount(value), expected);
});
