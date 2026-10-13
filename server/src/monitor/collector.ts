import { readFile, stat } from 'node:fs/promises';
import type { MonitorConfig } from './config.js';
import type { MetricSample, ServiceSample } from './types.js';
import { MonitorStore } from './store.js';

interface RpcUsageMetric {
  provider: 'evm' | 'solana';
  source: 'application' | 'fomo';
  chain: string;
  endpointIndex: number;
  requests: number;
  successes: number;
  failures: number;
  creditExhausted: number;
  endpointId?: string;
  lastAt: number | null;
}

interface CollectedMetric extends MetricSample {
  rpcEndpointId?: string;
  rpcEndpointIndex?: number;
  rpcSuccesses?: number;
  rpcFailures?: number;
  rpcCreditExhausted?: number;
  heliusProjectId?: string | null;
  heliusEndpointIndexes?: number[];
  heliusFetchedAtMs?: number | null;
}


interface FomoUsageFile {
  fetchedAtMs: number;
  attemptedAtMs: number;
  plan: string | null;
  credits: { monthly: number; usedThisMonth: number; prepaid: number; remaining: number };
  source: 'fomo-v2-me';
  error: string | null;
}

type Fetcher = typeof fetch;

function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return Reflect.get(value, key);
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function heliusErrorDetail(error: string): string {
  if (error === 'project_ids_not_configured') {
    return 'Configure HELIUS_PROJECT_IDS with one project ID per Solana RPC endpoint, in endpoint order.';
  }
  if (error === 'project_id_count_mismatch') return 'HELIUS_PROJECT_IDS count must match SOLANA_RPC_URL endpoint count.';
  if (error === 'rpc_api_key_missing') return 'A configured Solana RPC endpoint has no API key.';
  if (error === 'invalid_project_id') return 'A configured Helius project ID is invalid.';
  if (error === 'helius_http_400') return 'The Helius project ID does not match the endpoint API key.';
  if (error === 'helius_http_401') return 'The Helius API key is missing or invalid.';
  if (error === 'helius_http_403') return 'Enable the Helius Admin API for this project.';
  if (error === 'helius_http_429') return 'Helius Admin API rate limit reached; the previous balance is retained.';
  return 'Helius Admin API balance is unavailable or could not be refreshed.';
}

function parseFomoUsage(raw: unknown): FomoUsageFile | null {
  const source = field(raw, 'source');
  const fetchedAtMs = field(raw, 'fetchedAtMs');
  const attemptedAtMs = field(raw, 'attemptedAtMs');
  const plan = field(raw, 'plan');
  const credits = field(raw, 'credits');
  const monthly = field(credits, 'monthly');
  const usedThisMonth = field(credits, 'usedThisMonth');
  const prepaid = field(credits, 'prepaid');
  const remaining = field(credits, 'remaining');
  const error = field(raw, 'error');
  if (source !== 'fomo-v2-me' || !finiteNonNegative(fetchedAtMs) || !finiteNonNegative(attemptedAtMs)) return null;
  if (plan !== null && typeof plan !== 'string') return null;
  if (!finiteNonNegative(monthly) || !finiteNonNegative(usedThisMonth) ||
      !finiteNonNegative(prepaid) || !finiteNonNegative(remaining)) return null;
  if (typeof error !== 'string' && error !== null) return null;
  return {
    fetchedAtMs,
    attemptedAtMs,
    plan,
    credits: { monthly, usedThisMonth, prepaid, remaining },
    source: 'fomo-v2-me',
    error,
  };
}

