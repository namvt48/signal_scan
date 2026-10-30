// Nansen credit accounting for the gateway (plan request-plane-gateway, todo 19;
// draft Decision 5, superseded to EQUAL split by the user's decision 2026-09-30).
//
// WHAT THIS DOES
//   * Attributes each Nansen CREDIT call's cost to the CALLER the bearer token
//     resolved to (`auth.ts`: 'a' | 'b'; `watcher` never hits this route).
//   * Caps EACH side at HALF of `config.nansenDailyCreditBudget` (equal split).
//   * Costs the REAL per-call amount from the upstream `x-nansen-credits-cost`
//     header (the todo-3 allowlist forwards it) when present, else the gateway's
//     cost table (`config.NANSEN_CREDIT_COSTS`).
//
// OPTIMISTIC SOFT CAP (do NOT call this a hard cap)
//   The cost is known only AFTER the response, so the check is check-then-act:
//   the pre-flight denies once the caller's day total has REACHED its half, and
//   the real cost is added afterwards. Two calls racing at half-1 can therefore
//   both pass and slightly overshoot. This is deliberate (draft N10).
//
// WHERE IT SITS (the pinned request order, cache.ts)
//   auth -> cache lookup -> budget pre-flight (THIS) -> limiters.run -> upstream.
//   A cache OR single-flight hit short-circuits BEFORE the pre-flight, so a
//   0-credit hit is never budget-denied. Because the pre-flight returns a denial
//   directly - it does NOT go through `limiters.run('nansen-credit', ...)` - it
//   never arms the shared `nansen-credit` gate and never enters the limiter's
//   fibonacci retry loop. That is what keeps caller `b` unaffected when `a` is
//   denied (a self-generated rejection routed through the limiter would arm the
//   shared gate and degrade b).
//
// DAILY RESET
//   The day bucket is the UTC calendar day of an INJECTED clock; every read
//   rolls over first, so a new day starts both counters at zero.

import { NANSEN_CREDIT_COSTS, config } from '../config.js';
import { denial, filterHeaders, type DispatchResult, type UpstreamFetch } from './contract.js';
import { NANSEN_CREDIT_LIMITER } from './nansen.js';
import type { Caller } from './auth.js';

/** Marker header on the budget denial, so it is distinguishable from an upstream
 *  429 (which rides a 200 envelope as `{status:429, body:null}`). */
export const BUDGET_HEADER = 'x-gateway-budget';
export const BUDGET_EXCEEDED = 'exceeded';

/** The credit-attributable callers. `watcher` has no half and is never capped. */
type BillableCaller = 'a' | 'b';

export interface CreditAccountantOptions {
  /** Credits per DAY. Defaults to `config.nansenDailyCreditBudget`. */
  budget?: number;
  /** Injected clock (tests); defaults to `Date.now`. */
  now?: () => number;
  /** Whether to split budget equally across callers. Defaults to true. */
  split?: boolean;
}

export interface CreditSnapshot {
  /** UTC day the counters belong to (`YYYY-MM-DD`). */
  day: string;
  budget: number;
  half: number;
  used: { a: number; b: number };
}

export interface PaidRequestCounters {
  attempts: number;
  responsesWithData: number;
  emptyResponses: number;
  invalidResponses: number;
  errors: number;
  reportedCredits: number;
  estimatedCredits: number;
}

export interface NansenEfficiencySnapshot {
  since: string;
  total: PaidRequestCounters;
  byEndpoint: Record<string, PaidRequestCounters>;
}

function emptyPaidCounters(): PaidRequestCounters {
  return { attempts: 0, responsesWithData: 0, emptyResponses: 0, invalidResponses: 0,
    errors: 0, reportedCredits: 0, estimatedCredits: 0 };
}

/** Response shape only; non-empty data is not proof that a setup factor improved. */
function paidResponseOutcome(body: string): 'responsesWithData' | 'emptyResponses' | 'invalidResponses' | 'errors' {
  let value: unknown;
  try { value = JSON.parse(body); } catch { return 'invalidResponses'; }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'invalidResponses';
  const record = value as Record<string, unknown>;
  if (record.error != null || record.success === false) return 'errors';
  const data = record.data;
  if (data === null || Array.isArray(data) && data.length === 0) return 'emptyResponses';
  if (typeof data !== 'object' || data === undefined) return 'invalidResponses';
  return Object.keys(data).length === 0 ? 'emptyResponses' : 'responsesWithData';
}

