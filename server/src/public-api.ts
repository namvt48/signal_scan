import { createServer, type Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import express, { type Express } from 'express';
import { config } from './config.js';
import type { PublicAlert } from './public-api-contract.js';

const WINDOW_MS = 60_000;
const REQUESTS_PER_WINDOW = 120;
const MAX_PAGE = 100;
const INTERNAL_TIMEOUT_MS = 10_000;
const WS_POLL_MS = 500;
const WS_MAX_BUFFERED_BYTES = 1_048_576;
const WS_PAGE_SIZE = 100;
const MAX_WS_CONNECTIONS = 64;
const MAX_CONCURRENT = 16;
const CHAINS = ['sol', 'base', 'bsc', 'robinhood'] as const;
/** Backend returned 404; only surfaced when the caller opts in via `preserveNotFound`. */
const NOT_FOUND = Symbol('backend-not-found');
type InternalResponse = unknown | null | typeof NOT_FOUND;
interface WindowState { start: number; count: number }

function parsePage(value: unknown, fallback: number): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}
function parseTimeRange(fromRaw: unknown, toRaw: unknown): { from: number; to: number } | null {
  const from = parsePage(fromRaw, Date.now() - 86_400_000);
  const to = parsePage(toRaw, Date.now());
  return from !== null && to !== null && from >= 0 && to > from && to - from <= 31 * 86_400_000 ? { from, to } : null;
}

