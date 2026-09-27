// T4 evidence probe (plan evm-base-bsc) — NOT pytest-collected (.ts).
// Run: cd server && LOG_LEVEL=error npx tsx ../scripts/t4_chain_rows_probe.ts
// Proves on a throwaway DB, through the REAL db/ingest/api layers:
//   1. same address on sol+base = 2 wallet rows, resolved by (address, chain)
//   2. POST /api/wallet-watch/trades chain=base -> wallet_trades.chain='base';
//      absent chain -> 'sol'; unknown chain -> 400
//   3. a sol replaceWalletBalances sweep leaves the base row intact
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { findWalletByAddress, getDb, insertWallet, open } from '../server/src/db.js';
import { replaceWalletBalances } from '../server/src/ingest.js';
import { createApp } from '../server/src/api.js';

const ADDR = '0x6A2f9C4e1B7d3F8a5E0c2D6b9A4f7C1e3D5b8E2a';
const CA = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984';

const dump = (label: string, sql: string) => {
  console.log(`\n$ ${sql}`);
  console.log(`-- ${label}`);
  for (const row of getDb().prepare(sql).all()) console.log(JSON.stringify(row));
};

const dir = mkdtempSync(join(tmpdir(), 't4-evidence-'));
open(join(dir, 't4.db'));

insertWallet({ address: ADDR, name: 'CTW-sol', tags: [], chain: 'sol', source: 'probe' });
insertWallet({ address: ADDR, name: 'CTW-base', tags: [], chain: 'base', source: 'probe' });
dump('(1) same address, 2 chains = 2 wallet rows', `SELECT address, name, chain FROM wallets WHERE address = '${ADDR}'`);
console.log(
  `\nfindWalletByAddress(ADDR,'sol').name  = ${findWalletByAddress(ADDR, 'sol')?.name}` +
    `\nfindWalletByAddress(ADDR,'base').name = ${findWalletByAddress(ADDR, 'base')?.name}` +
    `\nfindWalletByAddress(ADDR,'bsc')       = ${String(findWalletByAddress(ADDR, 'bsc'))}`,
);

const server = createApp('probe').listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const post = async (body: Record<string, unknown>) => {
  const res = await fetch(`${base}/api/wallet-watch/trades`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
};
const trade = { wallet: ADDR, ca: CA, ts: 1_758_000_000_000, side: 'buy', amountUsd: 250, price: 0.002 };
console.log(`\n(2) POST chain='base' -> ${JSON.stringify(await post({ ...trade, tx: '0xtx-base', chain: 'base' }))}`);
console.log(`    POST no chain    -> ${JSON.stringify(await post({ ...trade, tx: '0xtx-nochain' }))}`);
console.log(`    POST chain='doge'-> ${JSON.stringify(await post({ ...trade, tx: '0xtx-doge', chain: 'doge' }))}`);
dump('wallet_trades rows (chain column written; doge never landed)', 'SELECT tx, ca, chain, side, source FROM wallet_trades ORDER BY tx');

const baseW = findWalletByAddress(ADDR, 'base')!;
replaceWalletBalances(baseW.id, 'base', [{ ca: CA, amount: 10 }]);
replaceWalletBalances(baseW.id, 'sol', [{ ca: CA, amount: 5 }]);
dump('(3) balances: base row + sol row coexist', `SELECT ca, chain, token_amount FROM wallet_token_state WHERE wallet_id = '${baseW.id}' ORDER BY chain`);
replaceWalletBalances(baseW.id, 'sol', [{ ca: CA, amount: 0 }]);
dump('after a sol sweep to 0: sol row gone, BASE ROW INTACT', `SELECT ca, chain, token_amount FROM wallet_token_state WHERE wallet_id = '${baseW.id}' ORDER BY chain`);

server.close();
rmSync(dir, { recursive: true, force: true });
