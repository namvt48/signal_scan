// T5 evidence probe (plan evm-base-bsc): Multicall3 encoder golden vector, fixture
// decode raw-hex → token units, one-eth_call-per-wallet wire, decimals-unavailable
// skip+log, primary→fallback failover, and error messages that never leak the
// endpoint URL/key. Offline and deterministic — globalThis.fetch is stubbed; no
// network is ever touched.
//
// Run: cd server && LOG_LEVEL=warn npx tsx ../scripts/t5_evm_holdings_probe.ts 2>&1

import {
  AGGREGATE3_SELECTOR,
  BALANCE_OF_SELECTOR,
  DECIMALS_SELECTOR,
  EvmRpcClient,
  MULTICALL3_ADDRESS,
  decodeAggregate3,
  decodeDecimals,
  decodeUint256,
  encodeAggregate3,
  rawToTokenUnits,
} from '../server/src/providers/evm.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const WETH = '0x4200000000000000000000000000000000000006'; // Base WETH, 18 decimals
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // Base USDC, 6 decimals

const u256 = (n: bigint): string => n.toString(16).padStart(64, '0');

/** Builds the exact `(bool success, bytes returnData)[]` hex Multicall3 returns. */
function aggregate3Result(rs: readonly { success: boolean; returnData: string }[]): string {
  const tuples = rs.map((r) => {
    const data = r.returnData.replace(/^0x/i, '');
    return [u256(r.success ? 1n : 0n), u256(0x40n), u256(BigInt(data.length / 2)), data.padEnd(Math.ceil(data.length / 64) * 64, '0')].join('');
  });
  const offs: string[] = [];
  let at = BigInt(rs.length * 32);
  for (const t of tuples) {
    offs.push(u256(at));
    at += BigInt(t.length / 2);
  }
  return `0x${u256(0x20n)}${u256(BigInt(rs.length))}${offs.join('')}${tuples.join('')}`;
}

const ok = (returnData: string): { success: boolean; returnData: string } => ({ success: true, returnData });
const fail = (): { success: boolean; returnData: string } => ({ success: false, returnData: '0x' });

function wrap(hex: string, width = 96): string {
  const s = hex.startsWith('0x') ? hex.slice(2) : hex;
  const lines: string[] = [];
  for (let i = 0; i < s.length; i += width) lines.push(`      ${s.slice(i, i + width)}`);
  return lines.join('\n');
}

interface RpcBody {
  method: string;
  params: [{ to: string; data: string }, string];
}

function stub(hits: { url: string; body: RpcBody }[], respond: (url: string) => Response): typeof fetch {
  return (async (url: string, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body)) as RpcBody;
    hits.push({ url, body });
    return respond(url);
  }) as unknown as typeof fetch;
}

const ethOk = (result: string): Response =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 });

const HOLDINGS_FIXTURE = aggregate3Result([ok(u256(1500000000000000000n)), ok(u256(1234567n)), ok(u256(18n)), ok(u256(6n))]);

