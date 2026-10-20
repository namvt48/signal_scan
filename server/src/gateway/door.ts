// Browser-transport door pool, extracted DB-FREE (plan request-plane-gateway,
// todo 10). The gateway is the single authority for the browser door, so the
// DoorPool, the browserless WS transport, the ipify egress-IP probe and the
// `browserPostJson` injection point all live HERE — never in the api container.
//
// DB-FREE BY CONTRACT: this module imports NO persistence layer (no db, no
// sqlite driver). The api-side `crawl.ts` re-exports this surface for
// back-compat; legacy DB-backed series helpers stay there. `crawl.ts` imports
// from here (never the reverse), so there is no module cycle.
//
// Transport = DOOR POOL (plan nansen-proxy-routing D1–D11): one "door" is one
// Browserless WS connection with a private cookie jar, cf_clearance and egress.
// General doors may use `--proxy-server` + page.authenticate; the Fresh Wallet
// pool instead has one direct Browserless WS endpoint per VPS.
// The pool classifies responses (D4), quarantines 429s (D3), retries via at
// most one different door (D5), enforces per-(door,path) budgets (D6), routes
// least-outstanding (D7), and degrades to {status:503,json:null} — postJson
// NEVER throws. General proxy routes come from CRAWL_PROXY_FILE; Fresh Wallet
// direct routes come from CRAWL_FRESH_WALLET_WS_ENDPOINTS.

import { readFileSync } from 'node:fs';
import puppeteer, { type Page } from 'puppeteer-core';
import { config } from '../config.js';
import { log, timed } from '../log.js';
import type { Priority } from '../ratelimit/types.js';
import type { DoorClassification } from '../shared/nansen-door.js';

// ---------------------------------------------------------------------------
// Frozen contract (decisions.md "T2/T3 FROZEN INTERFACE CONTRACT") — shapes
// here are spec; door-pool.test.ts pins them. Do not rename/re-shape.
// ---------------------------------------------------------------------------

export interface ProxySpec {
  url: string;
  username?: string;
  password?: string;
}

export type Classification = 'ok' | 'throttle' | 'interstitial' | 'real403' | '5xx' | 'transport';

export interface DoorHttpResponse {
  status: number;
  contentType: string;
  retryAfter: number | null;
  head: string;
  len: number;
  json: unknown | null;
  threw: boolean;
}

