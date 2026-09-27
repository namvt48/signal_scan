// Browser-transport crawler: Cloudflare blocks every non-browser TLS client on
// app.nansen.ai (curl/node-fetch = 403 — verified), so every request is fetched
// INSIDE a real Chromium (browserless sidecar over CDP), same-origin from a
// nansen page context.
//
// Transport = DOOR POOL (plan nansen-proxy-routing D1–D11): one "door" is one
// browserless WS connection pinned to one proxy IP (`--proxy-server` query +
// page.authenticate), with its own cookie jar / cf_clearance / egress IP. The
// pool classifies every response (D4), quarantines 429s for their retry-after
// (D3), re-queries a different door at most once per request (D5), enforces
// per-(door,path) sliding-window budgets (D6), routes least-outstanding (D7),
// and degrades to {status:503,json:null} when nothing is left — postJson NEVER
// throws. Proxies come from CRAWL_PROXY_FILE, read once at pool creation
// (change file = restart). No file/empty file → single door from
// CRAWL_WS_ENDPOINT (old behaviour + the 429/warmup bug fixes).

import { readFileSync } from 'node:fs';
import puppeteer, { type Page } from 'puppeteer-core';
import { config } from './config.js';
import { log, timed } from './log.js';

import {
  hourlyStatsBody,
  NANSEN_HOURLY_STATS_URL,
  type HourlyStatsRow,
  type SeriesDate,
} from './providers/nansen.js';
import { snapshotSeries } from './detail.js';
import { getNansenSeries, nansenSeriesCachedAt } from './db.js';
import { cacheSeriesWindows, kickNansen } from './poller.js';
import { getSetupCacheEntry, isSetupCacheFresh } from './setup-cache.js';
import type { Chain } from './shared/chain.js';

export interface BalancePoint {
  t: number | string;
  total: number;
  totalUsd?: number;
  /** totalHolders of the top-100 cohort at this hour (row field may be absent). */
  holders?: number;
  /** Σ totalInflows this hour, TOKEN UNITS (row field may be absent). */
  inflow?: number;
}

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
  fetch(url: string, body: unknown, timeoutMs: number): Promise<DoorHttpResponse>;
  invalidate(): Promise<void>;
  close(): Promise<void>;
}

export interface DoorSpec {
  ws: string;
  proxy: ProxySpec | null;
}

export interface DoorPoolConfig {
  wsEndpoint: string;
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

export class DoorPool {
  private readonly deps: DoorPoolDeps;
  private readonly doors: Door[];
  private seq = 0;
  /** One-shot per blackout so an exhausted pool is loud once, not once per request. */
  private exhaustedLogged = false;

  constructor(deps: DoorPoolDeps) {
    this.deps = deps;
    // D2: no proxies → single fallback door from the bare WS endpoint (proxy:null).
    // A `direct` sentinel line yields the same null-proxy door alongside proxied ones.
    const specs: DoorSpec[] =
      deps.config.proxies.length > 0
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
    this.deps.log(`[pool] starting ${this.doors.length} doors (proxies=${this.deps.config.proxies.length})`);
    for (const d of this.doors) void this.warm(d);
  }