export function createPublicApiServer(options: { internalUrl?: string; internalToken?: string; heartbeatIntervalMs?: number } = {}): Server {
  const app = createPublicApiApp(options);
  const server = createServer(app);
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  const clients = new Map<WebSocket, { cursor: number; alive: boolean }>();
  let reservedConnections = 0;
  let polling = false;

  server.on('upgrade', (request, socket, head) => {
    let pathname: string;
    try { pathname = new URL(request.url ?? '/', 'http://localhost').pathname; }
    catch { socket.destroy(); return; }
    if (pathname !== '/api/v1/ws') { socket.destroy(); return; }
    if (reservedConnections >= MAX_WS_CONNECTIONS) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    reservedConnections++;
    const releaseReservation = () => { reservedConnections--; };
    socket.once('close', releaseReservation);
    sockets.handleUpgrade(request, socket, head, (ws) => {
      sockets.emit('connection', ws, request);
    });
  });
  sockets.on('connection', (ws) => {
    void (async () => {
      const page = await fetchAlerts({ resource: 'latestAlertId', afterId: 0, limit: 1 });
      if (page === null) { ws.close(1011, 'data source unavailable'); return; }
      if (ws.readyState !== WebSocket.OPEN) return;
      clients.set(ws, { cursor: page.nextId, alive: true });
      ws.send(JSON.stringify({ type: 'ready', afterId: page.nextId }));
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
    for (const [ws, state] of clients) {
      if (!state.alive) {
        clients.delete(ws);
        ws.terminate();
        continue;
      }
      state.alive = false;
      ws.ping();
    }
  }, options.heartbeatIntervalMs ?? 25_000);
  heartbeat.unref();

  const timer = setInterval(() => {
    if (polling || clients.size === 0) return;
    polling = true;
    void (async () => {
      for (const [ws] of clients) {
        if (ws.readyState !== WebSocket.OPEN) clients.delete(ws);
        else if (ws.bufferedAmount > WS_MAX_BUFFERED_BYTES) {
          ws.close(1013, 'consumer too slow');
          clients.delete(ws);
        }
      }
      if (clients.size === 0) return;
      let afterId = Math.min(...Array.from(clients.values(), (state) => state.cursor));
      for (;;) {
        const page = await fetchAlerts({ resource: 'alerts', afterId, limit: WS_PAGE_SIZE });
        if (page === null) {
          for (const ws of clients.keys()) ws.close(1011, 'data source unavailable');
          clients.clear();
          return;
        }
        for (const alert of page.data) {
          if (alert.metric === 'trackerBuy') {
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
        }
        afterId = page.nextId;
        for (const state of clients.values()) state.cursor = Math.max(state.cursor, afterId);
        if (page.data.length < WS_PAGE_SIZE) break;
      }
    })().finally(() => { polling = false; });
  }, WS_POLL_MS);
  timer.unref();
  server.once('close', () => { clearInterval(timer); clearInterval(heartbeat); sockets.close(); });

  async function fetchAlerts(query: { resource: string; afterId: number; limit: number }): Promise<{ data: PublicAlert[]; nextId: number } | null> {
    const base = options.internalUrl ?? config.publicApiInternalUrl;
    const token = options.internalToken ?? config.publicApiExportToken;
    if (!base || !token) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), INTERNAL_TIMEOUT_MS);
    try {
      const url = new URL('/api/internal/public-export', base);
      url.searchParams.set('resource', query.resource);
      url.searchParams.set('afterId', String(query.afterId));
      url.searchParams.set('limit', String(query.limit));
      const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal, redirect: 'error' });
      if (!response.ok) return null;
      return await response.json() as { data: PublicAlert[]; nextId: number };
    } catch { return null; }
    finally { clearTimeout(timeout); }
  }
  return server;
}
export function createPublicApiApp(options: { internalUrl?: string; internalToken?: string } = {}): Express {
  const internalUrl = options.internalUrl ?? config.publicApiInternalUrl;
  const internalToken = options.internalToken ?? config.publicApiExportToken;
  let windowState: WindowState = { start: Date.now(), count: 0 };
  const responseCache = new Map<string, { expiresAt: number; value: unknown }>();
  const pending = new Map<string, Promise<InternalResponse>>();
  let inFlight = 0;
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    const now = Date.now();
    if (now - windowState.start >= WINDOW_MS) windowState = { start: now, count: 0 };
    if (windowState.count >= REQUESTS_PER_WINDOW) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((WINDOW_MS - (now - windowState.start)) / 1000))));
      res.status(429).json({ error: 'rate limit exceeded' }); return;
    }
    windowState.count += 1;
    if (inFlight >= MAX_CONCURRENT) { res.status(503).json({ error: 'service busy' }); return; }
    inFlight += 1;
    res.once('finish', () => { inFlight -= 1; });
    next();
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
    const data = await internal({ resource: 'alerts', afterId, limit });
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
  async function internal(query: Record<string, string | number>, options: { preserveNotFound: true }): Promise<InternalResponse>;
  async function internal(query: Record<string, string | number>): Promise<unknown | null>;
  async function internal(
    query: Record<string, string | number>,
    options: { preserveNotFound?: boolean } = {},
  ): Promise<InternalResponse> {
    if (!internalUrl || !internalToken) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), INTERNAL_TIMEOUT_MS);
    try {
      const url = new URL('/api/internal/public-export', internalUrl);
      for (const [name, value] of Object.entries(query)) url.searchParams.set(name, String(value));
      const key = url.toString() + (options.preserveNotFound ? '#notfound' : '');
      const cached = responseCache.get(key);
      if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value;
      const running = pending.get(key);
      if (running !== undefined) return await running;
      const request = (async (): Promise<InternalResponse> => {
        try {
          const response = await fetch(url, { headers: { authorization: `Bearer ${internalToken}` }, signal: controller.signal, redirect: 'error' });
          if (response.status === 404 && options.preserveNotFound) return NOT_FOUND;
          if (!response.ok) {
            console.warn('[public-api] export backend returned non-success status', response.status);
            return null;
          }
          const value: unknown = await response.json();
          if (responseCache.size >= 128) {
            const oldest = responseCache.keys().next().value;
            if (oldest !== undefined) responseCache.delete(oldest);
          }
          responseCache.set(key, { expiresAt: Date.now() + 500, value });
          return value;
        } catch (error) {
          console.warn('[public-api] export backend request failed', error instanceof Error ? error.name : 'unknown');
          return null;
        } finally {
          pending.delete(key);
        }
      })();
      pending.set(key, request);
      return await request;
    } finally {
      clearTimeout(timer);
    }
  }
  return app;
}

if (process.env.PUBLIC_API_RUN === '1') {
  createPublicApiServer().listen(config.publicApiPort, '0.0.0.0', () => console.log(`[public-api] listening on ${config.publicApiPort}`));
}