export interface DoorConn {
  fetch(url: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<DoorHttpResponse>;
  invalidate(): Promise<void>;
  close(): Promise<void>;
}

export interface DoorSpec {
  ws: string;
  proxy: ProxySpec | null;
}

export interface DoorPoolConfig {
  wsEndpoint: string;
  /** Optional independent Browserless routes; each is a direct egress door. */
  wsEndpoints?: string[];
  proxies: ProxySpec[];
  pathBudget: number;
  budgetWindowMs: number;
  doorCapPerMin: number;
  warmupTimeoutMs: number;
  requestTimeoutMs: number;
  quarantineJitterMs: number;
}

export interface DoorPoolDeps {
  connect(spec: DoorSpec): Promise<DoorConn>;
  now(): number;
  sleep(ms: number): Promise<void>;
  config: DoorPoolConfig;
  log(line: string): void;
}

export type DoorState = 'cold' | 'warming' | 'probation' | 'healthy' | 'throttled' | 'penalized' | 'retired';

export interface DoorStat {
  id: number;
  state: DoorState;
  proxy: string;
  egressIp: string | null;
  requests: number;
  lastStatus: number | null;
  budgetUsed: number;
  retiredReason: string | null;
}

/** Never logs credentials: strips the WHOLE userinfo — `http://u:p@h:port` → `http://h:port` (greedy to the last authority `@`, so a raw `@` in the password cannot leak a tail). */
function maskProxyUrl(u: string): string {
  return u.replace(/\/\/[^/?#]*@/, '//');
}

/**
 * D2 proxy file: one `http://user:pass@host:port` per line; `#`/blank skipped;
 * non-http(s) or unparsable lines warn + skip (never crash the boot). Chrome
 * cannot auth SOCKS5 — only http(s) proxies are accepted.
 */
export function parseProxyFile(text: string): ProxySpec[] {
  const out: ProxySpec[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // Sentinel: `direct`/`none` = null-proxy door (chrome egresses from the deploy host).
    if (line === 'direct' || line === 'none') {
      out.push({ url: 'direct' });
      continue;
    }
    const spec: ProxySpec = { url: line };
    try {
      const u = new URL(line);
      if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.host) {
        log.warn(`[crawl] proxy line skipped (need http(s)://host:port): ${maskProxyUrl(line)}`);
        continue;
      }
      // S2: decode INSIDE the try — a malformed % escape (URIError) must skip this
      // one entry (D2), not escape and degrade the whole pool to single-door.
      if (u.username) spec.username = decodeURIComponent(u.username);
      if (u.password) spec.password = decodeURIComponent(u.password);
    } catch {
      log.warn(`[crawl] proxy line skipped (not a URL): ${maskProxyUrl(line)}`);
      continue;
    }
    out.push(spec);
  }
  return out;
}

/**
 * D4 classifier — pure. Evidence shapes (.probe/challenge-probe.mjs runs):
 * 429 "Error 1015" ~975B html; 403 interstitial = CF challenge HTML ~6.4KB
 * ("Just a moment"); 403 real = small JSON. `threw` beats any status; a 200
 * whose body failed JSON parse counts as transport (D4).
 */
export function classify(res: DoorHttpResponse): Classification {
  if (res.threw) return 'transport';
  if (res.status === 429) return 'throttle';
  if (res.status === 403) {
    const html = res.contentType.toLowerCase().includes('html') || res.head.trim().startsWith('<');
    return html ? 'interstitial' : 'real403';
  }
  if (res.status >= 500) return '5xx';
  if (res.status === 200) return res.json === null || res.json === undefined ? 'transport' : 'ok';
  return 'transport'; // 3xx / unexpected 4xx — transport-shaped anomaly
}

/** D6 path key = last URL segment (`.../questions/tgm-volume-details` → `tgm-volume-details`). */
function pathKey(url: string): string {
  const clean = url.split('?')[0] ?? '';
  const seg = clean.substring(clean.lastIndexOf('/') + 1);
  return seg || clean;
}

// ---------------------------------------------------------------------------
// Door pool
// ---------------------------------------------------------------------------

/** D3: penalized backoff ladder 2m → 10m → 30m → retired (index = penaltyStage). */
const BACKOFF_STAGES_MS: readonly number[] = [120_000, 600_000, 1_800_000];
/** D7 router wait-loop: poll 250ms, cap 65s, then degrade. */
const ROUTER_POLL_MS = 250;
const ROUTER_WAIT_CAP_MS = 65_000;
/** D3: 429 without a retry-after header → quarantine 1800s. */
const DEFAULT_QUARANTINE_S = 1_800;
/** D3: warmup polls cf_clearance every 2.5s (measured CF challenge ≤ ~20s). */
const WARM_POLL_MS = 2_500;

/**
 * realConnect.fetch tags every page/CDP-origin failure with this head prefix, so the
 * pool can tell "our page died" from "the proxy is dead" — for a throw, `head` is the
 * only place that origin survives (classify() sees just threw+status 0).
 * 2026-09-23 incident: browserless closed the browser process, all in-flight fetches
 * came back threw+head='page unavailable (invalidated)' → counted as transport fails →
 * BOTH doors retired 'broken-proxy' within 200ms while both proxies were still healthy
 * (verified later with an in-container probe: HTTP 200 through each) → pool blackout,
 * every T100/LF factor missing for 30+ min with zero alarms.
 */
const BROWSER_FAILURE_PREFIX = 'browser:';

/**
 * A broken-proxy door gets one more chance this long after retiring: proxies restart,
 * browser hiccups clear, and a permanent death sentence is a permanent blackout (see
 * the 2026-09-23 incident above — two false retires cost 30+ min of missing factors).
 * ponytail: flat 60s, no backoff ladder — a re-arm costs at most one warmup per door
 * per minute, which is the same price as the boot warmup it replaces.
 */
const RETIRED_RETRY_MS = 60_000;

interface Door {
  readonly id: number;
  readonly spec: DoorSpec;
  /** Password-masked proxy URL for logs/stats ('' for the no-proxy fallback door). */
  readonly masked: string;
  state: DoorState;
  conn: DoorConn | null;
  generation: number;
  outstanding: number;
  /** Monotonic dispatch counter — LRU tie-break for the router (D7). */
  useSeq: number;
  requests: number;
  lastStatus: number | null;
  /** Sliding-window budget hits: one entry per dispatched request (D6). */
  hits: Array<{ t: number; path: string }>;
  /** Consecutive transport/5xx failures — ≥2 retires the door (D5). */
  transportFails: number;
  /** Consecutive real-403s — first re-warms, second penalizes (D5); 200 resets. */
  real403Streak: number;
  /** Consecutive re-warm (invalidate) rejections — ≥2 retires. A lone CDP hiccup must not kill a 1-door pool (D5b). */
  rewarmFails: number;
  quarantineUntil: number;
  backoffUntil: number;
  penaltyStage: number;
  retiredReason: string | null;
  /** Wall clock of the last retire() — gates the broken-proxy re-arm (RETIRED_RETRY_MS). */
  retiredAt: number;
  egressIp: string | null;
}

type DoorConnWithEgress = DoorConn & { egressIp?: string | null };
interface PendingDoorAcquire {
  path: string;
  caller: string;
  priority: Priority;
  enqueuedAt: number;
  resolve: (door: Door | null) => void;
  timer: NodeJS.Timeout;
}

export interface DoorRequestOptions {
  /** Authenticated gateway caller; absent for internal browser-door use. */
  caller?: string;
  priority?: Priority;
  signal?: AbortSignal;
}

const DOOR_QUEUE_MAX = 256;
const DOOR_PRIORITY_AGING_MS = 30_000;

export class DoorPool {
  private readonly deps: DoorPoolDeps;
  private readonly doors: Door[];
  private readonly pendingAcquires: PendingDoorAcquire[] = [];
  private readonly lastCaller = new Map<Priority, string>();
  private drainingAcquires = false;
  private stopped = false;
  private seq = 0;
  private requestSeq = 0;
  /** One-shot per blackout so an exhausted pool is loud once, not once per request. */
  private exhaustedLogged = false;

  constructor(deps: DoorPoolDeps) {
    this.deps = deps;
    const directEndpoints = deps.config.wsEndpoints?.filter(Boolean) ?? [];
    // Explicit Browserless endpoints are always direct; the general pool keeps
    // its existing proxy-file behavior when no endpoint list is supplied.
    const specs: DoorSpec[] =
      directEndpoints.length > 0
        ? directEndpoints.map((ws) => ({ ws, proxy: null }))
        : deps.config.proxies.length > 0
          ? deps.config.proxies.map((proxy) => ({
              ws: deps.config.wsEndpoint,
              proxy: proxy.url === 'direct' ? null : proxy,
            }))
          : [{ ws: deps.config.wsEndpoint, proxy: null }];
    this.doors = specs.map((spec, id) => ({
      id,
      spec,
      masked: spec.proxy ? maskProxyUrl(spec.proxy.url) : 'direct',
      state: 'cold',
      conn: null,
      generation: 0,
      outstanding: 0,
      useSeq: 0,
      requests: 0,
      lastStatus: null,
      hits: [],
      transportFails: 0,
      real403Streak: 0,
      rewarmFails: 0,
      quarantineUntil: 0,
      backoffUntil: 0,
      penaltyStage: 0,
      retiredReason: null,
      retiredAt: 0,
      egressIp: null,
    }));
  }

  /** D8: fire-and-forget; every door warms up in parallel, none blocks boot. */
  start(): void {
    if (this.stopped) return;
    this.deps.log(`[pool] starting ${this.doors.length} doors (proxies=${this.deps.config.proxies.length})`);
    for (const d of this.doors) void this.warm(d);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const job of this.pendingAcquires.splice(0)) job.resolve(null);
    for (const d of this.doors) {
      d.generation += 1;
      d.state = 'retired';
      const conn = d.conn;
      d.conn = null;
      if (conn) void withTimeout(conn.close(), this.deps.config.warmupTimeoutMs).catch(() => {});
    }
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
  }

  /**
   * Route + fetch + classify + react (D5/D7). Caller cancellation rejects;
   * no live door or router wait-cap → {status:503,json:null}; requery fail → {status:<original|502>,json:null}.
   */
  async postJson(url: string, body: unknown, options: DoorRequestOptions = {}): Promise<{ status: number; json: unknown | null; classification: Classification | 'unavailable' }> {
    const requestId = ++this.requestSeq;
    const path = pathKey(url);
    const caller = options.caller ?? 'internal';
    const priority = options.priority ?? (path === 'tgm-essential-data' ? 0 : path === 'tgm-volume-details' ? 2 : 1);
    const startedAt = performance.now();
    const requestFields = {
      requestId,
      caller,
      path,
      priority,
      ...(this.nansenIdentity(body)),
    };
    const queueDepth = this.pendingAcquires.length;
    log.info('door request start', { ...requestFields, queueDepth });
    try {
      this.throwIfAborted(options.signal);
      const door = await this.acquire(path, caller, priority, options.signal);
      const waitMs = Math.round(performance.now() - startedAt);
      if (options.signal?.aborted) {
        log.info('door request admission', { ...requestFields, outcome: 'aborted', queueDepth: this.pendingAcquires.length, waitMs });
        this.throwIfAborted(options.signal);
      }
      if (!door) {
        log.info('door request admission', { ...requestFields, outcome: 'rejected', queueDepth: this.pendingAcquires.length, waitMs });
        log.info('door request finish', { ...requestFields, outcome: 'error', status: 503, runMs: waitMs });
        return { status: 503, json: null, classification: 'unavailable' };
      }
      log.info('door request admission', { ...requestFields, outcome: 'admitted', doorId: door.id, queueDepth: this.pendingAcquires.length, waitMs });
      let res = await this.dispatch(door, url, body, path, options.signal, requestId);
      this.throwIfAborted(options.signal);
      let cls = classify(res);
      if (cls === 'interstitial') {
        res = await this.dispatch(door, url, body, path, options.signal, requestId);
        this.throwIfAborted(options.signal);
        cls = classify(res);
      }
      this.applyOutcome(door, cls, res, path);
      if (cls === 'ok') {
        log.info('door request finish', { ...requestFields, outcome: 'success', doorId: door.id, status: res.status, runMs: Math.round(performance.now() - startedAt) });
        return { status: res.status, json: res.json, classification: cls };
      }
      this.logDoor(door, `requery class=${cls}`, path, res.status);
      const alt = this.pick(path, door.id);
      let surfaced = { res, cls };
      if (alt) {
        const res2 = await this.dispatch(alt, url, body, path, options.signal, requestId);
        this.throwIfAborted(options.signal);
        const cls2 = classify(res2);
        this.applyOutcome(alt, cls2, res2, path);
        if (cls2 === 'ok') {
          log.info('door request finish', { ...requestFields, outcome: 'success', doorId: alt.id, status: res2.status, runMs: Math.round(performance.now() - startedAt) });
          return { status: res2.status, json: res2.json, classification: cls2 };
        }
        surfaced = { res: res2, cls: cls2 };
      }
      if (!alt && cls === 'interstitial') {
        for (let i = 0; i < 3 && door.state === 'warming'; i++) {
          await this.deps.sleep(WARM_POLL_MS);
          this.throwIfAborted(options.signal);
        }
        if (door.state === 'probation' || door.state === 'healthy') {
          this.logDoor(door, 'requery class=interstitial same-door', path, res.status);
          const res3 = await this.dispatch(door, url, body, path, options.signal, requestId);
          this.throwIfAborted(options.signal);
          const cls3 = classify(res3);
          this.applyOutcome(door, cls3, res3, path);
          if (cls3 === 'ok') {
            log.info('door request finish', { ...requestFields, outcome: 'success', doorId: door.id, status: res3.status, runMs: Math.round(performance.now() - startedAt) });
            return { status: res3.status, json: res3.json, classification: cls3 };
          }
          surfaced = { res: res3, cls: cls3 };
        }
      }
      const status = surfaced.res.status > 0 ? surfaced.res.status : 502;
      log.info('door request finish', { ...requestFields, outcome: 'error', doorId: door.id, status, runMs: Math.round(performance.now() - startedAt) });
      return { status, json: null, classification: surfaced.cls };
    } catch (error) {
      if (options.signal?.aborted) {
        log.info('door request finish', { ...requestFields, outcome: 'aborted', runMs: Math.round(performance.now() - startedAt) });
      }
      throw error;
    }
  }

  private nansenIdentity(body: unknown): { ca?: string; chain?: string } {
    if (typeof body !== 'object' || body === null || !('parameters' in body)) return {};
    const parameters = (body as { parameters?: unknown }).parameters;
    if (typeof parameters !== 'object' || parameters === null) return {};
    const { tokenAddress, chain } = parameters as { tokenAddress?: unknown; chain?: unknown };
    return {
      ...(typeof tokenAddress === 'string' ? { ca: tokenAddress } : {}),
      ...(typeof chain === 'string' ? { chain } : {}),
    };
  }

  /** Door table in proxy-file order (fallback door = index 0). */
  stats(): DoorStat[] {
    return this.doors.map((d) => ({
      id: d.id,
      state: d.state,
      proxy: d.masked,
      egressIp: d.egressIp,
      requests: d.requests,
      lastStatus: d.lastStatus,
      budgetUsed: this.budgetUsed(d),
      retiredReason: d.retiredReason,
    }));
  }

  // -- routing (D7) ----------------------------------------------------------

  /** Admit queued work by urgency and caller round-robin when a budget slot opens. */
  private acquire(path: string, caller: string, priority: Priority, signal?: AbortSignal): Promise<Door | null> {
    this.throwIfAborted(signal);
    if (this.stopped) return Promise.resolve(null);
    if (this.pendingAcquires.length >= DOOR_QUEUE_MAX) {
      const now = this.deps.now();
      let victimIndex = -1;
      let victimPriority = priority;
      for (let i = 0; i < this.pendingAcquires.length; i += 1) {
        const job = this.pendingAcquires[i];
        if (job === undefined) continue;
        const effective = this.effectivePriority(job, now);
        if (effective <= priority) continue;
        if (
          victimIndex === -1 ||
          effective > victimPriority ||
          (effective === victimPriority && job.enqueuedAt < this.pendingAcquires[victimIndex]!.enqueuedAt)
        ) {
          victimIndex = i;
          victimPriority = effective;
        }
      }
      if (victimIndex === -1) {
        this.deps.log(`[pool] admission queue full path=${path} — skip`);
        return Promise.resolve(null);
      }
      const [victim] = this.pendingAcquires.splice(victimIndex, 1);
      victim?.resolve(null);
      this.deps.log(`[pool] admission queue displaced background path=${victim?.path ?? '-'}`);
    }
    return new Promise<Door | null>((resolve) => {
      let job!: PendingDoorAcquire;
      let removeAbortListener = () => {};
      const finish = (door: Door | null) => {
        clearTimeout(timer);
        removeAbortListener();
        resolve(door);
      };
      const timer = setTimeout(() => {
        const index = this.pendingAcquires.indexOf(job);
        if (index >= 0) this.pendingAcquires.splice(index, 1);
        job.resolve(null);
      }, ROUTER_WAIT_CAP_MS);
      job = {
        path,
        caller,
        priority,
        enqueuedAt: this.deps.now(),
        timer,
        resolve: finish,
      };
      this.pendingAcquires.push(job);
      if (signal) {
        const abort = () => {
          const index = this.pendingAcquires.indexOf(job);
          if (index >= 0) this.pendingAcquires.splice(index, 1);
          job.resolve(null);
        };
        signal.addEventListener('abort', abort, { once: true });
        removeAbortListener = () => signal.removeEventListener('abort', abort);
        if (signal.aborted) abort();
      }
      queueMicrotask(() => { void this.drainAcquireQueue(); });
    });
  }

  private effectivePriority(job: PendingDoorAcquire, now: number): Priority {
    return (
      job.priority === 0
        ? 0
        : Math.max(1, job.priority - Math.floor((now - job.enqueuedAt) / DOOR_PRIORITY_AGING_MS))
    ) as Priority;
  }

  private async drainAcquireQueue(): Promise<void> {
    if (this.drainingAcquires) return;
    this.drainingAcquires = true;
    try {
      while (this.pendingAcquires.length > 0) {
        if (this.stopped) {
          for (const job of this.pendingAcquires.splice(0)) job.resolve(null);
          break;
        }
        const now = this.deps.now();
        this.tick();
        for (let i = this.pendingAcquires.length - 1; i >= 0; i -= 1) {
          const job = this.pendingAcquires[i];
          if (job === undefined || now - job.enqueuedAt < ROUTER_WAIT_CAP_MS) continue;
          this.pendingAcquires.splice(i, 1);
          this.deps.log(`[pool] no door budget for ${job.path} — skip`);
          job.resolve(null);
        }
        if (this.pendingAcquires.length === 0) break;

        const ordered = this.pendingAcquires
          .map((job, index) => ({
            job,
            index,
            effective: this.effectivePriority(job, now),
          }))
          .sort((a, b) => {
            if (a.effective !== b.effective) return a.effective - b.effective;
            const last = this.lastCaller.get(a.effective);
            const aWasLast = a.job.caller === last;
            const bWasLast = b.job.caller === last;
            return Number(aWasLast) - Number(bWasLast) || a.job.enqueuedAt - b.job.enqueuedAt;
          });

        let admitted = false;
        for (const candidate of ordered) {
          const door = this.pick(candidate.job.path, -1);
          if (door === null) continue;
          this.pendingAcquires.splice(candidate.index, 1);
          this.lastCaller.set(candidate.effective, candidate.job.caller);
          this.exhaustedLogged = false;
          candidate.job.resolve(door);
          admitted = true;
          // Let postJson dispatch and stamp this door before choosing another.
          await Promise.resolve();
          break;
        }
        if (admitted) continue;
        const rearmed = this.rearmRetired(now);
        if (rearmed) {
          await this.deps.sleep(ROUTER_POLL_MS);
          continue;
        }

        const alive = this.doors.some((door) => door.state !== 'retired');
        if (!alive) {
          if (!this.exhaustedLogged) {
            this.exhaustedLogged = true;
            this.deps.log('[pool] ALL DOORS RETIRED — pool exhausted, serving 503 until re-arm');
          }
          for (const job of this.pendingAcquires.splice(0)) job.resolve(null);
          break;
        }

        const earliest = this.earliestSlot();
        if (earliest > 0) {
          for (let i = this.pendingAcquires.length - 1; i >= 0; i -= 1) {
            const job = this.pendingAcquires[i];
            if (job === undefined || earliest - job.enqueuedAt < ROUTER_WAIT_CAP_MS) continue;
            this.pendingAcquires.splice(i, 1);
            this.deps.log(`[pool] no door budget for ${job.path} — skip`);
            job.resolve(null);
          }
        }
        if (this.pendingAcquires.length > 0) {
          const expiryAt = Math.min(...this.pendingAcquires.map((job) => job.enqueuedAt + ROUTER_WAIT_CAP_MS));
          await this.deps.sleep(Math.max(1, Math.min(ROUTER_POLL_MS, expiryAt - this.deps.now())));
        }
      }
    } finally {
      this.drainingAcquires = false;
    }
  }

  /**
   * Earliest instant one ALIVE door can become pickable; 0 = unknown (a
   * cold/warming door paces the loop → caller keeps polling). Budget-blocked
   * healthy/probation doors free up when their oldest hit leaves the window.
   */
  private earliestSlot(): number {
    let earliest = 0;
    for (const d of this.doors) {
      if (d.conn === null || d.state === 'retired') continue;
      let ready: number;
      switch (d.state) {
        case 'throttled':
          ready = d.quarantineUntil;
          break;
        case 'penalized':
          ready = d.backoffUntil;
          break;
        case 'healthy':
        case 'probation':
          // only reached when budget-blocked (else pick would return this door)
          ready = d.hits.length > 0 ? d.hits[0].t + this.deps.config.budgetWindowMs : 0;
          break;
        case 'cold':
        case 'warming':
          ready = 0;
          break;
      }
      if (ready === 0) return 0; // unknown — keep legacy poll, no false 503
      if (earliest === 0 || ready < earliest) earliest = ready;
    }
    return earliest;
  }

  /** Least-outstanding among eligible doors; tie → least-recently-used. */
  private pick(path: string, excludeId: number): Door | null {
    const cutoff = this.deps.now() - this.deps.config.budgetWindowMs;
    let best: Door | null = null;
    for (const d of this.doors) {
      if (d.id === excludeId || d.conn === null) continue;
      if (d.state !== 'healthy' && d.state !== 'probation') continue;
      const inWindow = d.hits.filter((h) => h.t > cutoff);
      if (inWindow.length >= this.deps.config.doorCapPerMin) continue; // D6 total cap
      if (inWindow.filter((h) => h.path === path).length >= this.deps.config.pathBudget) continue; // D6 per-path
      if (
        best === null ||
        d.outstanding < best.outstanding ||
        (d.outstanding === best.outstanding && d.useSeq < best.useSeq)
      ) {
        best = d;
      }
    }
    return best;
  }

  /** Lazy transitions + budget prune: quarantine expiry, penalized-backoff expiry. */
  private tick(): void {
    const now = this.deps.now();
    const cutoff = now - this.deps.config.budgetWindowMs;
    for (const d of this.doors) {
      if (d.hits.length > 0 && d.hits[0].t <= cutoff) d.hits = d.hits.filter((h) => h.t > cutoff);
      if (d.state === 'throttled' && now >= d.quarantineUntil) {
        d.state = 'probation';
        this.logDoor(d, 'quarantine-over');
      } else if (d.state === 'penalized' && now >= d.backoffUntil) {
        this.rewarm(d); // D3: backoff over → warming (fresh page) → probation
      }
    }
  }

  // -- request lifecycle (D5) -------------------------------------------------

  private async dispatch(d: Door, url: string, body: unknown, path: string, signal?: AbortSignal, requestId?: number): Promise<DoorHttpResponse> {
    const startedAt = performance.now();
    const fields = { ...(requestId === undefined ? {} : { requestId }), doorId: d.id, path };
    d.hits.push({ t: this.deps.now(), path });
    d.requests += 1;
    d.outstanding += 1;
    d.useSeq = ++this.seq;
    const conn = d.conn;
    if (!conn) {
      d.outstanding -= 1;
      const res: DoorHttpResponse = { status: 0, contentType: '', retryAfter: null, head: 'door has no connection', len: 0, json: null, threw: true };
      log.info('door dispatch', { ...fields, outcome: 'complete', status: res.status, classification: classify(res), runMs: Math.round(performance.now() - startedAt) });
      return res;
    }
    try {
      const res = await conn.fetch(url, body, this.deps.config.requestTimeoutMs, signal);
      this.throwIfAborted(signal);
      d.lastStatus = res.status;
      log.info('door dispatch', { ...fields, outcome: 'complete', status: res.status, classification: classify(res), runMs: Math.round(performance.now() - startedAt) });
      return res;
    } catch (e) {
      if (signal?.aborted) {
        d.requests -= 1;
        log.info('door dispatch', { ...fields, outcome: 'aborted', runMs: Math.round(performance.now() - startedAt) });
        throw signal.reason ?? e;
      }
      const res: DoorHttpResponse = { status: 0, contentType: '', retryAfter: null, head: String((e as Error)?.message ?? e).slice(0, 120), len: 0, json: null, threw: true };
      log.info('door dispatch', { ...fields, outcome: 'complete', status: res.status, classification: classify(res), runMs: Math.round(performance.now() - startedAt) });
      return res;
    } finally {
      d.outstanding -= 1;
    }
  }

  private applyOutcome(d: Door, cls: Classification, res: DoorHttpResponse, path: string): void {
    switch (cls) {
      case 'ok':
        d.transportFails = 0;
        d.real403Streak = 0;
        d.rewarmFails = 0;
        if (d.state === 'probation') {
          d.state = 'healthy'; // D3: first 200 after probation promotes
          this.logDoor(d, 'promoted', path, res.status);
        }
        break;
      case 'throttle': {
        // D3: quarantine = retry-after (+ jitter ≤ crawlQuarantineJitterMs); header missing → 1800s.
        const retryAfterS = res.retryAfter !== null && Number.isFinite(res.retryAfter) ? res.retryAfter : DEFAULT_QUARANTINE_S;
        const jitterMs = Math.random() * this.deps.config.quarantineJitterMs;
        d.state = 'throttled';
        d.quarantineUntil = this.deps.now() + retryAfterS * 1000 + jitterMs;
        this.logDoor(d, `throttled retry-after=${retryAfterS}s`, path, res.status);
        break;
      }
      case 'interstitial':
        this.rewarm(d); // CF challenge mid-flight — fresh page, no reputation hit
        break;
      case 'real403':
        d.real403Streak += 1;
        if (d.real403Streak === 1) this.rewarm(d); // D5: re-warm once…
        else this.penalize(d); // …repeat → penalized (D3)
        break;
      case '5xx':
      case 'transport':
        // A page/CDP-origin throw means OUR page died, not that the proxy is dead —
        // reroute to a fresh page instead of spending a transport fail on it.
        if (cls === 'transport' && res.threw && res.head.startsWith(BROWSER_FAILURE_PREFIX)) {
          this.logDoor(d, `page-fail (local) — re-warm, no transport-fail`, path, res.status);
          this.rewarm(d);
          break;
        }
        d.transportFails += 1;
        this.logDoor(d, `${cls}-fail n=${d.transportFails}`, path, res.status);
        if (d.transportFails >= 2) this.retire(d, 'broken-proxy'); // D5: ≥2 consecutive
        break;
    }
  }

  /** Initial warmup: connect (the real factory does goto + CF-clear polling inside). */
  private async warm(d: Door): Promise<void> {
    if (this.stopped) return;
    const generation = ++d.generation;
    d.state = 'warming';
    const attempt = Promise.resolve().then(() => this.deps.connect(d.spec));
    void attempt.then((late) => {
      if (this.stopped || d.generation !== generation) {
        void withTimeout(late.close(), this.deps.config.warmupTimeoutMs).catch(() => {});
      }
    }, () => {});
    try {
      const conn = await withTimeout(attempt, this.deps.config.warmupTimeoutMs);
      if (this.stopped || d.generation !== generation) {
        void withTimeout(conn.close(), this.deps.config.warmupTimeoutMs).catch(() => {});
        return;
      }
      d.conn = conn;
      d.egressIp = (conn as DoorConnWithEgress).egressIp ?? null;
      d.state = 'probation';
      d.retiredReason = null;
      this.logDoor(d, 'warmup-ok');
      if (d.egressIp) this.logDoor(d, `egress ip=${d.egressIp}`);
    } catch (e) {
      if (this.stopped || d.generation !== generation) return;
      d.generation += 1;
      d.state = 'retired';
      d.retiredReason = 'broken-proxy';
      d.retiredAt = this.deps.now();
      this.logDoor(d, `warmup-fail reason=broken-proxy err=${String((e as Error)?.message ?? e).slice(0, 120)}`);
    }
  }

  private rewarm(d: Door): void {
    if (this.stopped || d.state === 'warming') return;
    const conn = d.conn;
    if (!conn) {
      void this.warm(d);
      return;
    }
    let generation = ++d.generation;
    d.state = 'warming';
    this.logDoor(d, 're-warm');
    void withTimeout(conn.invalidate(), this.deps.config.warmupTimeoutMs).then(
      () => {
        if (this.stopped || d.generation !== generation || d.conn !== conn) return;
        d.rewarmFails = 0;
        if (d.state === 'warming') {
          d.state = 'probation';
          this.logDoor(d, 're-warm-ok');
        }
      },
      async (error: unknown) => {
        if (this.stopped || d.generation !== generation || d.conn !== conn) return;
        const message = String((error as Error)?.message ?? error);
        if (/timeout|disconnected|browser.*closed|target closed/i.test(message)) {
          const replacementAttempt = Promise.resolve().then(() => this.deps.connect(d.spec));
          void replacementAttempt.then((late) => {
            if (this.stopped || d.generation !== generation) {
              void withTimeout(late.close(), this.deps.config.warmupTimeoutMs).catch(() => {});
            }
          }, () => {});
          try {
            const replacement = await withTimeout(replacementAttempt, this.deps.config.warmupTimeoutMs);
            if (this.stopped || d.generation !== generation || d.conn !== conn) {
              void withTimeout(replacement.close(), this.deps.config.warmupTimeoutMs).catch(() => {});
              return;
            }
            d.conn = replacement;
            d.egressIp = (replacement as DoorConnWithEgress).egressIp ?? null;
            void withTimeout(conn.close(), this.deps.config.warmupTimeoutMs).catch(() => {});
            d.rewarmFails = 0;
            d.state = 'probation';
            this.logDoor(d, 're-warm-reconnect-ok');
            return;
          } catch {
            if (!this.stopped && d.generation === generation && d.conn === conn) {
              generation = ++d.generation;
            }
            // Apply the established invalidate failure policy below.
          }
        }
        if (this.stopped || d.generation !== generation) return;
        d.rewarmFails += 1;
        if (d.rewarmFails >= 2) {
          this.retire(d, 'broken-proxy');
          return;
        }
        this.logDoor(d, `re-warm-fail n=${d.rewarmFails}`);
        if (d.state === 'warming') d.state = 'probation';
      },
    );
  }


  private penalize(d: Door): void {
    const backoffMs = BACKOFF_STAGES_MS[d.penaltyStage];
    if (backoffMs === undefined) {
      this.retire(d, 'real403-reputation'); // D3: after the 30m stage
      return;
    }
    d.penaltyStage += 1;
    d.state = 'penalized';
    d.backoffUntil = this.deps.now() + backoffMs;
    this.logDoor(d, `penalized backoff=${backoffMs / 1000}s streak=${d.real403Streak}`);
  }

  private retire(d: Door, reason: string): void {
    d.generation += 1;
    d.state = 'retired';
    d.retiredReason = reason;
    d.retiredAt = this.deps.now();
    this.logDoor(d, `retired reason=${reason}`);
    const conn = d.conn;
    d.conn = null;
    if (conn) void withTimeout(conn.close(), this.deps.config.warmupTimeoutMs).catch(() => {});
  }

  /**
   * Give each broken-proxy Door another chance after RETIRED_RETRY_MS. The acquire
   * drain checks independently of other Doors, so one warming Door cannot block a
   * retired sibling's recovery; healthy pools pay nothing unless a Door is retired.
   * Reputation retires (real403-reputation) stay terminal — a 403-ing IP must not
   * be re-probed every minute. warm() flips state synchronously to prevent double-arm.
   */
  private rearmRetired(now: number): boolean {
    let armed = false;
    for (const d of this.doors) {
      if (d.state !== 'retired' || d.retiredReason !== 'broken-proxy') continue;
      if (now - d.retiredAt < RETIRED_RETRY_MS) continue;
      d.transportFails = 0;
      d.real403Streak = 0;
      d.rewarmFails = 0;
      this.logDoor(d, `re-arm (retired ${Math.round((now - d.retiredAt) / 1000)}s ago)`);
      void this.warm(d);
      armed = true;
    }
    return armed;
  }

  // -- observability (D10) ----------------------------------------------------

  private budgetUsed(d: Door): number {
    const cutoff = this.deps.now() - this.deps.config.budgetWindowMs;
    return d.hits.filter((h) => h.t > cutoff).length;
  }

  private logDoor(d: Door, event: string, path = '-', status: number | null = null): void {
    this.deps.log(
      `[door ${d.id}] ${event} path=${path} status=${status ?? '-'} budget=${this.budgetUsed(d)}/${this.deps.config.doorCapPerMin} outstanding=${d.outstanding} state=${d.state}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Real transport (D1): browserless WS + sticky proxy + CF-clear warmup.
// Pattern proven by .probe/multi-proxy-probe.mjs + .probe/challenge-probe.mjs.
// ---------------------------------------------------------------------------

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TOKEN_GOD_MODE = 'https://app.nansen.ai/token-god-mode';

/** browserless v1 takes chrome flags via query string; credentials NEVER go in the query. */
function doorWsEndpoint(spec: DoorSpec): string {
  if (!spec.proxy) return spec.ws;
  const bare = spec.proxy.url.replace(/\/\/[^/?#]*@/, '//');
  return `${spec.ws}${spec.ws.includes('?') ? '&' : '?'}--proxy-server=${encodeURIComponent(bare)}`;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Runs INSIDE the nansen page (puppeteer serializes it — keep self-contained).
 * Never throws on HTTP status; `threw:true` only for transport/timeout. Reads
 * retry-after in-page (the old transport dropped it — issues.md gotcha).
 */
async function inPageFetch(args: { url: string; body: unknown; requestId: string }) {
  const state = window as unknown as { __signalScanDoorFetchControllers?: Record<string, AbortController> };
  const controllers = state.__signalScanDoorFetchControllers ??= {};
  const controller = new AbortController();
  controllers[args.requestId] = controller;
  const t0 = Date.now();
  try {
    const r = await fetch(args.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(args.body),
      signal: controller.signal,
    });
    const txt = await r.text();
    let json: unknown = null;
    try {
      json = JSON.parse(txt);
    } catch {
      /* non-JSON body (CF interstitial / html error page) */
    }
    const rawRetry = r.headers.get('retry-after');
    const retryAfter = rawRetry === null ? NaN : Number(rawRetry);
    return {
      status: r.status,
      contentType: r.headers.get('content-type') ?? '',
      retryAfter: Number.isFinite(retryAfter) ? retryAfter : null,
      head: txt.slice(0, 180),
      len: txt.length,
      json,
      threw: false,
      ms: Date.now() - t0,
    };
  } catch (e) {
    return {
      status: 0,
      contentType: '',
      retryAfter: null,
      head: String((e as Error)?.message ?? e).slice(0, 120),
      len: 0,
      json: null,
      threw: true,
      ms: Date.now() - t0,
    };
  } finally {
    delete controllers[args.requestId];
  }
}

async function realConnect(spec: DoorSpec): Promise<DoorConn> {
  const browser = await puppeteer.connect({
    browserWSEndpoint: doorWsEndpoint(spec),
    defaultViewport: { width: 1280, height: 800 },
  });
  const auth = spec.proxy?.username ? { username: spec.proxy.username, password: spec.proxy.password ?? '' } : null;
  let page: Page | null = null;

  const buildPage = async (): Promise<Page> => {
    const p = await browser.newPage();
    // Headless tell-tales CF checks: UA containing HeadlessChrome + navigator.webdriver.
    await p.setUserAgent(UA);
    await p.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    if (auth) await p.authenticate(auth);
    return p;
  };

  // D3 warmup: goto → return as soon as cf_clearance exists (the proven
  // .probe/multi-proxy-probe.mjs + harness gate). Do NOT additionally gate on
  // title or settle: measured 2026-09-22 through the owner server proxy, a
  // title-gated + settle gate made the FIRST in-page XHR come back 403 HTML
  // (interstitial) while the harness's cf_clearance-only gate returned 200 JSON
  // on the same chrome+proxy in the same minute. An idle cleared page re-challenges.
  const warm = async (p: Page): Promise<void> => {
    const t0 = Date.now();
    await p.goto(TOKEN_GOD_MODE, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    for (;;) {
      const cookies: Array<{ name: string }> = await browser.cookies().catch(() => []);
      if (cookies.some((c) => c.name === 'cf_clearance')) return;
      if (Date.now() - t0 >= config.crawlWarmupTimeoutMs) {
        throw new Error(`warmup timeout ${config.crawlWarmupTimeoutMs}ms (no cf_clearance)`);
      }
      await new Promise((r) => setTimeout(r, WARM_POLL_MS));
    }
  };

  try {
    page = await buildPage();
    await warm(page);
  } catch (e) {
    // A failed build would otherwise leak the page/browser (prod OOM 2026-09-19).
    await page?.close().catch(() => {});
    await browser.disconnect().catch(() => {});
    throw e;
  }

  // Egress check — informational only (D3): each door should show its own IP.
  const egressRaw = await withTimeout(
    page.evaluate(async () => {
      try {
        return (await (await fetch('https://api.ipify.org')).text()).trim();
      } catch (e) {
        return `ERR:${String((e as Error)?.message ?? e).slice(0, 80)}`;
      }
    }),
    10_000,
  ).catch((e) => `TIMEOUT:${String((e as Error)?.message ?? e).slice(0, 60)}`);
  const egressIp = egressRaw && !egressRaw.startsWith('ERR:') && !egressRaw.startsWith('TIMEOUT:') ? egressRaw : null;
  let requestSequence = 0;
  const conn: DoorConnWithEgress = {
    egressIp,
    async fetch(url, body, timeoutMs, signal) {
      const cur = page;
      if (!cur) {
        return { status: 0, contentType: '', retryAfter: null, head: `${BROWSER_FAILURE_PREFIX} page unavailable (invalidated)`, len: 0, json: null, threw: true };
      }
      if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
      const requestId = `door-${++requestSequence}`;
      const abortBrowserRequest = () => {
        void cur.evaluate((id: string) => {
          const state = window as unknown as { __signalScanDoorFetchControllers?: Record<string, AbortController> };
          state.__signalScanDoorFetchControllers?.[id]?.abort();
        }, requestId).catch(() => {});
      };
      signal?.addEventListener('abort', abortBrowserRequest, { once: true });
      try {
        const response = await withTimeout(cur.evaluate(inPageFetch, { url, body, requestId }), timeoutMs);
        if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
        return response;
      } catch (e) {
        abortBrowserRequest();
        if (signal?.aborted) throw signal.reason ?? e;
        return { status: 0, contentType: '', retryAfter: null, head: `${BROWSER_FAILURE_PREFIX} ${String((e as Error)?.message ?? e).slice(0, 120)}`, len: 0, json: null, threw: true };
      } finally {
        signal?.removeEventListener('abort', abortBrowserRequest);
      }
    },
    async invalidate() {
      if (!browser.isConnected()) throw new Error(`${BROWSER_FAILURE_PREFIX} browser disconnected`);
      const old = page;
      page = null;
      await old?.close().catch(() => {});
      page = await buildPage();
      await warm(page); // throws → the pool retires this door (broken-proxy)
    },
    async close() {
      const old = page;
      page = null;
      await old?.close().catch(() => {});
      await browser.disconnect().catch(() => {});
    },
  };
  return conn;
}

// ---------------------------------------------------------------------------
// Public transport API
// ---------------------------------------------------------------------------

let poolSingleton: DoorPool | null = null;

/** TEST SEAM (plan setup-fill-on-add T3): install a prebuilt pool — the rehydrate
 * tests run a DoorPool over fake conns that COUNT fetches. null = lazy prod build. */
export function setPoolForTest(pool: DoorPool | null): void {
  poolSingleton = pool;
}
let freshWalletPoolSingleton: DoorPool | null = null;

/** Fresh Wallet's dedicated direct-browser pool; null until first FW request. */
export function freshWalletPoolStatsOrNull(): DoorStat[] | null {
  return freshWalletPoolSingleton ? freshWalletPoolSingleton.stats() : null;
}

/** Test seam for the FW-only pool. */
export function setFreshWalletPoolForTest(pool: DoorPool | null): void {
  freshWalletPoolSingleton = pool;
}

function getFreshWalletPool(): DoorPool {
  if (freshWalletPoolSingleton) return freshWalletPoolSingleton;
  const wsEndpoints = config.crawlFreshWalletWsEndpoints.length > 0
    ? config.crawlFreshWalletWsEndpoints
    : [config.crawlWsEndpoint];
  log.info(`[crawl:fw] loaded ${wsEndpoints.length} direct Browserless endpoints`);
  freshWalletPoolSingleton = new DoorPool({
    connect: realConnect,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    config: {
      wsEndpoint: wsEndpoints[0] ?? config.crawlWsEndpoint,
      wsEndpoints,
      proxies: [],
      pathBudget: config.crawlPathBudget,
      budgetWindowMs: config.crawlBudgetWindowMs,
      doorCapPerMin: config.crawlDoorCapPerMin,
      warmupTimeoutMs: config.crawlWarmupTimeoutMs,
      requestTimeoutMs: config.crawlRequestTimeoutMs,
      quarantineJitterMs: config.crawlQuarantineJitterMs,
    },
    log: (line) => log.info('[crawl:fw]', line),
  });
  freshWalletPoolSingleton.start();
  return freshWalletPoolSingleton;
}

/**
 * Live door table for the gateway /health. Returns null when the pool was never
 * built — this must stay side-effect-free so a health probe cannot spawn a
 * chrome pool.
 */
export function poolStatsOrNull(): DoorStat[] | null {
  return poolSingleton ? poolSingleton.stats() : null;
}

/** Lazy singleton (D11): built from config on first use, warms doors in background. */
function getPool(): DoorPool {
  if (poolSingleton) return poolSingleton;
  let proxies: ProxySpec[] = [];
  if (config.crawlProxyFile) {
    try {
      proxies = parseProxyFile(readFileSync(config.crawlProxyFile, 'utf8'));
    } catch (e) {
      log.warn(
        `[crawl] CRAWL_PROXY_FILE=${config.crawlProxyFile} unreadable (${String((e as Error)?.message ?? e)}) — single-door fallback`,
      );
    }
  }
  log.info(`[crawl] loaded ${proxies.length} proxies → ${Math.max(1, proxies.length)} doors`);
  poolSingleton = new DoorPool({
    connect: realConnect,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    config: {
      wsEndpoint: config.crawlWsEndpoint,
      proxies,
      pathBudget: config.crawlPathBudget,
      budgetWindowMs: config.crawlBudgetWindowMs,
      doorCapPerMin: config.crawlDoorCapPerMin,
      warmupTimeoutMs: config.crawlWarmupTimeoutMs,
      requestTimeoutMs: config.crawlRequestTimeoutMs,
      quarantineJitterMs: config.crawlQuarantineJitterMs,
    },
    log: (line) => log.info('[crawl]', line),
  });
  poolSingleton.start();
  return poolSingleton;
}

/**
 * Injection point for NansenMarketProvider and nansenSeries. Existing two-arg
 * calls remain compatible; gateway calls may pass caller/priority metadata.
 * Delegates to DoorPool; caller cancellation rejects. Exhausted pool degrades to
 * {status:503,json:null}; failed requery to {status:<original|502>}. Callers
 * already throw on non-200, so the poller logs + moves on.
 */
export async function browserPostJson<T = unknown>(
  url: string,
  body: unknown,
  options?: DoorRequestOptions,
): Promise<{ status: number; json: T | null; classification: DoorClassification }> {
  return timed('crawl postJson', { path: pathKey(url) }, async () => {
    const { status, json, classification } = await getPool().postJson(url, body, options);
    return { status, json: json as T | null, classification };
  });
}
/** Dedicated direct Browserless pool for Fresh Wallet's free endpoint. */
export async function freshWalletBrowserPostJson<T = unknown>(
  url: string,
  body: unknown,
  options?: DoorRequestOptions,
): Promise<{ status: number; json: T | null; classification: DoorClassification }> {
  return timed('crawl fw postJson', { path: pathKey(url) }, async () => {
    const { status, json, classification } = await getFreshWalletPool().postJson(url, body, options);
    return { status, json: json as T | null, classification };
  });
}
