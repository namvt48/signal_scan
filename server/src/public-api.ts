import { installGracefulShutdown } from './http-lifecycle.js';
import { createServer, type Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import express, { type Express } from 'express';
import { config } from './config.js';
import type { PublicAlert } from './public-api-contract.js';

const WINDOW_MS = 60_000;
const RESPONSE_CACHE_MAX_ENTRIES = 512;
const RESPONSE_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const REQUESTS_PER_WINDOW = 120;
const MAX_PAGE = 100;
const INTERNAL_TIMEOUT_MS = 10_000;
const WS_POLL_MS = 500;
const WS_MAX_BUFFERED_BYTES = 1_048_576;
const WS_PAGE_SIZE = 100;
const MAX_WS_CONNECTIONS = 64;
const MAX_CONCURRENT = 24;
const CHAINS = ['sol', 'base', 'bsc', 'robinhood'] as const;
/** FOMO data additionally tracks `eth`; token/watch endpoints stay on CHAINS. */
const FOMO_CHAINS = [...CHAINS, 'eth'] as const;
/** Backend returned 404; only surfaced when the caller opts in via `preserveNotFound`. */
const NOT_FOUND = Symbol('backend-not-found');
type InternalResponse = unknown | null | typeof NOT_FOUND;
interface AlertStream {
  path: string;
  baseUrl: string | undefined;
  origin: 'main' | 'fomo';
  clients: Map<WebSocket, { cursor: number; alive: boolean }>;
  polling: boolean;
  closing?: boolean;
}
interface WindowState { start: number; count: number }

function parsePage(value: unknown, fallback: number): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}
function parseTimeRange(fromRaw: unknown, toRaw: unknown): { from: number; to: number } | null {
  const now = fromRaw === undefined && toRaw === undefined ? Math.floor(Date.now() / 1000) * 1000 : Date.now();
  const from = parsePage(fromRaw, now - 86_400_000);
  const to = parsePage(toRaw, now);
  return from !== null && to !== null && from >= 0 && to > from && to - from <= 31 * 86_400_000 ? { from, to } : null;
}

