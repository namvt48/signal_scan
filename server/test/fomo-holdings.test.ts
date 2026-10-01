// FOMO wallet resolution + holding measurement — OFFLINE, deterministic.
// `fetch` is stubbed with ABI-exact aggregate3 fixtures (EVM) and JSON-RPC
// bodies (Solana); no network, ever.

import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EvmRpcClient,
  TOTAL_SUPPLY_SELECTOR,
} from '../src/providers/evm.js';
import {
  SPL_TOKEN_PROGRAM_ID,
  SolanaRpcClient,
  parseSolanaTransferOwner,
  parseTokenSupply,
} from '../src/providers/solana.js';
import { refreshFomoHolding, trackFomoWalletFromTx, type FomoRpcDeps } from '../src/fomo-holdings.js';
import { getDb, insertFomoUser, insertFomoUserWallet, open } from '../src/db.js';

const WALLET = `0x${'b2'.repeat(20)}`;
const OTHER_WALLET = `0x${'c3'.repeat(20)}`;
const CA = `0x${'a1'.repeat(20)}`;
const TX = `0x${'cd'.repeat(32)}`;
const SOL_WALLET = 'SoTraderWallet1111111111111111111111111111';
const SOL_MINT = 'SoMint11111111111111111111111111111111111';

function u256(n: bigint | number): string {
  return BigInt(n).toString(16).padStart(64, '0');
}

/** Word i AFTER the 4-byte selector of an aggregate3 calldata hex. */
function wordOf(hex: string, i: number): string {
  return hex.slice(10 + i * 64, 10 + (i + 1) * 64);
}

function aggregate3Result(rs: readonly { success: boolean; returnData: string }[]): string {
  const tuples = rs.map((r) => {
    const data = r.returnData.replace(/^0x/i, '');
    return [u256(r.success ? 1 : 0), u256(0x40), u256(data.length / 2), data.padEnd(Math.ceil(data.length / 64) * 64, '0')].join('');
  });
  const offs: string[] = [];
  let at = rs.length * 32;
  for (const t of tuples) {
    offs.push(u256(at));
    at += t.length / 2;
  }
  return `0x${u256(0x20)}${u256(rs.length)}${offs.join('')}${tuples.join('')}`;
}

const ok = (returnData: string): { success: boolean; returnData: string } => ({ success: true, returnData });
const fail = (): { success: boolean; returnData: string } => ({ success: false, returnData: '0x' });

const rpcOk = (result: unknown): Response =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 });

interface EvmBody {
  method: string;
  params: [{ to: string; data: string }];
}

function deps(evmUrl = 'https://evm.test', solUrl = 'https://sol.test'): FomoRpcDeps {
  return { evm: new EvmRpcClient(() => [evmUrl]), sol: new SolanaRpcClient([solUrl]) };
}

/** EVM stub: tx.from + a supply call and a balance call, answered by sub-call count. */
function stubEvm(supply: readonly { success: boolean; returnData: string }[], balance = 250n * 10n ** 18n): { hits: EvmBody[] } {
  const hits: EvmBody[] = [];
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body)) as EvmBody;
    hits.push(body);
    if (body.method === 'eth_getTransactionByHash') return rpcOk({ from: WALLET });
    const data = body.params[0].data;
    const n = Number(BigInt(`0x${wordOf(data, 1)}`));
    if (data.includes(TOTAL_SUPPLY_SELECTOR)) {
      return rpcOk(aggregate3Result(n === 1 ? [supply[0]!] : [supply[0]!, ok(u256(18))]));
    }
    return rpcOk(aggregate3Result(n === 1 ? [ok(u256(balance))] : [ok(u256(balance)), ok(u256(18))]));
  }) as unknown as typeof fetch;
  return { hits };
}

/** Solana stub: one transfer-authority wallet, one token account, a UI supply. */
function stubSol(balance: string, supply: string): void {
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body)) as { method: string };
    if (body.method === 'getTransaction') {
      return rpcOk({
        transaction: {
          message: {
            accountKeys: ['feePayerIgnored'],
            instructions: [
              { programId: SPL_TOKEN_PROGRAM_ID, parsed: { type: 'transferChecked', info: { authority: SOL_WALLET } } },
            ],
          },
        },
      });
    }
    if (body.method === 'getTokenSupply') return rpcOk({ value: { uiAmountString: supply, decimals: 6 } });
    return rpcOk({
      value: [
        {
          account: { data: { parsed: { info: { mint: SOL_MINT, tokenAmount: { uiAmountString: balance, amount: '0', decimals: 6 } } } } },
        },
      ],
    });
  }) as unknown as typeof fetch;
}

