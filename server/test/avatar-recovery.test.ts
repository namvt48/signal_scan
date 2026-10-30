import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { test } from 'node:test';
import { renderCaIdenticon, tokenAvatarBytes } from '../src/token-avatar.js';

const CA = '6ZjXu9fMvvEWwpZFTvNaGfkYQU48VvHLYWmb5Uqbco3C';
const ICON = 'https://gmgn.ai/external-res/recovered.png';
const OLD_ICON = 'https://gmgn.ai/external-res/old.png';
function cacheDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE token_avatar_cache (
    chain TEXT NOT NULL, ca TEXT NOT NULL, source_url TEXT, attempt_url TEXT,
    retry_at INTEGER NOT NULL, failures INTEGER NOT NULL, image BLOB NOT NULL,
    PRIMARY KEY(chain,ca)
  )`);
  return db;
}
const logo = () => sharp({ create: { width: 32, height: 32, channels: 3, background: '#22aa55' } }).png().toBuffer();

test('avatar uses only periodic-sweep icon URLs and replaces the placeholder when one arrives', async () => {
  const db = cacheDb();
  const png = await logo();
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    requests.push(String(input));
    return new Response(png, { headers: { 'content-type': 'image/png' } });
  };
  try {
    const placeholder = await tokenAvatarBytes(db, 'sol', CA, null, 0, fetcher);
    assert.deepEqual(placeholder, await renderCaIdenticon('sol', CA));
    assert.deepEqual(await tokenAvatarBytes(db, 'sol', CA, null, 30_000, fetcher), placeholder);
    assert.equal(requests.length, 0, 'missing sweep metadata must not trigger an avatar-provider query');

    const recovered = await tokenAvatarBytes(db, 'sol', CA, ICON, 30_001, fetcher);
    assert.notDeepEqual(recovered, placeholder);
    assert.deepEqual(requests, [ICON], 'only download the image URL already supplied by the periodic sweep');
    assert.deepEqual(await tokenAvatarBytes(db, 'sol', CA, ICON, 30_002, fetcher), recovered);
    assert.equal(requests.length, 1, 'the normalized image is cached');
    const row = db.prepare('SELECT source_url, attempt_url, failures FROM token_avatar_cache WHERE chain = ? AND ca = ?')
      .get('sol', CA) as { source_url: string | null; attempt_url: string | null; failures: number };
    assert.deepEqual(row, { source_url: ICON, attempt_url: ICON, failures: 0 });
  } finally { db.close(); }
});

test('a newer periodic icon URL cannot be overwritten by an older image download', async () => {
  const db = cacheDb();
  const oldPng = await logo();
  const newPng = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#aa2255' } }).png().toBuffer();
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const fetcher: typeof fetch = async (input) => {
    if (String(input) === OLD_ICON) { entered(); await blocked; return new Response(oldPng, { headers: { 'content-type': 'image/png' } }); }
    return new Response(newPng, { headers: { 'content-type': 'image/png' } });
  };
  try {
    const old = tokenAvatarBytes(db, 'sol', CA, OLD_ICON, 0, fetcher);
    await started;
    const fresh = tokenAvatarBytes(db, 'sol', CA, ICON, 1, fetcher);
    release();
    const [oldImage, freshImage] = await Promise.all([old, fresh]);
    assert.notDeepEqual(oldImage, freshImage);
    assert.deepEqual(await tokenAvatarBytes(db, 'sol', CA, ICON, 2, fetcher), freshImage);
    assert.equal(db.prepare('SELECT source_url FROM token_avatar_cache').pluck().get(), ICON);
  } finally { db.close(); }
});

test('avatar requests in different databases cannot share another instance image', async () => {
  const first = cacheDb();
  const second = cacheDb();
  const png = await logo();
  const source: typeof fetch = async () => new Response(png, { headers: { 'content-type': 'image/png' } });
  const noProviderCalls: typeof fetch = async () => { throw new Error('no periodic icon URL should mean no fetch'); };
  try {
    const [real, mock] = await Promise.all([
      tokenAvatarBytes(first, 'sol', CA, ICON, 0, source),
      tokenAvatarBytes(second, 'sol', CA, null, 0, noProviderCalls),
    ]);
    assert.notDeepEqual(real, mock);
    assert.deepEqual(mock, await renderCaIdenticon('sol', CA));
  } finally { first.close(); second.close(); }
});