async function main(): Promise<void> {
  const origFetch = globalThis.fetch;
  try {
    console.log('[1] GOLDEN VECTOR — encoder vs real captured Multicall3 aggregate3 calldata');
    console.log('    source: celo-org/celo-monorepo packages/op-tooling/exec/exec-upgrade.sh');
    console.log('    case mainnet-succ-v102 (N=1, allowFailure=false, 0x44-byte callData 14f6b1a3)');
    const golden =
      '0x82ad56cb' +
      u256(0x20n) + u256(1n) + u256(0x20n) +
      '000000000000000000000000fbac162162f4009bb007c6debc36b1dac10af683' +
      u256(0n) + u256(0x60n) + u256(0x44n) +
      '14f6b1a3' + u256(0x2an) +
      '000000000000000000000000c5bd131ceaeb72f15c66418bc2668332ab99de37' +
      '0'.repeat(56);
    const mine = encodeAggregate3([
      {
        target: '0xfbac162162f4009bb007c6debc36b1dac10af683',
        allowFailure: false,
        callData: `0x14f6b1a3${u256(0x2an)}000000000000000000000000c5bd131ceaeb72f15c66418bc2668332ab99de37`,
      },
    ]);
    console.log('    captured:');
    console.log(wrap(golden));
    console.log('    encoded:');
    console.log(wrap(mine));
    console.log(`    BYTE-IDENTICAL: ${mine.toLowerCase() === golden.toLowerCase()}`);

    console.log('\n[2] FIXTURE DECODE — raw aggregate3 result hex → token units');
    console.log('    wallet holds WETH raw=1500000000000000000 (18 dec) + USDC raw=1234567 (6 dec)');
    console.log('    raw response hex:');
    console.log(wrap(HOLDINGS_FIXTURE));
    const rs = decodeAggregate3(HOLDINGS_FIXTURE);
    console.log(`    decodeAggregate3 → ${rs.length} results, success flags [${rs.map((r) => r.success).join(', ')}]`);
    const wethRaw = decodeUint256(rs[0]!.returnData)!;
    const usdcRaw = decodeUint256(rs[1]!.returnData)!;
    const wethDec = decodeDecimals(rs[2]!.returnData)!;
    const usdcDec = decodeDecimals(rs[3]!.returnData)!;
    console.log(`    WETH: raw=${wethRaw} decimals=${wethDec} → amount=${rawToTokenUnits(wethRaw, wethDec)}`);
    console.log(`    USDC: raw=${usdcRaw} decimals=${usdcDec} → amount=${rawToTokenUnits(usdcRaw, usdcDec)}`);

    console.log('\n[3] ONE eth_call PER WALLET — request wire + decoded rows');
    const hits: { url: string; body: RpcBody }[] = [];
    globalThis.fetch = stub(hits, () => ethOk(HOLDINGS_FIXTURE));
    const client = new EvmRpcClient(() => ['https://evm.test']);
    const rows = await client.walletTokenHoldings(WALLET, 'base', [WETH, USDC]);
    console.log(`    requests: ${hits.length} (the whole wallet is ONE batched eth_call)`);
    const { url, body } = hits[0]!;
    const data = body.params[0].data;
    const subCalls = Number(BigInt(`0x${data.slice(10 + 64, 10 + 128)}`));
    console.log(`    POST ${url}  method=${body.method}  block=${body.params[1]}`);
    console.log(`    to=${body.params[0].to}  (Multicall3=${MULTICALL3_ADDRESS}: ${body.params[0].to === MULTICALL3_ADDRESS})`);
    console.log(`    data: selector=${data.slice(0, 10)} (aggregate3=0x${AGGREGATE3_SELECTOR}: ${data.slice(0, 10) === `0x${AGGREGATE3_SELECTOR}`}), sub-calls=${subCalls}`);
    console.log(`          balanceOf(0x${BALANCE_OF_SELECTOR}) × ${(data.match(new RegExp(BALANCE_OF_SELECTOR, 'g')) ?? []).length}, decimals(0x${DECIMALS_SELECTOR}) × ${(data.match(new RegExp(DECIMALS_SELECTOR, 'g')) ?? []).length}`);
    console.log(wrap(data));
    console.log(`    rows: ${JSON.stringify(rows)}`);

    console.log('\n[4] DECIMALS UNAVAILABLE — balance>0 skipped + logged (warn on stderr below); balance 0 still lands');
    globalThis.fetch = stub([], () => ethOk(aggregate3Result([ok(u256(1500000000000000000n)), ok(u256(0n)), fail(), fail()])));
    const rows4 = await new EvmRpcClient(() => ['https://evm.test']).walletTokenHoldings(WALLET, 'base', [WETH, USDC]);
    console.log(`    rows: ${JSON.stringify(rows4)}  (WETH skipped — no guessed scale; USDC zero kept)`);

    console.log('\n[5] FAILOVER — dead primary (HTTP 503) → fallback serves the SAME call (plan R2)');
    const hits5: { url: string; body: RpcBody }[] = [];
    globalThis.fetch = stub(hits5, (u) => (u.includes('dead') ? new Response('nope', { status: 503 }) : ethOk(aggregate3Result([ok(u256(1500000000000000000n)), ok(u256(18n))]))));
    const rows5 = await new EvmRpcClient(() => ['https://dead.example', 'https://live.example']).walletTokenHoldings(WALLET, 'base', [WETH]);
    console.log(`    hit order: ${hits5.map((h) => h.url).join(' → ')}`);
    console.log(`    rows from fallback: ${JSON.stringify(rows5)}  (never dropped)`);

    console.log('\n[6] NO LEAK — both endpoints dead, primary URL carries ?key=SECRETTOKEN123');
    globalThis.fetch = stub([], () => new Response('nope', { status: 503 }));
    try {
      await new EvmRpcClient(() => ['https://rpc.example/?key=SECRETTOKEN123']).walletTokenHoldings(WALLET, 'base', [WETH]);
      console.log('    UNEXPECTED: no error thrown');
    } catch (e) {
      const msg = (e as Error).message;
      console.log(`    error message: ${JSON.stringify(msg)}`);
      console.log(`    contains SECRETTOKEN123: ${msg.includes('SECRETTOKEN123')}`);
      console.log(`    contains rpc.example:    ${msg.includes('rpc.example')}`);
    }
  } finally {
    globalThis.fetch = origFetch;
  }
}

await main();
