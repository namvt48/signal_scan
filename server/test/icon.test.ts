import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, insertTrackedCa, listCaTargetsMissingIcon, open } from '../src/db.js';
import { updateTokenMetrics } from '../src/ingest.js';
import { assembleSignals } from '../src/signals.js';
import { chunkAddresses, parseIcons, validatedIconUrl, type DexTokensResponse } from '../src/providers/dexscreener.js';

// Response fixture shaped from the live 2026-09-25 capture (BONK/WIF/POPCAT:
// 3 mints → 30 PAIR-level rows). The endpoint answers per MARKET, so one mint
// spans many pairs and the parser must collapse them to the deepest one.
const MULTI_MINT: DexTokensResponse = {
  pairs: [
    {
      baseToken: { address: 'MINT-BONK', symbol: 'BONK' },
      info: { imageUrl: 'https://cdn.dexscreener.com/cms/images/ba03c0370670d176dc33b' },
      liquidity: { usd: 425_749 },
    },
    {
      baseToken: { address: 'MINT-BONK', symbol: 'BONK' },
      info: { imageUrl: 'https://cdn.dexscreener.com/cms/images/shallow-pair-icon' },
      liquidity: { usd: 1_000 },
    },
    {
      baseToken: { address: 'MINT-BONK', symbol: 'BONK' },
      // Deepest pair but NO imageUrl — must not displace the valid shallower one.
      liquidity: { usd: 9_999_999 },
    },
    {
      baseToken: { address: 'MINT-WIF', symbol: 'WIF' },
      info: { imageUrl: 'https://cdn.dexscreener.com/cms/images/c3788335fe7010d9c32ed' },
      liquidity: { usd: 6_619_224 },
    },
  ],
};

test('parseIcons: pair-level rows collapse to ONE icon per mint, highest liquidity.usd wins', () => {
  const icons = parseIcons(MULTI_MINT);
  assert.equal(icons.size, 2);
  assert.equal(icons.get('MINT-BONK'), 'https://cdn.dexscreener.com/cms/images/ba03c0370670d176dc33b');
  assert.equal(icons.get('MINT-WIF'), 'https://cdn.dexscreener.com/cms/images/c3788335fe7010d9c32ed');
});

test('parseIcons: liquidity arriving as a string still ranks (num coercion)', () => {
  const json = {
    pairs: [
      { baseToken: { address: 'M' }, info: { imageUrl: 'https://cdn.dexscreener.com/a' }, liquidity: { usd: '500.25' } },
      { baseToken: { address: 'M' }, info: { imageUrl: 'https://cdn.dexscreener.com/b' }, liquidity: { usd: '499' } },
    ],
  } as unknown as DexTokensResponse;
  assert.equal(parseIcons(json).get('M'), 'https://cdn.dexscreener.com/a');
});

test('validatedIconUrl: https + allowlisted host passes; everything else is undefined', () => {
  assert.equal(validatedIconUrl('https://cdn.dexscreener.com/cms/images/x'), 'https://cdn.dexscreener.com/cms/images/x');
  // Subdomain of an allowlisted host is allowed (dot-anchored suffix match).
  assert.equal(validatedIconUrl('https://img.cdn.dexscreener.com/x'), 'https://img.cdn.dexscreener.com/x');
  assert.equal(validatedIconUrl('http://cdn.dexscreener.com/x'), undefined, 'non-https must be rejected');
  assert.equal(validatedIconUrl('https://evil.example.com/x.png'), undefined, 'off-allowlist host must be rejected');
  assert.equal(validatedIconUrl('https://cdn.dexscreener.com.evil.tld/x'), undefined, 'suffix-lookalike host must be rejected');
  assert.equal(validatedIconUrl('https://notcdn.dexscreener.com/x'), undefined, 'prefix-lookalike host must be rejected');
  assert.equal(validatedIconUrl('javascript:alert(1)'), undefined);
  assert.equal(validatedIconUrl('not a url'), undefined);
  assert.equal(validatedIconUrl(''), undefined);
  assert.equal(validatedIconUrl(42), undefined);
  assert.equal(validatedIconUrl(undefined), undefined);
});

test('parseIcons: a rejected URL is treated as NO icon — never stored raw', () => {
  const json: DexTokensResponse = {
    pairs: [
      { baseToken: { address: 'M1' }, info: { imageUrl: 'http://cdn.dexscreener.com/x' }, liquidity: { usd: 10 } },
      { baseToken: { address: 'M2' }, info: { imageUrl: 'https://evil.example.com/x.png' }, liquidity: { usd: 10 } },
    ],
  };
  const icons = parseIcons(json);
  assert.equal(icons.size, 0);
});

