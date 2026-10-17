import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import sharp from 'sharp';
import { canonicalCa, CHAINS, EVM_ADDRESS, isSolanaAddress, type Chain } from './shared/chain.js';
import { validatedIconUrl } from './providers/dexscreener.js';

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_METADATA_BYTES = 512 * 1024;
const AVATAR_SIZE = 192;
const AVATAR_CACHE_MS = 24 * 60 * 60 * 1000;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 3_600_000;
const JUPITER_ICON_HOST = 'pub-03d440fb1e034bbdae70fd623f58ea37.r2.dev';
const inflight = new Map<string, Promise<Buffer>>();

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
  const active = inflight.get(key);
  if (active !== undefined) return active;
  const pending = loadAvatar(db, chain, ca, sourceUrl, now, fetcher);
  inflight.set(key, pending);
  try {
    return await pending;
  } finally {
    if (inflight.get(key) === pending) inflight.delete(key);
  }
}

async function loadAvatar(
  db: Database.Database,
  chain: Chain,
  ca: string,
  sourceUrl: string | null,
  now: number,
  fetcher: typeof fetch,
): Promise<Buffer> {
  const read = db.prepare('SELECT source_url, attempt_url, retry_at, failures, image FROM token_avatar_cache WHERE chain = ? AND ca = ?');
  const cached = read.get(chain, ca) as CachedAvatar | undefined;
  if (cached !== undefined && cached.source_url === sourceUrl && cached.retry_at > now) return Buffer.from(cached.image);

  if (sourceUrl !== null) {
    try {
      const image = await fetchAndNormalize(sourceUrl, fetcher);
      saveCache(db, chain, ca, sourceUrl, sourceUrl, now + AVATAR_CACHE_MS, 0, image);
      return image;
    } catch {
      // Try exact-address metadata next; never pass upstream error bytes through.
    }
  }

  let attemptUrl = sourceUrl;
  if (chain === 'sol') {
    try {
      const fallbackUrl = await fetchJupiterIcon(ca, fetcher);
      if (fallbackUrl === null) {
        const image = cached === undefined ? await renderCaIdenticon(chain, ca) : Buffer.from(cached.image);
        saveCache(db, chain, ca, sourceUrl, sourceUrl, now + AVATAR_CACHE_MS, 0, image);
        return image;
      }
      attemptUrl = fallbackUrl;
      const image = await fetchAndNormalize(fallbackUrl, fetcher);
      saveCache(db, chain, ca, sourceUrl, fallbackUrl, now + AVATAR_CACHE_MS, 0, image);
      return image;
    } catch {
      // Keep the last valid image for this CA or use its deterministic identicon.
    }
  }

  const failures = (cached?.failures ?? 0) + 1;
  const retryAt = now + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(failures - 1, 6));
  const image = cached === undefined ? await renderCaIdenticon(chain, ca) : Buffer.from(cached.image);
  saveCache(db, chain, ca, sourceUrl, attemptUrl, retryAt, failures, image);
  return image;
}

async function fetchJupiterIcon(ca: string, fetcher: typeof fetch): Promise<string | null> {
  const endpoint = new URL('https://lite-api.jup.ag/tokens/v2/search');
  endpoint.searchParams.set('query', ca);
  const response = await fetcher(endpoint, {
    redirect: 'manual',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(5_000),
  });
  const mime = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (!response.ok || response.status >= 300 || mime !== 'application/json' || response.body === null) {
    throw new Error('avatar_metadata_fetch_rejected');
  }
  const payload: unknown = JSON.parse((await readBounded(response.body, MAX_METADATA_BYTES)).toString('utf8'));
  if (!Array.isArray(payload)) return null;
  for (const item of payload) {
    if (typeof item !== 'object' || item === null || !('id' in item) || !('icon' in item)) continue;
    if (item.id !== ca) continue;
    return validatedJupiterIconUrl(item.icon);
  }
  return null;
}

function validatedJupiterIconUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname !== JUPITER_ICON_HOST || url.username !== '' || url.password !== '') {
      return null;
    }
    const filename = url.pathname.startsWith('/logos/') ? url.pathname.slice('/logos/'.length) : '';
    if (!/^[a-f0-9]{64}[.]png$/.test(filename) || url.search !== '' || url.hash !== '') return null;
    return url.toString();
  } catch {
    return null;
  }
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
