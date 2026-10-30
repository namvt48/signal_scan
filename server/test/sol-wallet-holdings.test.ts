import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import {
  deleteWallet,
  getDb,
  insertTrackedCa,
  insertWallet,
  open,
  trackedByPairs,
  watchedCasForWallet,
} from '../src/db.js';
import { insertTrades, replaceWalletBalances, upsertTokenInfo } from '../src/ingest.js';
import { sumHoldingAmount, sumHoldingAmountByCa, trackedWalletStats, trackedWalletStatsByCa } from '../src/signals.js';
import { saveSolWalletHoldings } from '../src/sol-wallet-holdings.js';

const SOL_CA = 'sol-test-holding-ca-11111111111111111111';
const EVM_CA = '0x1111111111111111111111111111111111111111';

beforeEach(() => open(':memory:'));

test('discovered SOL holdings are members without trades; zero removes membership, metadata/EVM stay separate, delete cascades', () => {
  insertTrackedCa({ address: SOL_CA, chain: 'sol', note: 'original-note' });
  insertTrackedCa({ address: EVM_CA, chain: 'base', note: 'evm-note' });
  const sol = insertWallet({ address: '11111111111111111111111111111111', name: 'SOL wallet', tags: ['kept'], chain: 'sol', source: 'manual', clan: 'kept clan' });
  const evm = insertWallet({ address: EVM_CA, name: 'EVM wallet', tags: [], chain: 'base', source: 'manual' });
  upsertTokenInfo({ ca: SOL_CA, chain: 'sol', price: 2, supply: 100, symbol: 'HOLD', marketCap: 200, liquidity: 20, volume24h: 0, buyVol24h: 0, sellVol24h: 0, holders: 1 });
  insertTrades(evm.id, [{ tx: 'evm-buy', ts: Date.now(), side: 'buy', ca: EVM_CA, chain: 'base', amountUsd: 25, price: 1 }], 'watch');

  saveSolWalletHoldings(sol.id, [{ ca: SOL_CA, amount: 12.5 }]);
  const perCa = trackedWalletStats(SOL_CA, 'sol', Date.now());
  const batched = trackedWalletStatsByCa(Date.now()).get(`sol:${SOL_CA}`) ?? [];
  assert.equal(perCa.length, 1);
  assert.equal(batched.length, 1);
  replaceWalletBalances(evm.id, 'base', [{ ca: EVM_CA, amount: 7 }]);
  for (const row of [perCa[0]!, batched[0]!]) {
    assert.equal(row.name, 'SOL wallet');
    assert.equal(row.buys, 0);
    assert.equal(row.sells, 0);
    assert.equal(row.inflow, 0);
    assert.equal(row.balUsd, 25);
    assert.equal(row.holdingAmount, 12.5);
    assert.equal(row.holdingPct, 12.5);
  }
  assert.equal(sumHoldingAmount(SOL_CA, 'sol'), 12.5);
  assert.equal(sumHoldingAmountByCa().get(`sol:${SOL_CA}`), 12.5);
  assert.deepEqual(trackedByPairs([SOL_CA]).map((p) => p.wallet.id), [sol.id]);
  assert.deepEqual(watchedCasForWallet(sol.id), [SOL_CA]);

  saveSolWalletHoldings(sol.id, [{ ca: SOL_CA, amount: 0 }]);
  assert.deepEqual(trackedWalletStats(SOL_CA, 'sol', Date.now()), []);
  assert.equal(
    (getDb().prepare("SELECT count(*) AS n FROM zero_holdings WHERE member_type = 'wallet' AND member_id = ? AND ca = ? AND chain = 'sol'").get(sol.id, SOL_CA) as { n: number }).n,
    0,
    'scan-only zero snapshots must not create permanent wallet/CA tombstones',
  );
  assert.equal(sumHoldingAmount(SOL_CA, 'sol'), 0);
  assert.deepEqual(trackedByPairs([SOL_CA]), []);

  const wallet = getDb().prepare('SELECT name, tags, source, clan, chain FROM wallets WHERE id = ?').get(sol.id);
  assert.deepEqual(wallet, { name: 'SOL wallet', tags: '["kept"]', source: 'manual', clan: 'kept clan', chain: 'sol' });
  assert.equal(getDb().prepare('SELECT note FROM tracked_cas WHERE address = ? AND chain = ?').get(SOL_CA, 'sol') &&
    (getDb().prepare('SELECT note FROM tracked_cas WHERE address = ? AND chain = ?').get(SOL_CA, 'sol') as { note: string }).note, 'original-note');
  assert.equal(sumHoldingAmount(EVM_CA, 'base'), 7, 'legacy EVM balance membership is unchanged');

  saveSolWalletHoldings(sol.id, [{ ca: SOL_CA, amount: 4 }]);
  deleteWallet(sol.id);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM sol_wallet_holding_membership WHERE wallet_id = ?').get(sol.id) &&
    (getDb().prepare('SELECT COUNT(*) AS n FROM sol_wallet_holding_membership WHERE wallet_id = ?').get(sol.id) as { n: number }).n, 0);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM zero_holdings WHERE member_type = 'wallet' AND member_id = ?").get(sol.id) &&
    (getDb().prepare("SELECT COUNT(*) AS n FROM zero_holdings WHERE member_type = 'wallet' AND member_id = ?").get(sol.id) as { n: number }).n, 0);
  assert.equal(sumHoldingAmount(EVM_CA, 'base'), 7, 'EVM watch-trade membership remains unchanged');
});
test('positive EVM snapshots create holder membership without BUY history and stay chain-scoped', () => {
  insertTrackedCa({ address: EVM_CA, chain: 'base', note: 'base snapshot' });
  insertTrackedCa({ address: EVM_CA, chain: 'bsc', note: 'bsc snapshot' });
  upsertTokenInfo({ ca: EVM_CA, chain: 'base', price: 2, supply: 100, symbol: 'EVM', marketCap: 200, liquidity: 20, volume24h: 0, buyVol24h: 0, sellVol24h: 0, holders: 1 });
  upsertTokenInfo({ ca: EVM_CA, chain: 'bsc', price: 3, supply: 100, symbol: 'EVM', marketCap: 300, liquidity: 20, volume24h: 0, buyVol24h: 0, sellVol24h: 0, holders: 1 });
  const base = insertWallet({ address: '0x2222222222222222222222222222222222222222', name: 'Base holder', tags: [], chain: 'base', source: 'manual' });
  const bsc = insertWallet({ address: '0x3333333333333333333333333333333333333333', name: 'BSC holder', tags: [], chain: 'bsc', source: 'manual' });
  replaceWalletBalances(base.id, 'base', [{ ca: EVM_CA, amount: 10 }]);
  replaceWalletBalances(bsc.id, 'bsc', [{ ca: EVM_CA, amount: 20 }]);

  const byChain = trackedWalletStatsByCa(Date.now());
  assert.equal(byChain.get(`base:${EVM_CA}`)?.[0]?.holdingAmount, 10);
  assert.equal(byChain.get(`base:${EVM_CA}`)?.[0]?.balUsd, 20);
  assert.equal(byChain.get(`base:${EVM_CA}`)?.[0]?.buys, 0);
  assert.equal(byChain.get(`bsc:${EVM_CA}`)?.[0]?.holdingAmount, 20);
  assert.equal(byChain.get(`bsc:${EVM_CA}`)?.[0]?.balUsd, 60);
  assert.equal(sumHoldingAmount(EVM_CA, 'base'), 10);
  assert.equal(sumHoldingAmount(EVM_CA, 'bsc'), 20);
  assert.deepEqual(
    trackedByPairs([EVM_CA]).map(({ ca, wallet }) => `${wallet.chain}:${ca}`).sort(),
    [`base:${EVM_CA}`, `bsc:${EVM_CA}`],
  );
});

