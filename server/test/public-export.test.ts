import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/api.js';
import { appendAlertMetricObservation, getDb, insertFomoTrade, insertFomoUser, insertTrackedCa, insertWallet, open, upsertFomoHolding, upsertFomoPosition, upsertFomoPositionSnapshot } from '../src/db.js';
import { insertSnapshot, insertTrades, replaceWalletBalances, upsertTokenInfo } from '../src/ingest.js';
import { createTestAuth } from './auth-testkit.js';

const exportToken = 'public-export-only-test-secret';
const now = Date.now();
let server: Server;
let base = '';
let adminToken = '';
before(async () => {
  open(':memory:');
  insertTrackedCa({ address: 'public-test-ca', chain: 'sol', note: 'must-not-export', entryUsd: 100 });
  const walletId = insertWallet({ address: 'public-test-wallet', name: 'PublicTest', tags: [], chain: 'sol', source: 'test' }).id;
  upsertTokenInfo({
    ca: 'public-test-ca', chain: 'sol', price: 0.001, holders: 0, volume24h: 0, buyVol24h: 0,
    sellVol24h: 0, marketCap: 0, liquidity: 0, supply: 1e9, freshCount: 0, top10Rate: 0,
  });
  getDb().prepare('UPDATE token_state SET x_handle = ? WHERE ca = ? AND chain = ?').run('test_x', 'public-test-ca', 'sol');
  replaceWalletBalances(walletId, 'sol', [{ ca: 'public-test-ca', amount: 1e7 }]);
  insertTrades(walletId, [{ tx: 'public-test-tx', ts: now, side: 'buy', ca: 'public-test-ca', chain: 'sol', amountUsd: 100, price: 0.001 }], 'watch');
  insertSnapshot('public-test-ca', 'sol', [{ address: 'holder-1', amountPct: 0.5, addrType: 1, isNew: false, usdValue: 500 }], now);
  appendAlertMetricObservation(getDb(), 'public-test-ca', 'sol', 'trackerBuy', 100, now);
  const auth = await createTestAuth();
  adminToken = await auth.signToken(auth.adminEmail);
  const app = createApp('public-export-test', { ...auth.deps, publicExportToken: exportToken });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

async function get(path: string, token: string): Promise<Response> {
  return fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
}

test('export credential reads only the sanitized internal export route', async () => {
  assert.equal((await get('/api/internal/public-export?resource=tokens', exportToken)).status, 200);
  assert.equal((await get('/api/signals', exportToken)).status, 403);
  assert.equal((await fetch(`${base}/api/tracked-cas`, { method: 'POST', headers: { authorization: `Bearer ${exportToken}`, 'content-type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await get('/api/internal/public-export?resource=tokens', adminToken)).status, 403);
  const response = await get('/api/internal/public-export?resource=tokens', exportToken);
  const body = await response.json() as { data: Array<Record<string, unknown>> };
  const token = body.data.find((item) => item.ca === 'public-test-ca');
  assert.ok(token);
  assert.equal('note' in token, false);
  assert.equal('fomoUsers' in token, false);
  assert.equal('trackedWallets' in token, false);
});

test('internal export returns 404 for unknown tokens', async () => {
  assert.equal((await get('/api/internal/public-export?resource=token&chain=sol&ca=missing-ca', exportToken)).status, 404);
  assert.equal((await get('/api/internal/public-export?resource=detail&chain=sol&ca=missing-ca', exportToken)).status, 404);
});

test('exports tracked holding and dashboard token fields', async () => {
  const tokenResponse = await get('/api/internal/public-export?resource=token&chain=sol&ca=public-test-ca', exportToken);
  assert.equal(tokenResponse.status, 200);
  const token = await tokenResponse.json() as {
    iconUrl: string | null;
    xHandle: string | null;
    metrics: { trackedHolding: number; trackedInflow: number; trackedActivityAt: number };
    balanceRange: unknown;
  };
  // 1e7 tokens / 1e9 supply = 1%.
  assert.equal(token.metrics.trackedHolding, 1);
  assert.equal(token.metrics.trackedInflow, 100);
  assert.equal(token.metrics.trackedActivityAt, now);
  assert.equal(token.iconUrl, '/api/token-avatar/sol/public-test-ca');
  assert.equal(token.xHandle, 'test_x');
  assert.equal(token.balanceRange, null);

  const alertsResponse = await get('/api/internal/public-export?resource=alerts&limit=10', exportToken);
  assert.equal(alertsResponse.status, 200);
  const alerts = await alertsResponse.json() as { data: Array<{ ca: string; snapshot: { trackedHoldingPct: number | null; iconUrl: string | null; xHandle: string | null } }> };
  const alert = alerts.data.find((item) => item.ca === 'public-test-ca');
  assert.ok(alert);
  assert.equal(alert.snapshot.trackedHoldingPct, 1);
  assert.equal(alert.snapshot.iconUrl, '/api/token-avatar/sol/public-test-ca');
  assert.equal(alert.snapshot.xHandle, 'test_x');
});

test('exports FOMO users, token stats, trades, positions and holdings', async () => {
  const user = insertFomoUser({
    handle: '@fomo-public', name: 'FomoPublic', tags: ['whale'], clan: 'a',
    wallet_solana: 'sol-wallet', wallet_evm: '0xwallet', source: 'test',
  });
  insertFomoTrade({
    fomo_user_id: user.id, event_id: 'evt-public-1', ca: '0xfomopublic', chain: 'base', type: 'buy',
    usd_value: 200, trade_usd: 100, price: 0.001, token: 'FOMO', ts: now - 1_000,
  });
  upsertFomoPosition({
    fomo_user_id: user.id, ca: '0xfomopublic', chain: 'base', trade_id: 'trade-public-1', status: 'open',
    amount: 1000, cost_basis_usd: 100, avg_entry_price: 0.1, price_usd: 0.2,
    realized_pnl_usd: 0, unrealized_pnl_usd: 100, fetched_at: now,
  });
  upsertFomoHolding({
    fomo_user_id: user.id, ca: '0xfomopublic', chain: 'base', wallet: '0xwallet',
    amount: 1000, pct: 0.01, measured_at: now,
  });
  upsertFomoHolding({
    fomo_user_id: user.id, ca: '0xholdingonly', chain: 'base', wallet: '0xwallet',
    amount: 500, pct: 0.005, measured_at: now,
  });
  // A FOMO trade on a TRACKED CA makes the user part of that token's table.
  insertFomoTrade({
    fomo_user_id: user.id, event_id: 'evt-public-2', ca: 'public-test-ca', chain: 'sol', type: 'buy',
    usd_value: 50, trade_usd: 40, price: 0.001, token: 'PUB', ts: now - 2_000,
  });
  upsertFomoPositionSnapshot({ fomo_user_id: user.id, checked_at: now - 1 });
  getDb().prepare(
    'INSERT INTO fomo_api_balance_snapshots (fomo_user_id, checked_at, captured_at, complete, truncated, available) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(user.id, now - 2, now - 30, 1, 0, 1);

  const usersResponse = await get('/api/internal/public-export?resource=fomoUsers&limit=10', exportToken);
  assert.equal(usersResponse.status, 200);
  const users = await usersResponse.json() as { data: Array<{ id: string; handle: string; name: string; tags: string[]; clan: string | null; userId: string | null; walletSolana: string | null; walletEvm: string | null; source: string }>; nextOffset: number | null };
  const exported = users.data.find((item) => item.id === user.id);
  assert.ok(exported);
  assert.deepEqual(exported, {
    id: user.id, handle: '@fomo-public', name: 'FomoPublic', tags: ['whale'], clan: 'a',
    userId: null, walletSolana: 'sol-wallet', walletEvm: '0xwallet', source: 'test',
  });

  const statsResponse = await get('/api/internal/public-export?resource=fomoTokenStats&chain=base&ca=0xfomopublic', exportToken);
  assert.equal(statsResponse.status, 200);
  const stats = await statsResponse.json() as { data: Array<{ handle: string; buyUsd: number | null; sellUsd: number | null; buys: number; sells: number; trades: number; lastTs: number; holdingAmount?: number; holdingPct?: number; balUsd?: number }> };
  const stat = stats.data.find((item) => item.handle === '@fomo-public');
  assert.ok(stat);
  assert.equal(stat.buyUsd, 100);
  assert.equal(stat.sellUsd, 0);
  assert.equal(stat.buys, 1);
  assert.equal(stat.sells, 0);
  assert.equal(stat.trades, 1);
  assert.equal(stat.lastTs, now - 1_000);
  assert.equal(stat.holdingAmount, 1000);
  // balUsd = amount × the position's own price; holdingPct divides by market cap
  // (token_state has a zero market cap here, so the percentage stays unknown).
  assert.equal(stat.balUsd, 200);
  assert.equal(stat.holdingPct, undefined);

  const tradesResponse = await get(`/api/internal/public-export?resource=fomoTrades&userId=${user.id}&from=${now - 86_400_000}&to=${now + 1}&limit=10`, exportToken);
  assert.equal(tradesResponse.status, 200);
  const trades = await tradesResponse.json() as { data: Array<{ id: number; userId: string; handle: string; eventId: string; ca: string; chain: string; side: string; usdValue: number | null; tradeUsd: number | null; price: number | null; token: string | null; ts: number; source: string }>; nextId: number | null };
  assert.equal(trades.data.length, 2);
  assert.deepEqual(trades.data[0], {
    id: 1, userId: user.id, handle: '@fomo-public', eventId: 'evt-public-1', ca: '0xfomopublic',
    chain: 'base', side: 'buy', usdValue: 200, tradeUsd: 100, price: 0.001, token: 'FOMO',
    ts: now - 1_000, source: 'fomo',
  });
  assert.deepEqual(trades.data[1], {
    id: 2, userId: user.id, handle: '@fomo-public', eventId: 'evt-public-2', ca: 'public-test-ca',
    chain: 'sol', side: 'buy', usdValue: 50, tradeUsd: 40, price: 0.001, token: 'PUB',
    ts: now - 2_000, source: 'fomo',
  });
  assert.equal(trades.nextId, null);

  const positionsResponse = await get(`/api/internal/public-export?resource=fomoPositions&userId=${user.id}`, exportToken);
  assert.equal(positionsResponse.status, 200);
  const positions = await positionsResponse.json() as { data: Array<{ ca: string; chain: string; tradeId: string | null; status: string | null; amount: number | null; costBasisUsd: number | null; avgEntryPrice: number | null; priceUsd: number | null; realizedPnlUsd: number | null; unrealizedPnlUsd: number | null; fetchedAt: number; holdings: Array<{ source: string; amount: number | null; pct: number | null; capturedAt: number; wallet?: string }> }>; freshness: { balances: { checkedAt: number; capturedAt: number | null; complete: boolean; truncated: boolean; available: boolean } | null; positions: { checkedAt: number } | null } };
  assert.deepEqual(positions.freshness, {
    balances: { checkedAt: now - 2, capturedAt: now - 30, complete: true, truncated: false, available: true },
    positions: { checkedAt: now - 1 },
  });
  const positioned = positions.data.find((item) => item.ca === '0xfomopublic');
  assert.ok(positioned);
  assert.equal(positioned.tradeId, 'trade-public-1');
  assert.equal(positioned.costBasisUsd, 100);
  assert.deepEqual(positioned.holdings, [{ source: 'rpc', amount: 1000, pct: 0.01, capturedAt: now, wallet: '0xwallet' }]);
  const holdingOnly = positions.data.find((item) => item.ca === '0xholdingonly');
  assert.ok(holdingOnly);
  assert.equal(holdingOnly.fetchedAt, 0);
  assert.deepEqual(holdingOnly.holdings, [{ source: 'rpc', amount: 500, pct: 0.005, capturedAt: now, wallet: '0xwallet' }]);

  const tokensResponse = await get('/api/internal/public-export?resource=fomoTokens&limit=20', exportToken);
  assert.equal(tokensResponse.status, 200);
  const table = await tokensResponse.json() as { generatedAt: number; data: Array<{ ca: string; chain: string; fomoUsers: Array<{ handle: string; buyUsd: number | null }> }>; nextOffset: number | null };
  const tokenRow = table.data.find((item) => item.ca === 'public-test-ca' && item.chain === 'sol');
  assert.ok(tokenRow);
  const tokenStat = tokenRow.fomoUsers.find((item) => item.handle === '@fomo-public');
  assert.ok(tokenStat);
  assert.equal(tokenStat.buyUsd, 40);
  assert.equal(table.nextOffset, null);

  const singleResponse = await get('/api/internal/public-export?resource=fomoToken&chain=sol&ca=public-test-ca', exportToken);
  assert.equal(singleResponse.status, 200);
  const single = await singleResponse.json() as { ca: string; fomoUsers: Array<{ handle: string }> };
  assert.equal(single.fomoUsers[0]?.handle, '@fomo-public');
  assert.equal((await get('/api/internal/public-export?resource=fomoToken&chain=sol&ca=missing-ca', exportToken)).status, 404);
});

test('exports token detail and balance series resources', async () => {
  const detailResponse = await get('/api/internal/public-export?resource=detail&chain=sol&ca=public-test-ca', exportToken);
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json() as {
    supply: number;
    top100SupplyPct: number | null;
    medianHolderAmount: number | null;
    snapshotAt: number | null;
    top100: Array<{ address: string; percentOwnership: number; balance: number; chg24h: number | null; name: string | null }>;
  };
  assert.equal(detail.supply, 1e9);
  assert.equal(detail.top100SupplyPct, 50);
  assert.equal(detail.medianHolderAmount, 5e8);
  assert.equal(detail.snapshotAt, now);
  assert.deepEqual(detail.top100, [{
    address: 'holder-1', percentOwnership: 50, balance: 5e8,
    balanceUsd: 500, addrType: 1, isNew: false, chg24h: null, name: null,
  }]);

  const balanceResponse = await get('/api/internal/public-export?resource=balance&chain=sol&ca=public-test-ca&window=day', exportToken);
  assert.equal(balanceResponse.status, 200);
  const balance = await balanceResponse.json() as { source: string; points: Array<{ t: number; total: number; totalUsd: number | null; holders: number | null; inflow: number | null }> };
  assert.equal(balance.source, 'snapshots');
  assert.deepEqual(balance.points, [{ t: now, total: 5e8, totalUsd: 500, holders: null, inflow: null }]);
});