before(() => {
  open(':memory:');
});

test('parseSolanaTransferOwner: SPL transfer authority, then owner, then accountKeys fallback, else null', () => {
  const auth = {
    result: {
      transaction: {
        message: {
          accountKeys: ['ignored'],
          instructions: [
            { programId: 'other', parsed: { type: 'transferChecked', info: { authority: 'NOT_THIS' } } },
            { programId: SPL_TOKEN_PROGRAM_ID, parsed: { type: 'transferChecked', info: { authority: SOL_WALLET } } },
          ],
        },
      },
    },
  };
  assert.equal(parseSolanaTransferOwner(auth), SOL_WALLET, 'authority of the SPL transfer wins');
  assert.equal(
    parseSolanaTransferOwner({
      result: { transaction: { message: { accountKeys: [], instructions: [{ programId: SPL_TOKEN_PROGRAM_ID, parsed: { type: 'transfer', info: { owner: 'OWNER_X' } } }] } } },
    }),
    'OWNER_X',
  );
  assert.equal(
    parseSolanaTransferOwner({ result: { transaction: { message: { accountKeys: ['FEE_PAYER'] } } } }),
    'FEE_PAYER',
    'no transfer instruction → fee payer',
  );
  assert.equal(
    parseSolanaTransferOwner({ result: { transaction: { message: { accountKeys: [{ pubkey: 'OBJ_KEY' }] } } } }),
    'OBJ_KEY',
  );
  for (const bad of [null, {}, { result: null }, { result: { transaction: {} } }, { result: { transaction: { message: {} } } }]) {
    assert.equal(parseSolanaTransferOwner(bad), null);
  }
});

test('parseTokenSupply: uiAmountString primary, amount/decimals fallback, non-positive → null', () => {
  assert.equal(parseTokenSupply({ result: { value: { uiAmountString: '1234.5', decimals: 6 } } }), 1234.5);
  assert.equal(parseTokenSupply({ result: { value: { amount: '2500000', decimals: 6 } } }), 2.5);
  for (const bad of [null, {}, { result: null }, { result: { value: {} } }, { result: { value: { uiAmountString: '0' } } }]) {
    assert.equal(parseTokenSupply(bad), null);
  }
});

test('trackFomoWalletFromTx (EVM): tx.from stored as the wallet; Σ balance → amount, amount/supply → pct', async () => {
  const orig = globalThis.fetch;
  try {
    stubEvm([ok(u256(1000n * 10n ** 18n))]);
    const user = insertFomoUser({ handle: '@evm-hold', name: 'Evm' });
    await trackFomoWalletFromTx(user.id, 'base', CA, TX, deps());

    const wallet = getDb().prepare('SELECT address FROM fomo_user_wallets WHERE fomo_user_id = ?').get(user.id) as { address: string };
    assert.equal(wallet.address, WALLET, 'lowercased tx.from persisted');
    const h = getDb().prepare('SELECT amount, pct FROM fomo_holdings WHERE fomo_user_id = ?').get(user.id) as { amount: number; pct: number };
    assert.equal(h.amount, 250);
    assert.equal(h.pct, 25);
  } finally {
    globalThis.fetch = orig;
  }
});

test('trackFomoWalletFromTx (Solana): transfer authority wallet; ui supply → pct', async () => {
  const orig = globalThis.fetch;
  try {
    stubSol('25', '1000');
    const user = insertFomoUser({ handle: '@sol-hold', name: 'Sol' });
    await trackFomoWalletFromTx(user.id, 'sol', SOL_MINT, '5xSignatureX', deps());

    const wallet = getDb().prepare('SELECT address FROM fomo_user_wallets WHERE fomo_user_id = ?').get(user.id) as { address: string };
    assert.equal(wallet.address, SOL_WALLET);
    const h = getDb().prepare('SELECT amount, pct FROM fomo_holdings WHERE fomo_user_id = ?').get(user.id) as { amount: number; pct: number };
    assert.equal(h.amount, 25);
    assert.equal(h.pct, 2.5);
  } finally {
    globalThis.fetch = orig;
  }
});

test('trackFomoWalletFromTx: empty txHash is a no-op — no RPC, no row', async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = (async () => {
      calls += 1;
      return rpcOk(null);
    }) as unknown as typeof fetch;
    const user = insertFomoUser({ handle: '@nohash', name: 'NoHash' });
    await trackFomoWalletFromTx(user.id, 'base', CA, '', deps());
    assert.equal(calls, 0);
    assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM fomo_user_wallets WHERE fomo_user_id = ?').get(user.id) as { n: number }).n, 0);
  } finally {
    globalThis.fetch = orig;
  }
});

