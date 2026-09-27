import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findTrackedCa,
  findWalletByAddress,
  insertTrackedCa,
  insertWallet,
  open,
  setTrackedCaEntryUsd,
} from '../src/db.js';

const EVM_CA = '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed';
const EVM_LOWER = EVM_CA.toLowerCase();
const SOL_CA = 'Fg9xK2mR7qT4vBn8cLd3Ws6Za1Py5Ue9HjA';

before(() => {
  open(':memory:');
});

test('EVM CA is stored and found lowercase whatever the input spelling', () => {
  insertTrackedCa({ address: EVM_CA, chain: 'base', note: '' });
  assert.equal(findTrackedCa(EVM_CA, 'base')?.address, EVM_LOWER);
  assert.equal(findTrackedCa(EVM_LOWER, 'base')?.address, EVM_LOWER);
  assert.equal(setTrackedCaEntryUsd(EVM_CA, 'base', 5)?.entry_usd, 5);
});

test('sol CA stays verbatim — base58 case must not be folded', () => {
  insertTrackedCa({ address: SOL_CA, chain: 'sol', note: '' });
  assert.equal(findTrackedCa(SOL_CA, 'sol')?.address, SOL_CA);
  assert.equal(findTrackedCa(SOL_CA.toLowerCase(), 'sol'), undefined);
});

test('EVM wallet address typed checksummed still matches its lowercase row', () => {
  insertWallet({ address: EVM_CA, name: 'w', tags: [], chain: 'base', source: 'manual' });
  assert.ok(findWalletByAddress(EVM_CA, 'base'));
  assert.ok(findWalletByAddress(EVM_LOWER, 'base'));
});