test('zero snapshot keeps an actual watch-buy member in the existing zero-holding grace window', () => {
  insertTrackedCa({ address: SOL_CA, chain: 'sol', note: 'watch-zero' });
  const sol = insertWallet({ address: '11111111111111111111111111111111', name: 'SOL buyer', tags: [], chain: 'sol', source: 'manual' });
  insertTrades(sol.id, [{ tx: 'sol-watch-buy', ts: Date.now(), side: 'buy', ca: SOL_CA, chain: 'sol', amountUsd: 10, price: 1 }], 'watch');
  saveSolWalletHoldings(sol.id, [{ ca: SOL_CA, amount: 12.5 }]);
  saveSolWalletHoldings(sol.id, [{ ca: SOL_CA, amount: 0 }]);

  const rows = trackedWalletStats(SOL_CA, 'sol', Date.now());
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.holdingAmount, 0);
  assert.equal(rows[0]!.balUsd, 0);
  assert.equal((getDb().prepare("SELECT count(*) AS n FROM zero_holdings WHERE member_type = 'wallet' AND member_id = ? AND ca = ? AND chain = 'sol'").get(sol.id, SOL_CA) as { n: number }).n, 1);
});
test('full zero SOL snapshot does bounded database work instead of per-CA writes', () => {
  const wallet = insertWallet({ address: '11111111111111111111111111111111', name: 'SOL scan', tags: [], chain: 'sol', source: 'manual' });
  const cas = Array.from({ length: 250 }, (_, index) => `${SOL_CA}-${index}`);
  for (const ca of cas) insertTrackedCa({ address: ca, chain: 'sol', note: 'snapshot' });

  const database = getDb();
  const prepare = database.prepare.bind(database);
  let executions = 0;
  try {
    database.prepare = ((sql: string) => {
      const statement = prepare(sql);
      return new Proxy(statement, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver) as unknown;
          if (key !== 'run' && key !== 'get' && key !== 'all') return value;
          return (...args: unknown[]) => {
            executions++;
            return Reflect.apply(value as (...params: unknown[]) => unknown, target, args);
          };
        },
      });
    }) as typeof database.prepare;
    saveSolWalletHoldings(wallet.id, cas.map((ca) => ({ ca, amount: 0 })));
  } finally {
    database.prepare = prepare;
  }

  assert.ok(executions < 50, `expected bounded SQL work, got ${executions} statement executions`);
  assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM wallet_token_state WHERE wallet_id = ?').get(wallet.id) as { n: number }).n, 0);
  assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM sol_wallet_holding_membership WHERE wallet_id = ?').get(wallet.id) as { n: number }).n, 0);
});