  /**
   * Route + fetch + classify + react (D5/D7). Never throws: no live door or
   * router wait-cap → {status:503,json:null}; requery fail → {status:<original|502>,json:null}.
   */
  async postJson(url: string, body: unknown): Promise<{ status: number; json: unknown | null }> {
    const path = pathKey(url);
    const door = await this.acquire(path);
    if (!door) return { status: 503, json: null };
    let res = await this.dispatch(door, url, body, path);
    let cls = classify(res);
    // CF often challenges the FIRST XHR on a freshly cleared page; the SAME page
    // answers the immediate retry 200 (live 2026-09-26). Rewarming here re-arms that
    // challenge and thrashes the pool (197 interstitial ↔ 228 re-warm-ok, 36 retired).
    if (cls === 'interstitial') {
      res = await this.dispatch(door, url, body, path);
      cls = classify(res);
    }
    this.applyOutcome(door, cls, res, path);
    if (cls === 'ok') return { status: res.status, json: res.json };
    // D5: requery AT MOST once, immediately (no wait-loop), never to the same door.
    this.logDoor(door, `requery class=${cls}`, path, res.status);
    const alt = this.pick(path, door.id);
    if (alt) {
      const res2 = await this.dispatch(alt, url, body, path);
      const cls2 = classify(res2);
      this.applyOutcome(alt, cls2, res2, path);
      if (cls2 === 'ok') return { status: res2.status, json: res2.json };
    }
    // D5b: no alternative door (single-door pool) — wait out this door's own
    // re-warm, then retry it once. Owner directive: interstitial must not lose data.
    if (!alt && cls === 'interstitial') {
      for (let i = 0; i < 3 && door.state === 'warming'; i++) await this.deps.sleep(WARM_POLL_MS);
      if (door.state === 'probation' || door.state === 'healthy') {
        this.logDoor(door, 'requery class=interstitial same-door', path, res.status);
        const res3 = await this.dispatch(door, url, body, path);
        const cls3 = classify(res3);
        this.applyOutcome(door, cls3, res3, path);
        if (cls3 === 'ok') return { status: res3.status, json: res3.json };
      }
    }
    return { status: res.status > 0 ? res.status : 502, json: null };
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

  /** Wait-loop: eligible door now, else poll 250ms while doors are alive, cap 65s. */
  private async acquire(path: string): Promise<Door | null> {
    const t0 = this.deps.now();
    for (;;) {
      this.tick();
      const d = this.pick(path, -1);
      if (d) {
        this.exhaustedLogged = false;
        return d;
      }
      // Every door retired: revive the broken-proxy ones whose cooldown elapsed, then
      // poll. Without this, one bad minute on the chrome side = permanent blackout.
      if (!this.doors.some((x) => x.state !== 'retired')) {
        if (this.rearmRetired(this.deps.now())) {
          await this.deps.sleep(ROUTER_POLL_MS);
          continue;
        }
        if (!this.exhaustedLogged) {
          this.exhaustedLogged = true;
          this.deps.log('[pool] ALL DOORS RETIRED — pool exhausted, serving 503 until re-arm');
        }
      }
      // Throttled/penalized/warming doors are ALIVE — wait for their slot, not 503.
      const alive = this.doors.some((x) => x.state !== 'retired');
      // R2: measured retry-after (37-47min) >> cap — if the earliest alive-door
      // slot is already beyond the cap, 503 NOW instead of blind-polling the
      // full 65s per request (D7: wait for the earliest slot, not a wall).
      // earliest===0 (unknown/warming) keeps the old poll → never a false 503.
      const earliest = this.earliestSlot();
      if (!alive || earliest - t0 >= ROUTER_WAIT_CAP_MS || this.deps.now() - t0 >= ROUTER_WAIT_CAP_MS) {
        this.deps.log(`[pool] no door budget for ${path} — skip`);
        return null;
      }
      await this.deps.sleep(ROUTER_POLL_MS);
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

  private async dispatch(d: Door, url: string, body: unknown, path: string): Promise<DoorHttpResponse> {
    d.hits.push({ t: this.deps.now(), path });
    d.requests += 1;
    d.outstanding += 1;
    d.useSeq = ++this.seq;
    const conn = d.conn;
    if (!conn) {
      d.outstanding -= 1;
      return { status: 0, contentType: '', retryAfter: null, head: 'door has no connection', len: 0, json: null, threw: true };
    }
    try {
      const res = await conn.fetch(url, body, this.deps.config.requestTimeoutMs);
      d.lastStatus = res.status;
      return res;
    } catch (e) {
      // R4: dispatch never throws — a rejecting conn is a transport failure.
      return { status: 0, contentType: '', retryAfter: null, head: String((e as Error)?.message ?? e).slice(0, 120), len: 0, json: null, threw: true };
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
    d.state = 'warming';
    try {
      const conn = await this.deps.connect(d.spec);
      d.conn = conn;
      d.egressIp = (conn as DoorConnWithEgress).egressIp ?? null;
      d.state = 'probation';
      d.retiredReason = null; // re-arm path: a live door must not still read as retired
      this.logDoor(d, 'warmup-ok');
      if (d.egressIp) this.logDoor(d, `egress ip=${d.egressIp}`);
    } catch (e) {
      d.state = 'retired';
      d.retiredReason = 'broken-proxy';
      d.retiredAt = this.deps.now();
      this.logDoor(d, `warmup-fail reason=broken-proxy err=${String((e as Error)?.message ?? e).slice(0, 120)}`);
    }
  }

  /**
   * Re-warm an existing connection: drop + rebuild the page behind the scenes
   * (invalidate is async — the door parks in `warming`, so a same-request
   * requery can never land back on it).
   * ponytail: continuation only promotes from `warming`, so a concurrent
   * penalize wins the race; per-door locks if stricter ordering ever matters.
   */
  private rewarm(d: Door): void {
    if (d.state === 'warming') return; // R1: one invalidate at a time — parallel rewarms overwrite `page` and leak pages (prod OOM 2026-09-19)
    const conn = d.conn;
    if (!conn) {
      this.retire(d, 'broken-proxy');
      return;
    }
    d.state = 'warming';
    this.logDoor(d, 're-warm');
    void conn.invalidate().then(
      () => {
        d.rewarmFails = 0;
        if (d.state === 'warming') {
          d.state = 'probation';
          this.logDoor(d, 're-warm-ok');
        }
      },
      () => {
        // D5b: a rejected invalidate is a local page-rebuild hiccup, NOT proof the
        // proxy is dead (that is the ≥2-transport-fails rule). Retiring here killed
        // the whole pool when there is only one door.
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
    d.state = 'retired';
    d.retiredReason = reason;
    d.retiredAt = this.deps.now();
    this.logDoor(d, `retired reason=${reason}`);
    void d.conn?.close().catch(() => {});
  }

  /**
   * Give broken-proxy doors one more chance once RETIRED_RETRY_MS has passed. Called by
   * acquire() only when NO door is alive, so a healthy pool pays nothing. Reputation
   * retires (real403-reputation) stay terminal — a 403-ing IP must not be re-probed
   * every minute. warm() flips the state to 'warming' synchronously, so two concurrent
   * acquires cannot double-arm the same door.
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
    const timer = setTimeout(() => {
      reject(new Error(`timeout ${ms}ms`));
    }, ms);
    p.then(resolve, reject).finally(() => {
      clearTimeout(timer);
    });
  });
}

/**
 * Runs INSIDE the nansen page (puppeteer serializes it — keep self-contained).
 * Never throws on HTTP status; `threw:true` only for transport/timeout. Reads
 * retry-after in-page (the old transport dropped it — issues.md gotcha).
 */
async function inPageFetch(args: { url: string; body: unknown }) {
  const t0 = Date.now();
  try {
    const r = await fetch(args.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(args.body),
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
  const conn: DoorConnWithEgress = {
    egressIp,
    async fetch(url, body, timeoutMs) {
      const cur = page;
      if (!cur) {
        return { status: 0, contentType: '', retryAfter: null, head: `${BROWSER_FAILURE_PREFIX} page unavailable (invalidated)`, len: 0, json: null, threw: true };
      }
      try {
        return await withTimeout(cur.evaluate(inPageFetch, { url, body }), timeoutMs);
      } catch (e) {
        return { status: 0, contentType: '', retryAfter: null, head: `${BROWSER_FAILURE_PREFIX} ${String((e as Error)?.message ?? e).slice(0, 120)}`, len: 0, json: null, threw: true };
      }
    },
    async invalidate() {
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

/**
 * Fail fast while the sidecar is sick: a dead page costs 30–45s per call and one
 * sweep retries every CA, which is how an OOM'd Chrome stretched a 5-min pass into
 * 64 min. Kept exported (crawl-breaker.test.ts); the door pool now supersedes it
 * in the live path — per-door transport-fail retirement replaces the global
 * breaker + page-rebuild loop.
 */
export function createCircuitBreaker(failureLimit: number, cooldownMs: number) {
  let failures = 0;
  let openUntil = 0;
  return {
    open: (): boolean => Date.now() < openUntil,
    ok: (): void => {
      failures = 0;
    },
    fail: (): void => {
      if (++failures < failureLimit) return;
      failures = 0;
      openUntil = Date.now() + cooldownMs;
      log.error(`[crawl] ${failureLimit} transport failures — pausing browser requests ${cooldownMs}ms`);
    },
  };
}

let poolSingleton: DoorPool | null = null;

/** TEST SEAM (plan setup-fill-on-add T3): install a prebuilt pool — the rehydrate
 * tests run a DoorPool over fake conns that COUNT fetches. null = lazy prod build. */
export function setPoolForTest(pool: DoorPool | null): void {
  poolSingleton = pool;
}

/**
 * Live door table for /api/health. Returns null when the pool was never built —
 * this must stay side-effect-free so a health probe cannot spawn a chrome pool.
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
 * Injection point for NansenMarketProvider (index.ts) and nansenSeries —
 * signature frozen. Delegates to the door pool; NEVER throws: exhausted pool
 * degrades to {status:503,json:null}, failed requery to {status:<original|502>}.
 * Callers already throw on non-200 (nansenSeries / NansenWebCrawler), so the
 * poller logs + moves on — and a 429 can no longer escape as data (the old
 * non-403 passthrough bug at crawl.ts:145 pre-pool).
 */
export async function browserPostJson<T = unknown>(url: string, body: unknown): Promise<{ status: number; json: T | null }> {
  return timed('crawl postJson', { path: pathKey(url) }, async () => {
    const { status, json } = await getPool().postJson(url, body);
    return { status, json: json as T | null };
  });
}

/** Pure: hourly-stats rows → chart points (holders/inflow only when finite). */
export function hourlyStatsToPoints(rows: HourlyStatsRow[]): BalancePoint[] {
  return rows
    .filter((r) => typeof r.totalBalance === 'number' && Number.isFinite(r.totalBalance))
    .map((r) => ({
      t: r.blockDate ?? '',
      total: r.totalBalance as number,
      ...(typeof r.totalBalanceUsd === 'number' ? { totalUsd: r.totalBalanceUsd } : {}),
      ...(typeof r.totalHolders === 'number' && Number.isFinite(r.totalHolders) ? { holders: r.totalHolders } : {}),
      ...(typeof r.totalInflows === 'number' && Number.isFinite(r.totalInflows) ? { inflow: r.totalInflows } : {}),
    }));
}

/** LEGACY free-door path (superseded by the official tgm/flows door for T100/LF
 * 2026-09-23) — kept for the probe scripts; no production caller remains. */
export async function nansenSeries(ca: string, chain: Chain, date: SeriesDate, label = 'top_100_holders'): Promise<BalancePoint[]> {
  const { status, json } = await browserPostJson<{ data?: HourlyStatsRow[] }>(NANSEN_HOURLY_STATS_URL, hourlyStatsBody(ca, chain, date, false, label));
  const rows = (json as { data?: HourlyStatsRow[] } | null)?.data;
  if (status !== 200 || !Array.isArray(rows)) throw new Error(`nansen chart ${status}`);
  return hourlyStatsToPoints(rows);
}

/**
 * Balance chart series (top-100 total balance, token units).
 * Primary: Nansen hourly-stats through the browser sidecar.
 * Fallback: our own hourly snapshots (short history, grows over time).
 */
/**
 * CACHE-ONLY endpoint: setupSweep là writer duy nhất (một pass 12h paced trên
 * toàn bộ queue) — dashboard click KHÔNG BAO GIỜ sinh request lên Nansen. Cache
 * miss (CA chưa đến lượt sweep) -> phục series snapshot nội bộ tạm thời.
 */
export async function balanceSeries(
  ca: string,
  chain: Chain,
  window: 'day' | 'week' | 'month',
): Promise<{ source: 'nansen' | 'snapshots'; points: BalancePoint[]; cachedAt?: number }> {
  let cachedAt = nansenSeriesCachedAt(ca, chain, window);
  let cached = getNansenSeries(ca, chain, window);
  // FILE-cache fallback (plan setup-fill-on-add §4): a DB-table reset wipes
  // nansen_series, but data/nansen-cache.json survives — replay a FRESH entry
  // through the SAME window slicer the fetch path uses instead of degrading to
  // internal snapshots or kicking a door refetch.
  if (cached.length <= 1) {
    const e = getSetupCacheEntry(ca, chain);
    if (e && isSetupCacheFresh(e, Date.now())) {
      cacheSeriesWindows(ca, chain, e.series, e.taken_at);
      log.info(`[setup-cache] replayed ${ca.slice(0, 8)} (${chain}) chart windows from the file cache`);
      cachedAt = nansenSeriesCachedAt(ca, chain, window);
      cached = getNansenSeries(ca, chain, window);
    }
  }
  // Stale top-up: serve the cache immediately but kick a background refresh so
  // the series converges toward Nansen live within one sweep interval.
  if (cachedAt !== undefined && Date.now() - cachedAt > 3_600_000) kickNansen(ca, chain);
  const atMs = (p: BalancePoint) => (typeof p.t === 'number' ? p.t : Date.parse(String(p.t)));
  if (cached.length > 1) return { source: 'nansen', points: cached.sort((a, b) => atMs(a) - atMs(b)), cachedAt };
  const since = Date.now() - (window === 'day' ? 86_400_000 : window === 'week' ? 7 * 86_400_000 : 30 * 86_400_000);
  return { source: 'snapshots', points: snapshotSeries(ca, chain, since), cachedAt };
}