function reportedCreditCost(header: string | undefined): number | undefined {
  if (header === undefined || header.trim() === '') return undefined;
  const value = Number(header);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** UTC calendar day key for a millisecond timestamp. */
function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Last path segment, query-string stripped (`/api/v1/tgm/holders?x=1` -> `holders`). */
function lastSegment(endpoint: string): string {
  const q = endpoint.indexOf('?');
  const clean = q === -1 ? endpoint : endpoint.slice(0, q);
  const parts = clean.split('/');
  return parts[parts.length - 1];
}

/** A `holders` request asking for premium labels costs 150 (config.ts). */
function hasPremiumLabels(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const params = (body as Record<string, unknown>).parameters;
  if (typeof params !== 'object' || params === null) return false;
  return Boolean((params as Record<string, unknown>).premium_labels);
}

/**
 * Gateway fallback cost for an endpoint when the upstream omitted
 * `x-nansen-credits-cost` (draft "Upstream limits"): `token-information`=1,
 * `tgm/flows`=1, `holders`=5, `holders` + `premium_labels`=150. An unknown
 * endpoint defaults to 1 (the conservative floor - never free).
 */
export function creditCostFor(endpoint: string, body: unknown): number {
  const segment = lastSegment(endpoint);
  if (segment === 'holders' && hasPremiumLabels(body)) {
    return NANSEN_CREDIT_COSTS['holders-premium'] ?? 150;
  }
  return NANSEN_CREDIT_COSTS[segment] ?? 1;
}

/**
 * Per-caller Nansen credit ledger. One instance per gateway app; read-only with
 * respect to everything downstream. Wire `preflight` as the Nansen cache
 * pre-flight and `wrap` around the credit upstream so the real cost is charged
 * on every upstream response.
 */
export class CreditAccountant {
  private readonly budget: number;
  private readonly now: () => number;
  private day: string;
  private readonly used: { a: number; b: number } = { a: 0, b: 0 };
  private readonly split: boolean;
  private readonly paid = emptyPaidCounters();
  private readonly paidByEndpoint = new Map<string, PaidRequestCounters>();
  private readonly startedAt: number;

  constructor(opts: CreditAccountantOptions = {}) {
    this.budget = opts.budget ?? config.nansenDailyCreditBudget;
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
    this.split = opts.split ?? true;
    this.day = dayKey(this.now());
  }

  /**
   * Pre-flight for the Nansen credit route. Returns the `{error:"budget_exceeded"}`
   * denial (429 + `x-gateway-budget: exceeded`) once the caller has consumed its
   * half, else `undefined` to allow. A different provider, or `watcher`, is never
   * capped.
   */
  readonly preflight = (
    provider: string,
    _rawBody: unknown,
    caller: Caller,
  ): DispatchResult | undefined => {
    if (provider !== NANSEN_CREDIT_LIMITER) return undefined;
    if (!this.billable(caller)) return undefined;
    if (this.budget <= 0) return undefined; // 0 = UNLIMITED (no per-caller cap)
    this.rollover();
    if (this.used[caller] >= this.half()) {
      return denial(429, 'budget_exceeded', { [BUDGET_HEADER]: BUDGET_EXCEEDED });
    }
    return undefined;
  };

  /**
   * Wrap the credit upstream so each REAL response charges the caller's day
   * bucket: the allowlisted `x-nansen-credits-cost` when present, else the cost
   * table on a 2xx. A non-2xx without a cost header is not charged (nothing was
   * consumed). A cache hit / single-flight joiner never reaches here, so it stays
   * 0-credit.
   */
  wrap(inner: UpstreamFetch): UpstreamFetch {
    return async (req, caller) => {
      const segment = lastSegment(req.endpoint);
      // Only configured names become labels: never store arbitrary paths, CA values or queries.
      const endpoint = Object.hasOwn(NANSEN_CREDIT_COSTS, segment) ? segment : 'other';
      let counters = this.paidByEndpoint.get(endpoint);
      if (!counters) {
        counters = emptyPaidCounters();
        this.paidByEndpoint.set(endpoint, counters);
      }
      this.paid.attempts += 1;
      counters.attempts += 1;
      try {
        const res = await inner(req, caller);
        const header = filterHeaders(res.headers)['x-nansen-credits-cost'];
        this.charge(caller, req.endpoint, req.body, res.status, header);
        const outcome = res.status >= 200 && res.status < 300
          ? res.body === null ? 'invalidResponses' : paidResponseOutcome(res.body)
          : 'errors';
        const reported = reportedCreditCost(header);
        const estimated = reported === undefined && res.status >= 200 && res.status < 300
          ? creditCostFor(req.endpoint, req.body) : 0;
        this.paid[outcome] += 1;
        this.paid.reportedCredits += reported ?? 0;
        this.paid.estimatedCredits += estimated;
        counters[outcome] += 1;
        counters.reportedCredits += reported ?? 0;
        counters.estimatedCredits += estimated;
        return res;
      } catch (error) {
        this.paid.errors += 1;
        counters.errors += 1;
        throw error;
      }
    };
  }

  /** Live per-caller usage (observability / todo-20 metrics / tests). */
  snapshot(): CreditSnapshot {
    this.rollover();
    return {
      day: this.day,
      budget: this.budget,
      half: this.half(),
      used: { a: this.used.a, b: this.used.b },
    };
  }

  /** Process-lifetime paid dispatches; estimates exclude upstream-reported credits. */
  efficiencySnapshot(): NansenEfficiencySnapshot {
    return {
      since: new Date(this.startedAt).toISOString(),
      total: { ...this.paid },
      byEndpoint: Object.fromEntries([...this.paidByEndpoint].map(([key, value]) => [key, { ...value }])),
    };
  }

  private half(): number {
    return this.split ? this.budget / 2 : this.budget;
  }

  private billable(caller: Caller): caller is BillableCaller {
    return caller === 'a' || caller === 'b';
  }

  private rollover(): void {
    const today = dayKey(this.now());
    if (today === this.day) return;
    this.day = today;
    this.used.a = 0;
    this.used.b = 0;
  }

  private charge(
    caller: Caller,
    endpoint: string,
    body: unknown,
    status: number,
    header: string | undefined,
  ): void {
    if (!this.billable(caller)) return;
    const real = reportedCreditCost(header);
    const cost = real ?? (status >= 200 && status < 300 ? creditCostFor(endpoint, body) : undefined);
    if (cost === undefined) return;
    this.rollover();
    this.used[caller] += cost;
  }
}
