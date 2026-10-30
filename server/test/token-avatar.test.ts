import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { test } from 'node:test';
import { renderCaIdenticon, tokenAvatarBytes, validAvatarIdentity } from '../src/token-avatar.js';

const AURA_CA = '6ZjXu9fMvvEWwpZFTvNaGfkYQU48VvHLYWmb5Uqbco3C';
const OTHER_CA = '11111111111111111111111111111111';

function cacheDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE token_avatar_cache (
    chain TEXT NOT NULL, ca TEXT NOT NULL, source_url TEXT, attempt_url TEXT,
    retry_at INTEGER NOT NULL, failures INTEGER NOT NULL, image BLOB NOT NULL,
    PRIMARY KEY (chain, ca)
  )`);
  return db;
}

test('avatar identity validates chain-specific addresses', () => {
  assert.equal(validAvatarIdentity('sol', AURA_CA), true);
  assert.equal(validAvatarIdentity('base', `0x${'a'.repeat(40)}`), true);
  assert.equal(validAvatarIdentity('sol', `0x${'a'.repeat(40)}`), false);
  assert.equal(validAvatarIdentity('unknown', AURA_CA), false);
});

test('token avatar cache normalizes approved image bytes and keys results by chain plus CA', async () => {
  const db = cacheDb();
  const source = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>')).png().toBuffer();
  let fetches = 0;
  const fetcher: typeof fetch = async () => {
    fetches += 1;
    return new Response(source, { headers: { 'content-type': 'image/png' } });
  };
  try {
    const first = await tokenAvatarBytes(db, 'sol', AURA_CA, 'https://gmgn.ai/external-res/aura.webp', 10_000, fetcher);
    const cached = await tokenAvatarBytes(db, 'sol', AURA_CA, 'https://gmgn.ai/external-res/aura.webp', 11_000, fetcher);
    const distinct = await tokenAvatarBytes(db, 'sol', OTHER_CA, 'https://gmgn.ai/external-res/aura.webp', 11_000, fetcher);
    assert.equal(first.subarray(0, 2).toString('hex'), 'ffd8');
    assert.deepEqual(cached, first);
    assert.equal(distinct.subarray(0, 2).toString('hex'), 'ffd8');
    assert.equal(fetches, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM token_avatar_cache').pluck().get(), 2);
    assert.deepEqual(await sharp(first).metadata().then(({ format, width, height }) => ({ format, width, height })), {
      format: 'jpeg', width: 192, height: 192,
    });
  } finally {
    db.close();
  }
});


test('rejected image URL produces a stable CA-specific JPEG without metadata probing', async () => {
  const db = cacheDb();
  let fetches = 0;
  const fetcher: typeof fetch = async () => {
    fetches += 1;
    return new Response('<html>403</html>', { status: 403, headers: { 'content-type': 'text/html' } });
  };
  try {
    const first = await tokenAvatarBytes(db, 'sol', AURA_CA, 'https://gmgn.ai/external-res/aura.webp', 20_000, fetcher);
    const retryWindow = await tokenAvatarBytes(db, 'sol', AURA_CA, 'https://gmgn.ai/external-res/aura.webp', 21_000, fetcher);
    const expected = await renderCaIdenticon('sol', AURA_CA);
    const other = await renderCaIdenticon('sol', OTHER_CA);
    assert.equal(first.subarray(0, 2).toString('hex'), 'ffd8');
    assert.deepEqual(retryWindow, first);
    assert.deepEqual(first, expected);
    assert.notDeepEqual(first, other);
    assert.equal(fetches, 1);
    assert.equal(db.prepare('SELECT failures FROM token_avatar_cache WHERE ca = ?').pluck().get(AURA_CA), 1);
  } finally {
    db.close();
  }
});