function parseRpcUsageMetric(raw: unknown): RpcUsageMetric | null {
  const provider = field(raw, 'provider');
  const source = field(raw, 'source');
  const chain = field(raw, 'chain');
  const endpointIndex = field(raw, 'endpointIndex');
  const endpointId = field(raw, 'endpointId');
  const requests = field(raw, 'requests');
  const successes = field(raw, 'successes');
  const failures = field(raw, 'failures');
  const creditExhausted = field(raw, 'creditExhausted');
  const lastAt = field(raw, 'lastAt');
  const normalizedLastAt = lastAt === null ? null : finiteNonNegative(lastAt) ? lastAt : undefined;
  const normalizedEndpointId = typeof endpointId === 'string' && /^[a-f0-9]{64}$/.test(endpointId)
    ? endpointId
    : undefined;
  if ((provider !== 'evm' && provider !== 'solana') ||
      (source !== 'application' && source !== 'fomo') ||
      typeof chain !== 'string' || chain.length === 0 ||
      !finiteNonNegative(endpointIndex) || !Number.isInteger(endpointIndex) ||
      !finiteNonNegative(requests) || !finiteNonNegative(successes) ||
      !finiteNonNegative(failures) || !finiteNonNegative(creditExhausted) ||
      normalizedLastAt === undefined ||
      (provider === 'solana' && normalizedEndpointId === undefined)) return null;
  return {
    provider,
    source,
    chain,
    endpointIndex,
    requests,
    successes,
    failures,
    creditExhausted,
    lastAt: normalizedLastAt,
    ...(normalizedEndpointId === undefined ? {} : { endpointId: normalizedEndpointId }),
  };
}