test('trackFomoWalletFromTx: unresolvable tx inserts nothing (opportunistic, never fabricates)', async () => {
  const orig = globalThis.fetch;
  try {
    globalThis.fetch = (async () => rpcOk(null)) as unknown as typeof fetch; // unknown tx → result null
    const user = insertFomoUser({ handle: '@unknown-tx', name: 'Unknown' });
    await trackFomoWalletFromTx(user.id, 'base', CA, TX, deps());
    assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM fomo_user_wallets WHERE fomo_user_id = ?').get(user.id) as { n: number }).n, 0);
    assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM fomo_holdings WHERE fomo_user_id = ?').get(user.id) as { n: number }).n, 0);
  } finally {
    globalThis.fetch = orig;
  }
});

test('trackFomoWalletFromTx: in-flight guard collapses a burst on the same (user, ca) to one resolve', async () => {
  const orig = globalThis.fetch;
  let resolves = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  try {
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body)) as EvmBody;
      if (body.method === 'eth_getTransactionByHash') {
        resolves += 1;
        await gate;
        return rpcOk({ from: WALLET });
      }
      const data = body.params[0].data;
      const n = Number(BigInt(`0x${wordOf(data, 1)}`));
      if (data.includes(TOTAL_SUPPLY_SELECTOR)) return rpcOk(aggregate3Result([ok(u256(1000n * 10n ** 18n)), ok(u256(18))]));
      return rpcOk(aggregate3Result(n === 1 ? [ok(u256(1n * 10n ** 18n))] : [ok(u256(1n * 10n ** 18n)), ok(u256(18))]));
    }) as unknown as typeof fetch;

    const user = insertFomoUser({ handle: '@burst', name: 'Burst' });
    const p1 = trackFomoWalletFromTx(user.id, 'base', CA, TX, deps());
    const p2 = trackFomoWalletFromTx(user.id, 'base', CA, `${TX}ff`, deps());
    release();
    await Promise.all([p1, p2]);
    assert.equal(resolves, 1, 'second same-(user,ca) alert skipped while the first was in flight');
  } finally {
    globalThis.fetch = orig;
  }
});

test('refreshFomoHolding: no wallets → nothing written', async () => {
  const user = insertFomoUser({ handle: '@nowallets', name: 'NoWallets' });
  await refreshFomoHolding(user.id, 'sol', SOL_MINT, deps());
  assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM fomo_holdings WHERE fomo_user_id = ?').get(user.id) as { n: number }).n, 0);
});

test('refreshFomoHolding: unknown supply → amount stored, pct NULL (never a guessed denominator)', async () => {
  const orig = globalThis.fetch;
  try {
    stubEvm([fail()]); // totalSupply reverts
    const user = insertFomoUser({ handle: '@nosupply', name: 'NoSupply' });
    insertFomoUserWallet({ fomo_user_id: user.id, chain: 'base', address: WALLET });
    await refreshFomoHolding(user.id, 'base', CA, deps());
    const h = getDb().prepare('SELECT amount, pct FROM fomo_holdings WHERE fomo_user_id = ?').get(user.id) as { amount: number; pct: number | null };
    assert.equal(h.amount, 250);
    assert.equal(h.pct, null);
  } finally {
    globalThis.fetch = orig;
  }
});

test('refreshFomoHolding: a later re-measure with a second wallet SUMS both and overwrites the one row', async () => {
  const orig = globalThis.fetch;
  try {
    const user = insertFomoUser({ handle: '@sum', name: 'Sum' });
    insertFomoUserWallet({ fomo_user_id: user.id, chain: 'base', address: WALLET });
    stubEvm([ok(u256(1000n * 10n ** 18n))], 100n * 10n ** 18n);
    await refreshFomoHolding(user.id, 'base', CA, deps());

    // second wallet on the same chain/CA: newest measurement sums both wallets
    insertFomoUserWallet({ fomo_user_id: user.id, chain: 'base', address: OTHER_WALLET });
    stubEvm([ok(u256(1000n * 10n ** 18n))], 100n * 10n ** 18n);
    await refreshFomoHolding(user.id, 'base', CA, deps());

    const rows = getDb().prepare('SELECT amount, pct FROM fomo_holdings WHERE fomo_user_id = ?').all(user.id) as { amount: number; pct: number }[];
    assert.equal(rows.length, 1, 'one row per (user, ca, chain)');
    assert.equal(rows[0]!.amount, 200, 'Σ across the user wallets');
    assert.equal(rows[0]!.pct, 20);
  } finally {
    globalThis.fetch = orig;
  }
});
