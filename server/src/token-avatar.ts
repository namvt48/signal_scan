import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import sharp from 'sharp';
import { canonicalCa, CHAINS, EVM_ADDRESS, isSolanaAddress, type Chain } from './shared/chain.js';
import { validatedIconUrl } from './providers/dexscreener.js';

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const AVATAR_SIZE = 192;
const AVATAR_CACHE_MS = 24 * 60 * 60 * 1000;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 3_600_000;
interface ActiveAvatarLoad {
  sourceUrl: string | null;
  requestId: number;
  promise: Promise<Buffer>;
}
const inflight = new WeakMap<Database.Database, Map<string, ActiveAvatarLoad>>();
let nextRequestId = 0;

interface CachedAvatar {
  source_url: string | null;
  attempt_url: string | null;
  retry_at: number;
  failures: number;
  image: Buffer;
}

export function validAvatarIdentity(chain: unknown, ca: unknown): chain is Chain {
  if (typeof chain !== 'string' || !(CHAINS as readonly string[]).includes(chain) || typeof ca !== 'string') return false;
  return chain === 'sol' ? isSolanaAddress(ca) : EVM_ADDRESS.test(ca);
}

export async function tokenAvatarBytes(
  db: Database.Database,
  chain: Chain,
  rawCa: string,
  rawUrl: unknown,
  now = Date.now(),
  fetcher: typeof fetch = fetch,
): Promise<Buffer> {
  const ca = canonicalCa(rawCa, chain);
  const sourceUrl = validatedIconUrl(rawUrl) ?? null;
  const key = `${chain}\0${ca}`;
  let databaseLoads = inflight.get(db);
  if (!databaseLoads) {
    databaseLoads = new Map();
    inflight.set(db, databaseLoads);
  }
  const active = databaseLoads.get(key);
  if (active?.sourceUrl === sourceUrl) return active.promise;
  const requestId = ++nextRequestId;
  const isCurrent = () => databaseLoads.get(key)?.requestId === requestId;
  const pending = loadAvatar(db, chain, ca, sourceUrl, now, fetcher, isCurrent);
  databaseLoads.set(key, { sourceUrl, requestId, promise: pending });
  try {
    return await pending;
  } finally {
    if (databaseLoads.get(key)?.requestId === requestId) {
      databaseLoads.delete(key);
      if (databaseLoads.size === 0) inflight.delete(db);
    }
  }
}


async function loadAvatar(
  db: Database.Database,
  chain: Chain,
  ca: string,
  sourceUrl: string | null,
  now: number,
  fetcher: typeof fetch,
  isCurrent: () => boolean,
): Promise<Buffer> {
  const read = db.prepare('SELECT source_url, attempt_url, retry_at, failures, image FROM token_avatar_cache WHERE chain = ? AND ca = ?');
  const cached = read.get(chain, ca) as CachedAvatar | undefined;
  if (cached && cached.source_url === sourceUrl && cached.retry_at > now) return Buffer.from(cached.image);
  if (sourceUrl === null) {
    if (cached) return Buffer.from(cached.image);
    const image = await renderCaIdenticon(chain, ca);
    if (isCurrent()) saveCache(db, chain, ca, null, null, now + AVATAR_CACHE_MS, 0, image);
    return image;
  }
  try {
    const image = await fetchAndNormalize(sourceUrl, fetcher);
    if (isCurrent()) saveCache(db, chain, ca, sourceUrl, sourceUrl, now + AVATAR_CACHE_MS, 0, image);
    return image;
  } catch {
    // Keep the last valid image or serve the deterministic identicon.
  }
  const failures = (cached?.source_url === sourceUrl ? cached.failures : 0) + 1;
  const retryAt = now + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(failures - 1, 6));
  const image = cached ? Buffer.from(cached.image) : await renderCaIdenticon(chain, ca);
  if (isCurrent()) saveCache(db, chain, ca, sourceUrl, sourceUrl, retryAt, failures, image);
  return image;
}


async function fetchAndNormalize(url: string, fetcher: typeof fetch): Promise<Buffer> {
  const response = await fetcher(url, {
    redirect: 'manual',
    headers: { Accept: 'image/jpeg,image/png,image/webp,image/avif' },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok || response.status >= 300 || response.body === null) throw new Error('avatar_fetch_rejected');
  const mime = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (mime !== 'image/jpeg' && mime !== 'image/png' && mime !== 'image/webp' && mime !== 'image/avif') {
    throw new Error('avatar_content_type_rejected');
  }
  const source = await readBounded(response.body, MAX_SOURCE_BYTES);
  const { data, info } = await sharp(source, { failOn: 'warning', limitInputPixels: 5_000_000, pages: 1 })
    .rotate()
    .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'contain', withoutEnlargement: true, background: '#101713' })
    .flatten({ background: '#101713' })
    .jpeg({ quality: 88, progressive: true })
    .timeout({ seconds: 5 })
    .toBuffer({ resolveWithObject: true });
  if (info.width < 1 || info.height < 1 || data.byteLength > MAX_SOURCE_BYTES) throw new Error('avatar_output_invalid');
  return data;
}

async function readBounded(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('avatar_source_too_large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks, size);
}

export async function renderCaIdenticon(chain: Chain, ca: string): Promise<Buffer> {
  const digest = createHash('sha256').update(`${chain}\0${ca}`).digest();
  const color = `#${digest[0]!.toString(16).padStart(2, '0')}${digest[1]!.toString(16).padStart(2, '0')}${digest[2]!.toString(16).padStart(2, '0')}`;
  let cells = '';
  for (let y = 0; y < 5; y += 1) {
    for (let x = 0; x < 3; x += 1) {
      const bit = y * 3 + x;
      if ((digest[3 + (bit >> 3)]! & (1 << (bit & 7))) === 0) continue;
      for (const column of x === 2 ? [x] : [x, 4 - x]) {
        cells += `<rect x="${column * 32 + 3}" y="${y * 32 + 3}" width="26" height="26" rx="7"/>`;
      }
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><rect width="160" height="160" rx="32" fill="#101713"/><g fill="${color}">${cells}</g></svg>`;
  return sharp(Buffer.from(svg), { limitInputPixels: 50_000 }).jpeg({ quality: 88 }).toBuffer();
}

function saveCache(
  db: Database.Database,
  chain: Chain,
  ca: string,
  sourceUrl: string | null,
  attemptUrl: string | null,
  retryAt: number,
  failures: number,
  image: Buffer,
): void {
  db.prepare(`INSERT INTO token_avatar_cache (chain, ca, source_url, attempt_url, retry_at, failures, image)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chain, ca) DO UPDATE SET source_url = excluded.source_url, attempt_url = excluded.attempt_url,
      retry_at = excluded.retry_at, failures = excluded.failures, image = excluded.image`)
    .run(chain, ca, sourceUrl, attemptUrl, retryAt, failures, image);
}