export class MonitorCollector {
  constructor(
    private readonly store: MonitorStore,
    private readonly config: MonitorConfig,
    private readonly fetcher: Fetcher = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async collect(): Promise<void> {
    const ts = this.now();
    const services = await Promise.all([
      this.probe('monitor', 'Monitor service', 'Monitor', `http://127.0.0.1:${this.config.port}/healthz`, true),
      this.probe('api-a', 'Instance A API', 'API', `${this.config.apiAUrl}/api/health`, true),
      this.probe('api-b', 'Instance B API', 'API', `${this.config.apiBUrl}/api/health`, true),
      this.probe('web-a', 'Instance A web', 'Web', this.config.webAUrl, false),
      this.probe('web-b', 'Instance B web', 'Web', this.config.webBUrl, false),
      this.probe('gateway', 'Request gateway', 'Gateway', `${this.config.gatewayUrl}/health`, true),
      this.probe('chrome-a', 'Instance A browser', 'Browser', this.config.chromeAUrl, false),
      this.probe('chrome-b', 'Instance B browser', 'Browser', this.config.chromeBUrl, false),
      this.probe('gateway-chrome', 'Gateway browser', 'Browser', this.config.gatewayChromeUrl, false),
      this.probe('public-https', 'Public HTTPS / Caddy', 'Ingress', this.config.publicSiteUrl, false),
      this.heartbeat('fomo-watch', 'FOMO watcher', this.config.fomoHeartbeatPath, 90_000, ts),
      this.heartbeat('wallet-watch', 'Wallet watcher', this.config.walletHeartbeatPath, 300_000, ts),
    ]);

    const telemetry = await Promise.all([
      this.fetchPrivateMetrics('api-a-telemetry', 'Instance A telemetry', `${this.config.apiAUrl}/api/monitor/metrics`),
      this.fetchPrivateMetrics('api-b-telemetry', 'Instance B telemetry', `${this.config.apiBUrl}/api/monitor/metrics`),
      this.fetchPrivateMetrics('gateway-telemetry', 'Gateway telemetry', `${this.config.gatewayUrl}/monitor/metrics`),
      this.readFomoUsage(ts),
    ]);
    const collected = telemetry.flatMap((result) => result.metrics);
    const metrics = this.aggregateSolanaMetrics(this.aggregateHeliusMetrics(collected));
    services.push(...telemetry.map((result) => result.service));
    this.store.recordServices(services, ts);
    this.store.recordMetrics(metrics, ts);
    this.store.prune(ts);
  }

  private async probe(id: string, name: string, scope: string, url: string, json: boolean): Promise<ServiceSample> {
    const started = this.now();
    try {
      const response = await this.fetcher(url, { signal: AbortSignal.timeout(5_000) });
      const latencyMs = Math.max(0, this.now() - started);
      let body: unknown = null;
      if (json) body = await response.json().catch(() => null);
      else await response.body?.cancel();
      const healthy = field(body, 'healthy');
      const ok = field(body, 'ok');
      const state = field(body, 'status');
      const healthyPayload = healthy !== false && ok !== false && state !== 'degraded';
      const status = response.status >= 500 ? 'down' : response.ok && healthyPayload ? 'healthy' : 'degraded';
      return {
        id,
        name,
        scope,
        status,
        checkedAt: new Date(started).toISOString(),
        latencyMs,
        detail: response.ok ? (healthyPayload ? 'HTTP OK' : 'Application reports degraded') : `HTTP ${response.status}`,
      };
    } catch (error) {
      const kind = error instanceof Error ? error.name : 'Error';
      return {
        id,
        name,
        scope,
        status: 'down',
        checkedAt: new Date(started).toISOString(),
        latencyMs: Math.max(0, this.now() - started),
        detail: `Probe failed: ${kind}`,
      };
    }
  }

  private async heartbeat(id: string, name: string, path: string, ttlMs: number, now: number): Promise<ServiceSample> {
    try {
      const info = await stat(path);
      const ageMs = Math.max(0, now - info.mtimeMs);
      const status = ageMs <= ttlMs ? 'healthy' : 'down';
      return {
        id,
        name,
        scope: 'Watcher',
        status,
        checkedAt: new Date(now).toISOString(),
        latencyMs: null,
        detail: `Heartbeat ${Math.floor(ageMs / 1_000)}s ago`,
      };
    } catch {
      return {
        id,
        name,
        scope: 'Watcher',
        status: 'unknown',
        checkedAt: new Date(now).toISOString(),
        latencyMs: null,
        detail: 'Heartbeat file unavailable',
      };
    }
  }

  private async fetchPrivateMetrics(
    id: string,
    name: string,
    url: string,
  ): Promise<{ service: ServiceSample; metrics: CollectedMetric[] }> {
    const started = this.now();
    try {
      const response = await this.fetcher(url, {
        headers: { Authorization: `Bearer ${this.config.apiToken}` },
        signal: AbortSignal.timeout(5_000),
      });
      const body: unknown = await response.json().catch(() => null);
      const expectedPayload = id === 'gateway-telemetry'
        ? field(body, 'credits') !== undefined || Array.isArray(field(body, 'gmgnKeys'))
        : Array.isArray(field(body, 'rpcUsage'));
      if (!response.ok || !expectedPayload) throw new Error(`HTTP ${response.status}`);
      const metrics = id === 'gateway-telemetry'
        ? this.gatewayMetrics(body)
        : [
          ...this.rpcMetrics(body, id === 'api-a-telemetry' ? 'api-a' : 'api-b'),
          ...this.heliusMetrics(body),
        ];
      return {
        service: {
          id,
          name,
          scope: 'Telemetry',
          status: 'healthy',
          checkedAt: new Date(started).toISOString(),
          latencyMs: Math.max(0, this.now() - started),
          detail: 'Private metrics endpoint reachable',
        },
        metrics,
      };
    } catch (error) {
      const kind = error instanceof Error && error.message.startsWith('HTTP ') ? error.message : error instanceof Error ? error.name : 'Error';
      return {
        service: {
          id,
          name,
          scope: 'Telemetry',
          status: 'down',
          checkedAt: new Date(started).toISOString(),
          latencyMs: Math.max(0, this.now() - started),
          detail: `Metrics scrape failed: ${kind}`,
        },
        metrics: [],
      };
    }
  }

  private rpcMetrics(body: unknown, instance: string): CollectedMetric[] {
    const usage = field(body, 'rpcUsage');
    if (!Array.isArray(usage)) return [];
    const result: CollectedMetric[] = [];
    for (const raw of usage) {
      const metric = parseRpcUsageMetric(raw);
      if (metric === null) continue;
      const provider = metric.provider === 'solana' ? 'Solana RPC' : `EVM RPC · ${metric.chain}`;
      const key = metric.provider === 'solana'
        ? `solana-endpoint:${metric.endpointId}`
        : `${instance}-${metric.source}-${metric.provider}-${metric.chain}-${metric.endpointIndex}`;
      const exhausted = metric.creditExhausted > 0;
      result.push({
        provider,
        key,
        label: `${instance.toUpperCase()} · ${metric.source === 'fomo' ? 'FOMO' : 'Application'} · ${metric.chain} RPC #${metric.endpointIndex + 1}`,
        unit: 'requests',
        used: metric.requests,
        remaining: null,
        limit: null,
        threshold: null,
        status: exhausted ? 'exhausted' : 'unknown',
        source: `${metric.successes} HTTP responses accepted, ${metric.failures} HTTP/transport failures since process start; JSON-RPC errors may still arrive via HTTP 2xx. Credit-exhaustion responses: ${metric.creditExhausted}. Provider balance is not exposed.`,
        updatedAt: metric.lastAt === null ? null : new Date(metric.lastAt).toISOString(),
        ...(metric.provider === 'solana' ? {
          rpcEndpointId: metric.endpointId,
          rpcEndpointIndex: metric.endpointIndex,
          rpcSuccesses: metric.successes,
          rpcFailures: metric.failures,
          rpcCreditExhausted: metric.creditExhausted,
        } : {}),
      });
    }
    return result;
  }

  private heliusMetrics(body: unknown): CollectedMetric[] {
    const usage = field(body, 'heliusUsage');
    if (!Array.isArray(usage)) return [];
    const result: CollectedMetric[] = [];
    for (const raw of usage) {
      const projectId = field(raw, 'projectId');
      const endpointIndexesRaw = field(raw, 'endpointIndexes');
      const creditsUsedRaw = field(raw, 'creditsUsed');
      const remainingRaw = field(raw, 'remaining');
      const limitRaw = field(raw, 'limit');
      const fetchedAtMsRaw = field(raw, 'fetchedAtMs');
      const error = field(raw, 'error');
      if ((projectId !== null && typeof projectId !== 'string') ||
          !Array.isArray(endpointIndexesRaw) ||
          !endpointIndexesRaw.every((index) => finiteNonNegative(index) && Number.isInteger(index)) ||
          endpointIndexesRaw.length === 0 ||
          (creditsUsedRaw !== null && !finiteNonNegative(creditsUsedRaw)) ||
          (remainingRaw !== null && !finiteNonNegative(remainingRaw)) ||
          (limitRaw !== null && !finiteNonNegative(limitRaw)) ||
          (fetchedAtMsRaw !== null && !finiteNonNegative(fetchedAtMsRaw)) ||
          (error !== null && typeof error !== 'string')) continue;
      const updatedAt = fetchedAtMsRaw === null ? null : new Date(fetchedAtMsRaw).toISOString();
      const cycleStart = field(raw, 'cycleStart');
      const cycleEnd = field(raw, 'cycleEnd');
      const cycle = [cycleStart, cycleEnd].filter((date): date is string => typeof date === 'string').join('–');
      const errorDetail = typeof error === 'string' ? heliusErrorDetail(error) : '';
      result.push({
        provider: 'Helius',
        key: 'helius-balance',
        label: 'Helius project balance',
        unit: 'credits',
        used: creditsUsedRaw as number | null,
        remaining: remainingRaw as number | null,
        limit: limitRaw as number | null,
        threshold: null,
        status: remainingRaw === null ? 'unknown' : remainingRaw === 0 ? 'exhausted' : error === null ? 'ok' : 'stale',
        source: `Helius Admin API credit cycle${cycle === '' ? '' : ` ${cycle}`}.${errorDetail === '' ? '' : ` ${errorDetail}`}`,
        updatedAt,
        heliusProjectId: projectId,
        heliusEndpointIndexes: endpointIndexesRaw as number[],
        heliusFetchedAtMs: fetchedAtMsRaw as number | null,
      });
    }
    return result;
  }

  private aggregateHeliusMetrics(metrics: readonly CollectedMetric[]): CollectedMetric[] {
    const groups = new Map<string, CollectedMetric[]>();
    const other: CollectedMetric[] = [];
    for (const metric of metrics) {
      if (metric.heliusEndpointIndexes === undefined) {
        other.push(metric);
        continue;
      }
      const groupKey = metric.heliusProjectId ?? 'unconfigured';
      const group = groups.get(groupKey) ?? [];
      group.push(metric);
      groups.set(groupKey, group);
    }
    const ordered = [...groups.entries()].sort(([, left], [, right]) => {
      const leftIndex = Math.min(...left.flatMap((row) => row.heliusEndpointIndexes ?? []));
      const rightIndex = Math.min(...right.flatMap((row) => row.heliusEndpointIndexes ?? []));
      return leftIndex - rightIndex;
    });
    const aggregated = ordered.map(([, rows], index) => {
      const selected = [...rows].sort((left, right) =>
        (right.heliusFetchedAtMs ?? -1) - (left.heliusFetchedAtMs ?? -1))[0]!;
      const endpointIndexes = [...new Set(rows.flatMap((row) => row.heliusEndpointIndexes ?? []))].sort((a, b) => a - b);
      const endpointLabel = endpointIndexes.map((endpointIndex) => `RPC #${endpointIndex + 1}`).join(' + ');
      const { heliusProjectId: _projectId, heliusEndpointIndexes: _endpointIndexes, heliusFetchedAtMs: _fetchedAt, ...sample } = selected;
      return {
        ...sample,
        key: `helius-project-${index + 1}`,
        label: `Helius balance · ${endpointLabel}`,
      };
    });
    return [...other, ...aggregated];
  }

  private aggregateSolanaMetrics(metrics: readonly CollectedMetric[]): MetricSample[] {
    const groups = new Map<string, CollectedMetric[]>();
    const other: MetricSample[] = [];
    for (const metric of metrics) {
      if (metric.rpcEndpointId === undefined) {
        other.push(metric);
        continue;
      }
      const group = groups.get(metric.rpcEndpointId) ?? [];
      group.push(metric);
      groups.set(metric.rpcEndpointId, group);
    }
    const ordered = [...groups.entries()].sort(([leftId, left], [rightId, right]) => {
      const leftIndex = Math.min(...left.map((row) => row.rpcEndpointIndex ?? 0));
      const rightIndex = Math.min(...right.map((row) => row.rpcEndpointIndex ?? 0));
      return leftIndex - rightIndex || leftId.localeCompare(rightId);
    });
    const aggregated = ordered.map(([, rows], index): MetricSample => {
      const successes = rows.reduce((sum, row) => sum + (row.rpcSuccesses ?? 0), 0);
      const failures = rows.reduce((sum, row) => sum + (row.rpcFailures ?? 0), 0);
      const exhausted = rows.reduce((sum, row) => sum + (row.rpcCreditExhausted ?? 0), 0);
      const used = rows.reduce((sum, row) => sum + (row.used ?? 0), 0);
      const updatedAt = rows.map((row) => row.updatedAt).filter((value): value is string => value !== null).sort().at(-1) ?? null;
      return {
        provider: 'Solana RPC',
        key: `solana-rpc-${index + 1}`,
        label: `Solana RPC #${index + 1}`,
        unit: 'requests',
        used,
        remaining: null,
        limit: null,
        threshold: null,
        status: exhausted > 0 ? 'exhausted' : 'unknown',
        source: `Aggregated ${rows.length} API instance/source counters: ${successes} HTTP responses accepted, ${failures} HTTP/transport failures, ${exhausted} credit-exhaustion responses since process start. Helius account balance is shown separately when project IDs are configured; request counters exclude wallet-watch traffic.`,
        updatedAt,
      };
    });
    return [...other, ...aggregated];
  }


  private gatewayMetrics(body: unknown): MetricSample[] {
    return [...this.nansenMetrics(field(body, 'credits')), ...this.gmgnMetrics(field(body, 'gmgnKeys'))];
  }

  private nansenMetrics(credits: unknown): MetricSample[] {
    const usedLedger = field(credits, 'used');
    const budget = field(credits, 'budget');
    const usedA = field(usedLedger, 'a');
    const usedB = field(usedLedger, 'b');
    if (!finiteNonNegative(budget) || !finiteNonNegative(usedA) || !finiteNonNegative(usedB)) return [];
    const capped = budget > 0;
    const used = usedA + usedB;
    const remaining = capped ? Math.max(0, budget - used) : null;
    return [{
      provider: 'Nansen',
      key: 'shared-daily',
      label: 'Nansen shared account · internal daily budget',
      unit: 'credits',
      used,
      remaining,
      limit: capped ? budget : null,
      threshold: capped ? this.config.nansenWarnRemaining : null,
      status: remaining === null ? 'unknown' : remaining === 0 ? 'exhausted' : remaining <= this.config.nansenWarnRemaining ? 'low' : 'ok',
      source: capped
        ? 'Gateway internal daily budget shared across callers; this is not the upstream Nansen account balance.'
        : 'Gateway budget is 0 (unlimited); upstream Nansen credit balance is not exposed by this integration.',
      updatedAt: new Date(this.now()).toISOString(),
    }];
  }


  private gmgnMetrics(rawKeys: unknown): MetricSample[] {
    if (!Array.isArray(rawKeys)) return [];
    const result: MetricSample[] = [];
    for (const raw of rawKeys) {
      const index = field(raw, 'index');
      const served = field(raw, 'served');
      const weight = field(raw, 'weight');
      if (!finiteNonNegative(index) || !Number.isInteger(index) ||
          !finiteNonNegative(served) || !finiteNonNegative(weight)) continue;
      result.push({
        provider: 'GMGN',
        key: `key-${index + 1}`,
        label: `GMGN key ${index + 1}`,
        unit: 'requests',
        used: served,
        remaining: null,
        limit: null,
        threshold: null,
        status: 'unknown',
        source: `Successful calls since gateway start; plan weight ${weight}. GMGN credit balance is not exposed by this integration.`,
        updatedAt: new Date(this.now()).toISOString(),
      });
    }
    return result;
  }

  private async readFomoUsage(now: number): Promise<{ service: ServiceSample; metrics: MetricSample[] }> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.config.fomoUsagePath, 'utf8'));
      const usage = parseFomoUsage(raw);
      if (usage === null) throw new Error('invalid_usage_snapshot');
      const ageMs = Math.max(0, now - usage.fetchedAtMs);
      const stale = ageMs > this.config.fomoStaleMs;
      const capacity = usage.credits.monthly + usage.credits.prepaid;
      const threshold = capacity * this.config.fomoWarnPercent / 100;
      const status = stale ? 'stale' : usage.credits.remaining <= 0 ? 'exhausted' : usage.credits.remaining <= threshold ? 'low' : 'ok';
      const metric: MetricSample = {
        provider: 'FOMO',
        key: 'account',
        label: `FOMO account${usage.plan === null ? '' : ` · ${usage.plan}`}`,
        unit: 'credits',
        used: usage.credits.usedThisMonth,
        remaining: usage.credits.remaining,
        limit: capacity,
        threshold,
        status,
        source: `FOMO API /v2/me account-wide; ${usage.credits.monthly} monthly + ${usage.credits.prepaid} prepaid; alerts WebSocket itself is zero-credit. ${usage.error === null ? '' : `Last poll error: ${usage.error}`}`.trim(),
        updatedAt: new Date(usage.fetchedAtMs).toISOString(),
      };
      return {
        service: {
          id: 'fomo-credit-source',
          name: 'FOMO credit source',
          scope: 'Provider',
          status: stale || usage.error !== null ? 'degraded' : 'healthy',
          checkedAt: new Date(usage.attemptedAtMs).toISOString(),
          latencyMs: null,
          detail: stale ? `Credit snapshot stale (${Math.floor(ageMs / 60_000)}m old)` : usage.error ?? 'FOMO /v2/me snapshot current',
        },
        metrics: [metric],
      };
    } catch (error) {
      const kind = error instanceof Error && error.message === 'invalid_usage_snapshot' ? 'Invalid FOMO usage snapshot' : 'FOMO usage snapshot unavailable';
      return {
        service: {
          id: 'fomo-credit-source',
          name: 'FOMO credit source',
          scope: 'Provider',
          status: 'unknown',
          checkedAt: new Date(now).toISOString(),
          latencyMs: null,
          detail: kind,
        },
        metrics: [],
      };
    }
  }
}