test('parseIcons: empty/null/absent pairs → empty map, no throw', () => {
  assert.equal(parseIcons({ pairs: null }).size, 0);
  assert.equal(parseIcons({ pairs: [] }).size, 0);
  assert.equal(parseIcons({}).size, 0);
  assert.equal(parseIcons(null as unknown as DexTokensResponse).size, 0);
});

test('parseIcons: junk rows are skipped without dropping the good ones', () => {
  const json = {
    pairs: [
      null,
      { info: { imageUrl: 'https://cdn.dexscreener.com/no-base' }, liquidity: { usd: 5 } },
      { baseToken: { address: '   ' }, info: { imageUrl: 'https://cdn.dexscreener.com/blank-mint' } },
      { baseToken: { address: 'OK' }, info: { imageUrl: 'https://cdn.dexscreener.com/ok' } },
    ],
  } as unknown as DexTokensResponse;
  const icons = parseIcons(json);
  assert.deepEqual([...icons.keys()], ['OK']);
});

test('chunkAddresses: 65 CAs → batches of 30/30/5 (the API hard ceiling)', () => {
  const cas = Array.from({ length: 65 }, (_, i) => `ca${i}`);
  const chunks = chunkAddresses(cas);
  assert.deepEqual(chunks.map((c) => c.length), [30, 30, 5]);
  assert.deepEqual(chunks.flat(), cas, 'chunking must preserve every address exactly once');
  assert.deepEqual(chunkAddresses([]), []);
});

// --- write path: patch → column → DTO (all offline, mirrors symbol-backfill.test.ts) ---

const WINDOW_MS = 30 * 86_400_000;

before(() => {
  open(':memory:');
  insertTrackedCa({ address: 'caNoIcon', chain: 'sol', note: '', entryUsd: 100 });
  insertTrackedCa({ address: 'caIcon', chain: 'sol', note: '', entryUsd: 100 });
  updateTokenMetrics('caIcon', 'sol', { iconUrl: 'https://cdn.dexscreener.com/cms/images/iconic' });
});

test('listCaTargetsMissingIcon: only icon-less tracked CAs, and the set empties once written', () => {
  assert.deepEqual(listCaTargetsMissingIcon(WINDOW_MS).map((c) => c.address), ['caNoIcon']);
  updateTokenMetrics('caNoIcon', 'sol', { iconUrl: 'https://cdn.dexscreener.com/cms/images/late' });
  assert.deepEqual(listCaTargetsMissingIcon(WINDOW_MS), []);
});

test('icon_url patch does not clobber sibling columns (per-endpoint write isolation)', () => {
  updateTokenMetrics('caIcon', 'sol', { price: 1.5, symbol: 'ICO' });
  updateTokenMetrics('caIcon', 'sol', { iconUrl: 'https://cdn.dexscreener.com/cms/images/refreshed' });
  const row = getDb()
    .prepare('SELECT icon_url, price, symbol FROM token_state WHERE ca = ? AND chain = ?')
    .get('caIcon', 'sol') as { icon_url: string | null; price: number | null; symbol: string | null };
  assert.equal(row.icon_url, 'https://cdn.dexscreener.com/cms/images/refreshed');
  assert.equal(row.price, 1.5);
  assert.equal(row.symbol, 'ICO');
});

test('listCaTargetsMissingIcon: a CA older than the window drops out even with icon_url NULL', () => {
  insertTrackedCa({ address: 'caAncient', chain: 'sol', note: '', entryUsd: 100 });
  const old = new Date(Date.now() - 2 * WINDOW_MS).toISOString();
  getDb().prepare('UPDATE tracked_cas SET added_at = ? WHERE address = ?').run(old, 'caAncient');
  assert.deepEqual(listCaTargetsMissingIcon(WINDOW_MS), [], 'expired CA must not be retried forever');
});

test('assembleSignals: iconUrl surfaces in the DTO when stored, absent when NULL', () => {
  insertTrackedCa({ address: 'caDtoNoIcon', chain: 'sol', note: '', entryUsd: 100 });
  const sigs = assembleSignals();
  const withIcon = sigs.find((s) => s.ca === 'caIcon');
  assert.equal(withIcon?.iconUrl, 'https://cdn.dexscreener.com/cms/images/refreshed');
  const noIcon = sigs.find((s) => s.ca === 'caDtoNoIcon');
  assert.ok(noIcon, 'the icon-less CA must still be listed');
  assert.equal('iconUrl' in (noIcon as object), false, 'NULL icon_url must omit the key, not emit null');
});