export function createPublicApiServer(options: { internalUrl?: string; internalToken?: string; fomoInternalUrl?: string; heartbeatIntervalMs?: number } = {}): Server {
  const app = createPublicApiApp(options);
  const server = createServer(app);
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  const token = options.internalToken ?? config.publicApiExportToken;
  const streams: Record<string, AlertStream> = {
    '/api/v1/ws': { path: '/api/v1/ws', baseUrl: options.internalUrl ?? config.publicApiInternalUrl, origin: 'main', clients: new Map(), polling: false },
    '/api/v1/fomo/ws': { path: '/api/v1/fomo/ws', baseUrl: options.fomoInternalUrl ?? config.publicApiFomoInternalUrl, origin: 'fomo', clients: new Map(), polling: false },
  };
  let reservedConnections = 0;
  server.on('drain', () => {
    draining = true;
    app.locals.draining = true;
    for (const stream of Object.values(streams)) {
      for (const ws of stream.clients.keys()) ws.close(1012, 'service restarting');
      stream.clients.clear();
    }
  });

  let draining = false;
  server.on('upgrade', (request, socket, head) => {
    let pathname: string;
    let requestedCursor: number | undefined;
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      pathname = url.pathname;
      if (url.searchParams.has('after_id')) {
        const value = url.searchParams.get('after_id')!;
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
          socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
          return;
        }
        requestedCursor = Number(value);
      }
    }
    catch { socket.destroy(); return; }
    if (draining) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (streams[pathname] === undefined) { socket.destroy(); return; }
    if (reservedConnections >= MAX_WS_CONNECTIONS) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    reservedConnections++;
    const releaseReservation = () => { reservedConnections--; };
    socket.once('close', releaseReservation);
    sockets.handleUpgrade(request, socket, head, (ws) => {
      (ws as WebSocket & { requestedCursor?: number }).requestedCursor = requestedCursor;
      sockets.emit('connection', ws, request);
    });
  });
  sockets.on('connection', (ws, request) => {
    let stream: AlertStream | undefined;
    try { stream = streams[new URL(request.url ?? '/', 'http://localhost').pathname]; }
    catch { stream = undefined; }
    if (stream === undefined || draining) { ws.close(1012, 'service restarting'); return; }
    const clients = stream.clients;
    void (async () => {
      const requested = (ws as WebSocket & { requestedCursor?: number }).requestedCursor;
      const page = await fetchAlerts(stream!.baseUrl, { resource: 'latestAlertId', afterId: 0, limit: 1, origin: stream!.origin });
      if (draining || ws.readyState !== WebSocket.OPEN) {
        ws.close(1012, 'service restarting');
        return;
      }
      if (page === null) { ws.close(1011, 'data source unavailable'); return; }
      const cursor = requested ?? page.nextId;
      const initial = requested === undefined ? page : await fetchAlerts(stream!.baseUrl, { resource: 'alerts', afterId: requested, limit: 1, origin: stream!.origin });
      if (draining || ws.readyState !== WebSocket.OPEN) {
        ws.close(1012, 'service restarting');
        return;
      }
      if (initial === null) { ws.close(1011, 'data source unavailable'); return; }
      if (requested !== undefined && (requested > page.nextId || initial.gap)) {
        ws.send(JSON.stringify({ type: requested > page.nextId ? 'invalid_cursor' : 'cursor_gap', afterId: requested, oldestAvailableId: initial.oldestAvailableId ?? null }));
        ws.close(1008, 'cursor unavailable');
        return;
      }
      clients.set(ws, { cursor, alive: true });
      ws.send(JSON.stringify({ type: 'ready', afterId: cursor }));
    })();
    ws.on('error', () => {});
    ws.on('close', () => clients.delete(ws));
    ws.on('message', () => ws.close(1008, 'server-to-client stream only'));
    ws.on('pong', () => {
      const state = clients.get(ws);
      if (state) state.alive = true;
    });
  });
  const heartbeat = setInterval(() => {
    for (const stream of Object.values(streams)) {
      for (const [ws, state] of stream.clients) {
        if (!state.alive) {
          stream.clients.delete(ws);
          ws.terminate();
          continue;
        }
        state.alive = false;
        ws.ping();
      }
    }
  }, options.heartbeatIntervalMs ?? 25_000);
  heartbeat.unref();

  const timer = setInterval(() => {
    for (const stream of Object.values(streams)) {
      if (stream.polling || stream.clients.size === 0) continue;
      stream.polling = true;
      void pollStream(stream).finally(() => { stream.polling = false; });
    }
  }, WS_POLL_MS);
  timer.unref();
  server.once('close', () => { clearInterval(timer); clearInterval(heartbeat); sockets.close(); });

  async function pollStream(stream: AlertStream): Promise<void> {
    const clients = stream.clients;
    for (const [ws] of clients) {
      if (ws.readyState !== WebSocket.OPEN) clients.delete(ws);
      else if (ws.bufferedAmount > WS_MAX_BUFFERED_BYTES) {
        ws.close(1013, 'consumer too slow');
        clients.delete(ws);
      }
    }
    if (clients.size === 0 || draining) return;
    let afterId = Math.min(...Array.from(clients.values(), (state) => state.cursor));
    const page = await fetchAlerts(stream.baseUrl, { resource: 'alerts', afterId, limit: WS_PAGE_SIZE, origin: stream.origin });
    if (page === null) {
      for (const ws of clients.keys()) ws.close(1011, 'data source unavailable');
      clients.clear();
      return;
    }
    for (const alert of page.data) {
      if (alert.metric !== 'trackerBuy') continue;
      for (const [ws, state] of clients) {
        if (alert.id <= state.cursor || ws.readyState !== WebSocket.OPEN) continue;
        if (ws.bufferedAmount > WS_MAX_BUFFERED_BYTES) {
          clients.delete(ws);
          ws.terminate();
          continue;
        }
        ws.send(JSON.stringify({ type: 'inflow', data: alert }));
      }
    }
    afterId = page.nextId;
    for (const [ws, state] of clients) {
      if (afterId <= state.cursor) continue;
      state.cursor = afterId;
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'cursor', afterId }));
    }
  }

  async function fetchAlerts(base: string | undefined, query: { resource: string; afterId: number; limit: number; origin?: string }): Promise<{ data: PublicAlert[]; nextId: number; oldestAvailableId?: number | null; gap?: boolean } | null> {
    if (!base || !token) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), INTERNAL_TIMEOUT_MS);
    try {
      const url = new URL('/api/internal/public-export', base);
      url.searchParams.set('resource', query.resource);
      url.searchParams.set('afterId', String(query.afterId));
      url.searchParams.set('limit', String(query.limit));
      if (query.origin) url.searchParams.set('origin', query.origin);
      const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal, redirect: 'error' });
      if (!response.ok) return null;
      return await response.json() as { data: PublicAlert[]; nextId: number; oldestAvailableId?: number | null; gap?: boolean };
    } catch { return null; }
    finally { clearTimeout(timeout); }
  }
  return server;
}
export function createPublicApiApp(options: { internalUrl?: string; internalToken?: string; fomoInternalUrl?: string } = {}): Express {
  const internalUrl = options.internalUrl ?? config.publicApiInternalUrl;
  const internalToken = options.internalToken ?? config.publicApiExportToken;
  const fomoInternalUrl = options.fomoInternalUrl ?? config.publicApiFomoInternalUrl;
  let windowState: WindowState = { start: Date.now(), count: 0 };
  const responseCache = new Map<string, { expiresAt: number; value: unknown; bytes: number }>();
  const pending = new Map<string, Promise<InternalResponse>>();
  let responseCacheBytes = 0;
  let inFlight = 0;
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (req.path === '/readyz') { next(); return; }
    const now = Date.now();
    if (now - windowState.start >= WINDOW_MS) windowState = { start: now, count: 0 };
    if (windowState.count >= REQUESTS_PER_WINDOW) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((WINDOW_MS - (now - windowState.start)) / 1000))));
      res.status(429).json({ error: 'rate limit exceeded' }); return;
    }
    windowState.count += 1;
    if (inFlight >= MAX_CONCURRENT) {
      res.setHeader('Retry-After', '1');
      res.status(503).json({ error: 'service busy' }); return;
    }
    inFlight += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inFlight -= 1;
    };
    res.once('finish', release);
    res.once('close', release);
    next();
  });
  app.get('/readyz', async (_req, res) => {
    if (app.locals.draining) { res.status(503).json({ status: 'not_ready' }); return; }
    if (!internalUrl || !fomoInternalUrl || !internalToken) { res.status(503).json({ status: 'not_ready' }); return; }
    const [main, fomo] = await Promise.all([
      internal({ resource: 'tokens', limit: 1, afterId: 0 }, { cache: false }),
      internal({ resource: 'fomoTokens', limit: 1, afterId: 0 }, { baseUrl: fomoInternalUrl, cache: false }),
    ]);
    if (main === null || fomo === null) { res.status(503).json({ status: 'not_ready' }); return; }
    res.json({ status: 'ready', release: process.env.RELEASE_ID ?? 'unknown' });
  });
  app.get('/api/v1/status', (_req, res) => res.json({ status: 'ok', version: 'v1' }));
  app.get('/api/v1/chains', (_req, res) => res.json({ data: CHAINS }));
  app.get('/api/v1/tiers', (_req, res) => res.json({ data: ['S+', 'S', 'A+', 'A', 'B+', 'B', 'P'] }));
  app.get('/api/v1/tokens', async (req, res) => {
    const limit = parsePage(req.query.limit, 50); const offset = parsePage(req.query.offset, 0);
    if (limit === null || limit < 1 || limit > MAX_PAGE || offset === null || offset > 1_000_000) { res.status(400).json({ error: 'invalid pagination' }); return; }
    const result = await internal({ resource: 'tokens', limit, afterId: offset });
    if (result === null) { res.status(502).json({ error: 'data source unavailable' }); return; }
    res.json(result);
  });
  app.get('/api/v1/tokens/:chain/:address', async (req, res) => {
    if (!CHAINS.includes(req.params.chain as typeof CHAINS[number]) || req.params.address.length > 128) { res.status(400).json({ error: 'invalid token identity' }); return; }
    const result = await internal({ resource: 'token', chain: req.params.chain, ca: req.params.address }, { preserveNotFound: true });
    if (result === NOT_FOUND) { res.status(404).json({ error: 'token not found' }); return; }
    if (result === null) { res.status(502).json({ error: 'data source unavailable' }); return; }
    res.json(result);
  });
  for (const resource of ['market', 'metrics', 'history'] as const) app.get(`/api/v1/tokens/:chain/:address/${resource}`, async (req, res) => {
    if (!CHAINS.includes(req.params.chain as typeof CHAINS[number]) || req.params.address.length > 128) { res.status(400).json({ error: 'invalid token identity' }); return; }
    const result = await internal({ resource: 'token', chain: req.params.chain, ca: req.params.address }, { preserveNotFound: true });
    if (result === NOT_FOUND) { res.status(404).json({ error: 'token not found' }); return; }
    if (result === null) { res.status(502).json({ error: 'data source unavailable' }); return; }
    const token = result as { market: unknown; metrics: unknown; history: unknown };
    res.json({ data: token[resource] });
  });
  app.get('/api/v1/tokens/:chain/:address/detail', async (req, res) => {
    if (!CHAINS.includes(req.params.chain as typeof CHAINS[number]) || req.params.address.length > 128) { res.status(400).json({ error: 'invalid token identity' }); return; }
    const result = await internal({ resource: 'detail', chain: req.params.chain, ca: req.params.address }, { preserveNotFound: true });
    if (result === NOT_FOUND) { res.status(404).json({ error: 'token not found' }); return; }
    if (result === null) { res.status(502).json({ error: 'data source unavailable' }); return; }
    res.json(result);
  });
  app.get('/api/v1/tokens/:chain/:address/balance-chart', async (req, res) => {
    if (!CHAINS.includes(req.params.chain as typeof CHAINS[number]) || req.params.address.length > 128) { res.status(400).json({ error: 'invalid token identity' }); return; }
    const window = req.query.window ?? 'day';
    if (typeof window !== 'string' || (window !== 'day' && window !== 'week' && window !== 'month')) { res.status(400).json({ error: 'invalid window' }); return; }
    const result = await internal({ resource: 'balance', chain: req.params.chain, ca: req.params.address, window });
    if (result === null) { res.status(502).json({ error: 'data source unavailable' }); return; }
    res.json(result);
  });
  app.get('/api/v1/tokens/:chain/:address/activity', async (req, res) => {
    const range = parseTimeRange(req.query.from, req.query.to);
    if (!CHAINS.includes(req.params.chain as typeof CHAINS[number]) || req.params.address.length > 128 || !range) { res.status(400).json({ error: 'invalid activity query' }); return; }
    const data = await internal({ resource: 'activity', chain: req.params.chain, ca: req.params.address, ...range });
    if (data === null) { res.status(502).json({ error: 'data source unavailable' }); return; }
    res.json(data);
  });
  app.get('/api/v1/alerts', async (req, res) => {
    const afterId = parsePage(req.query.after_id, 0); const limit = parsePage(req.query.limit, 50);
    if (afterId === null || afterId < 0 || limit === null || limit < 1 || limit > MAX_PAGE) { res.status(400).json({ error: 'invalid pagination' }); return; }
    const data = await internal({ resource: 'alerts', afterId, limit, origin: 'main' });
    if (data === null) { res.status(502).json({ error: 'data source unavailable' }); return; }
    res.json(data);
  });
  app.get('/api/v1/wallets', async (req, res) => {
    const limit = parsePage(req.query.limit, 50); const offset = parsePage(req.query.offset, 0);
    if (limit === null || limit < 1 || limit > MAX_PAGE || offset === null || offset > 1_000_000) { res.status(400).json({ error: 'invalid pagination' }); return; }
    const result = await internal({ resource: 'wallets', limit, afterId: offset });
    if (result === null) { res.status(502).json({ error: 'data source unavailable' }); return; }
    res.json(result);
  });
  app.get('/api/v1/wallets/:id/trades', async (req, res) => {
    const range = parseTimeRange(req.query.from, req.query.to); const afterId = parsePage(req.query.after_id, 0); const limit = parsePage(req.query.limit, 50);
    if (req.params.id.length > 128 || !range || afterId === null || afterId < 0 || limit === null || limit < 1 || limit > MAX_PAGE) { res.status(400).json({ error: 'invalid trade query' }); return; }
    const data = await internal({ resource: 'trades', walletId: req.params.id, ...range, afterId, limit });
    if (data === null) { res.status(502).json({ error: 'data source unavailable' }); return; }
    res.json(data);
  });
  // FOMO routes use a distinct private export upstream configured by
  // PUBLIC_API_FOMO_INTERNAL_URL; its data source is deployment-specific.
  app.get('/api/v1/fomo/users', async (req, res) => {
    const limit = parsePage(req.query.limit, 50); const offset = parsePage(req.query.offset, 0);
    if (limit === null || limit < 1 || limit > MAX_PAGE || offset === null || offset > 1_000_000) { res.status(400).json({ error: 'invalid pagination' }); return; }
    const result = await fomoInternal({ resource: 'fomoUsers', limit, afterId: offset });
    if (result === null) { res.status(502).json({ error: 'data source unavailable' }); return; }
    res.json(result);
  });
  app.get('/api/v1/fomo/users/:id/trades', async (req, res) => {
    const range = parseTimeRange(req.query.from, req.query.to); const afterId = parsePage(req.query.after_id, 0); const limit = parsePage(req.query.limit, 50);
    if (req.params.id.length < 1 || req.params.id.length > 128 || !range || afterId === null || afterId < 0 || limit === null || limit < 1 || limit > MAX_PAGE) { res.status(400).json({ error: 'invalid fomo trade query' }); return; }
    const data = await fomoInternal({ resource: 'fomoTrades', userId: req.params.id, ...range, afterId, limit });
    if (data === null) { res.status(502).json({ error: 'data source unavailable' }); return; }
    res.json(data);
  });
  app.get('/api/v1/fomo/users/:id/positions', async (req, res) => {
    if (req.params.id.length < 1 || req.params.id.length > 128) { res.status(400).json({ error: 'invalid fomo user id' }); return; }
    const data = await fomoInternal({ resource: 'fomoPositions', userId: req.params.id });
    if (data === null) { res.status(502).json({ error: 'data source unavailable' }); return; }
    res.json(data);
  });
  app.get('/api/v1/fomo/tokens', async (req, res) => {
    const limit = parsePage(req.query.limit, 50); const offset = parsePage(req.query.offset, 0);
    if (limit === null || limit < 1 || limit > MAX_PAGE || offset === null || offset > 1_000_000) { res.status(400).json({ error: 'invalid pagination' }); return; }
    const result = await fomoInternal({ resource: 'fomoTokens', limit, afterId: offset });
    if (result === null) { res.status(502).json({ error: 'data source unavailable' }); return; }
    res.json(result);
  });
  app.get('/api/v1/fomo/tokens/:chain/:address', async (req, res) => {
    if (!FOMO_CHAINS.includes(req.params.chain as typeof FOMO_CHAINS[number]) || req.params.address.length < 1 || req.params.address.length > 128) { res.status(400).json({ error: 'invalid token identity' }); return; }
    const result = await fomoInternal({ resource: 'fomoToken', chain: req.params.chain, ca: req.params.address }, { preserveNotFound: true });
    if (result === NOT_FOUND) { res.status(404).json({ error: 'token not found' }); return; }
    if (result === null) { res.status(502).json({ error: 'data source unavailable' }); return; }
    res.json(result);
  });
  app.get('/api/v1/fomo/alerts', async (req, res) => {
    const afterId = parsePage(req.query.after_id, 0); const limit = parsePage(req.query.limit, 50);
    if (afterId === null || afterId < 0 || limit === null || limit < 1 || limit > MAX_PAGE) { res.status(400).json({ error: 'invalid pagination' }); return; }
    const data = await fomoInternal({ resource: 'alerts', afterId, limit, origin: 'fomo' });
    if (data === null) { res.status(502).json({ error: 'data source unavailable' }); return; }
    res.json(data);
  });
  app.get('/api/v1/fomo/wallets', async (req, res) => {
    const limit = parsePage(req.query.limit, 50); const offset = parsePage(req.query.offset, 0);
    if (limit === null || limit < 1 || limit > MAX_PAGE || offset === null || offset > 1_000_000) { res.status(400).json({ error: 'invalid pagination' }); return; }
    const result = await fomoInternal({ resource: 'wallets', limit, afterId: offset });
    if (result === null) { res.status(502).json({ error: 'data source unavailable' }); return; }
    res.json(result);
  });
  app.get('/api/v1/fomo/wallets/:id/trades', async (req, res) => {
    const range = parseTimeRange(req.query.from, req.query.to); const afterId = parsePage(req.query.after_id, 0); const limit = parsePage(req.query.limit, 50);
    if (req.params.id.length < 1 || req.params.id.length > 128 || !range || afterId === null || afterId < 0 || limit === null || limit < 1 || limit > MAX_PAGE) { res.status(400).json({ error: 'invalid trade query' }); return; }
    const data = await fomoInternal({ resource: 'trades', walletId: req.params.id, ...range, afterId, limit });
    if (data === null) { res.status(502).json({ error: 'data source unavailable' }); return; }
    res.json(data);
  });
  app.get('/api/v1/fomo/tokens/:chain/:address/users', async (req, res) => {
    if (!FOMO_CHAINS.includes(req.params.chain as typeof FOMO_CHAINS[number]) || req.params.address.length < 1 || req.params.address.length > 128) { res.status(400).json({ error: 'invalid token identity' }); return; }
    const data = await fomoInternal({ resource: 'fomoTokenStats', chain: req.params.chain, ca: req.params.address });
    if (data === null) { res.status(502).json({ error: 'data source unavailable' }); return; }
    res.json(data);
  });
  type InternalOptions = { preserveNotFound?: boolean; baseUrl?: string; cache?: boolean };
  async function internal(query: Record<string, string | number>, options: InternalOptions & { preserveNotFound: true }): Promise<InternalResponse>;
  async function internal(query: Record<string, string | number>, options?: InternalOptions): Promise<unknown | null>;
  async function internal(
    query: Record<string, string | number>,
    options: InternalOptions = {},
  ): Promise<InternalResponse> {
    const base = options.baseUrl ?? internalUrl;
    if (!base || !internalToken) return null;
    const url = new URL('/api/internal/public-export', base);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, String(value));
    const key = url.toString() + (options.preserveNotFound ? '#notfound' : '');
    const cacheTtl = options.cache === false ? 0 : responseCacheTtl(query.resource);
    const cached = cacheTtl > 0 ? responseCache.get(key) : undefined;
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      responseCache.delete(key);
      responseCache.set(key, cached);
      return cached.value;
    }
    if (cached !== undefined) {
      responseCache.delete(key);
      responseCacheBytes -= cached.bytes;
    }
    const running = pending.get(key);
    if (running !== undefined) return await running;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), INTERNAL_TIMEOUT_MS);
    const request = (async (): Promise<InternalResponse> => {
      try {
        const response = await fetch(url, { headers: { authorization: `Bearer ${internalToken}` }, signal: controller.signal, redirect: 'error' });
        if (response.status === 404 && options.preserveNotFound) return NOT_FOUND;
        if (!response.ok) {
          console.warn('[public-api] export backend returned non-success status', response.status);
          return null;
        }
        const value: unknown = await response.json();
        if (cacheTtl > 0) {
          const receivedAt = Date.now();
          const snapshotHeader = response.headers.get('x-signal-scan-snapshot-at');
          const snapshotAt = snapshotHeader !== null && /^\d+$/.test(snapshotHeader) ? Number(snapshotHeader) : null;
          const expiresAt = snapshotAt !== null && Number.isSafeInteger(snapshotAt)
            ? Math.min(receivedAt + cacheTtl, snapshotAt + 60_000)
            : receivedAt + cacheTtl;
          if (expiresAt > receivedAt) {
            const serialized = JSON.stringify(value);
            const bytes = Buffer.byteLength(serialized, 'utf8');
            if (bytes <= RESPONSE_CACHE_MAX_BYTES) {
              while (responseCache.size >= RESPONSE_CACHE_MAX_ENTRIES || responseCacheBytes + bytes > RESPONSE_CACHE_MAX_BYTES) {
                const oldest = responseCache.keys().next().value;
                if (oldest === undefined) break;
                const entry = responseCache.get(oldest);
                responseCache.delete(oldest);
                if (entry !== undefined) responseCacheBytes -= entry.bytes;
              }
              responseCache.set(key, { expiresAt, value, bytes });
              responseCacheBytes += bytes;
            }
          }
        }
        return value;
      } catch (error) {
        console.warn('[public-api] export backend request failed', error instanceof Error ? error.name : 'unknown');
        return null;
      } finally {
        clearTimeout(timer);
        pending.delete(key);
      }
    })();
    pending.set(key, request);
    return await request;
  }
  function fomoInternal(query: Record<string, string | number>, options: { preserveNotFound: true }): Promise<InternalResponse>;
  function fomoInternal(query: Record<string, string | number>): Promise<unknown | null>;
  function fomoInternal(query: Record<string, string | number>, options: { preserveNotFound?: boolean } = {}): Promise<InternalResponse> {
    return internal(query, { ...options, baseUrl: fomoInternalUrl });
  }
  return app;
}

if (process.env.PUBLIC_API_RUN === '1') {
  const server = createPublicApiServer();
  server.listen(config.publicApiPort, '0.0.0.0', () => console.log(`[public-api] listening on ${config.publicApiPort}`));
  installGracefulShutdown(server, { drainTimeoutMs: 10_000, onDrain: () => server.emit('drain') });
}
function responseCacheTtl(resource: string | number | undefined): number {
  switch (resource) {
    case 'tokens':
    case 'token':
    case 'detail':
    case 'fomoTokens':
    case 'fomoToken':
      return 5_000;
    case 'wallets':
    case 'fomoUsers':
    case 'balance':
      return 15_000;
    case 'fomoTokenStats':
      return 15_000;
    case 'activity':
    case 'trades':
    case 'fomoTrades':
    case 'fomoPositions':
      return 1_000;
    case 'alerts':
    case 'latestAlertId':
      return 500;
    default:
      return 0;
  }
}
