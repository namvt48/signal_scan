import { createHash } from 'node:crypto';

const HELIUS_ADMIN_URL = 'https://admin-api.helius.xyz/v0/admin/projects';
const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POLL_INTERVAL_MS = 60_000;

type Fetcher = typeof fetch;

export interface HeliusProjectUsage {
  projectId: string | null;
  endpointIndexes: number[];
  creditsUsed: number | null;
  remaining: number | null;
  limit: number | null;
  cycleStart: string | null;
  cycleEnd: string | null;
  fetchedAtMs: number | null;
  attemptedAtMs: number;
  error: string | null;
}

class HeliusUsageError extends Error {
  constructor(tag: string) {
    super(tag);
    this.name = tag;
  }
}

interface ProjectGroup {
  projectId: string;
  endpointIndexes: number[];
  apiKey: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function cycleDate(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function copyUsage(rows: readonly HeliusProjectUsage[]): HeliusProjectUsage[] {
  return rows.map((row) => ({ ...row, endpointIndexes: [...row.endpointIndexes] }));
}

function unavailable(
  endpointIndexes: number[],
  attemptedAtMs: number,
  error: string,
): HeliusProjectUsage[] {
  return [{
    projectId: null,
    endpointIndexes,
    creditsUsed: null,
    remaining: null,
    limit: null,
    cycleStart: null,
    cycleEnd: null,
    fetchedAtMs: null,
    attemptedAtMs,
    error,
  }];
}

function projectGroups(endpoints: readonly string[], projectIds: readonly string[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  projectIds.forEach((projectId, endpointIndex) => {
    const group = groups.get(projectId) ?? { projectId, endpointIndexes: [], apiKey: null };
    group.endpointIndexes.push(endpointIndex);
    if (group.apiKey === null) {
      try {
        group.apiKey = new URL(endpoints[endpointIndex] ?? '').searchParams.get('api-key');
      } catch {
        group.apiKey = null;
      }
    }
    groups.set(projectId, group);
  });
  return [...groups.values()];
}

export class HeliusUsagePoller {
  private readonly fetcher: Fetcher;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private signature: string | null = null;
  private nextPollAt = 0;
  private pending: Promise<void> | null = null;
  private usage: HeliusProjectUsage[] = [];

  constructor(fetcher: Fetcher = fetch, now: () => number = Date.now, pollIntervalMs = POLL_INTERVAL_MS) {
    this.fetcher = fetcher;
    this.now = now;
    this.pollIntervalMs = pollIntervalMs;
  }

  snapshot(endpoints: readonly string[], projectIds: readonly string[]): HeliusProjectUsage[] {
    const now = this.now();
    const signature = createHash('sha256').update([...endpoints, '\0', ...projectIds].join('\0')).digest('hex');
    if (signature !== this.signature) {
      this.signature = signature;
      this.nextPollAt = 0;
      this.usage = this.initialUsage(endpoints, projectIds, now);
    }
    if (projectIds.length > 0 && projectIds.length !== endpoints.length) {
      this.usage = unavailable(endpoints.map((_, index) => index), now, 'project_id_count_mismatch');
    } else if (projectIds.length > 0 && now >= this.nextPollAt && this.pending === null) {
      this.nextPollAt = now + this.pollIntervalMs;
      this.pending = this.refresh(endpoints, projectIds, signature).finally(() => {
        this.pending = null;
      });
    }
    return copyUsage(this.usage);
  }

  async refreshNow(endpoints: readonly string[], projectIds: readonly string[]): Promise<HeliusProjectUsage[]> {
    const now = this.now();
    const signature = createHash('sha256').update([...endpoints, '\0', ...projectIds].join('\0')).digest('hex');
    this.signature = signature;
    if (projectIds.length === 0) {
      this.usage = unavailable(endpoints.map((_, index) => index), now, 'project_ids_not_configured');
    } else if (projectIds.length !== endpoints.length) {
      this.usage = unavailable(endpoints.map((_, index) => index), now, 'project_id_count_mismatch');
    } else {
      this.usage = await this.fetchProjects(endpoints, projectIds, now);
    }
    this.nextPollAt = now + this.pollIntervalMs;
    return copyUsage(this.usage);
  }

  private initialUsage(endpoints: readonly string[], projectIds: readonly string[], now: number): HeliusProjectUsage[] {
    if (projectIds.length === 0) {
      return unavailable(endpoints.map((_, index) => index), now, 'project_ids_not_configured');
    }
    if (projectIds.length !== endpoints.length) {
      return unavailable(endpoints.map((_, index) => index), now, 'project_id_count_mismatch');
    }
    return projectGroups(endpoints, projectIds).map((group) => ({
      projectId: group.projectId,
      endpointIndexes: [...group.endpointIndexes],
      creditsUsed: null,
      remaining: null,
      limit: null,
      cycleStart: null,
      cycleEnd: null,
      fetchedAtMs: null,
      attemptedAtMs: now,
      error: 'poll_pending',
    }));
  }

  private async refresh(
    endpoints: readonly string[],
    projectIds: readonly string[],
    signature: string,
  ): Promise<void> {
    const previous = new Map(this.usage.filter((row) => row.projectId !== null).map((row) => [row.projectId!, row]));
    const fetched = await this.fetchProjects(endpoints, projectIds, this.now(), previous);
    if (this.signature === signature) this.usage = fetched;
  }

  private async fetchProjects(
    endpoints: readonly string[],
    projectIds: readonly string[],
    attemptedAtMs: number,
    previous = new Map<string, HeliusProjectUsage>(),
  ): Promise<HeliusProjectUsage[]> {
    const groups = projectGroups(endpoints, projectIds);
    return Promise.all(groups.map(async (group) => {
      const old = previous.get(group.projectId);
      try {
        return await this.fetchProject(group, attemptedAtMs);
      } catch (error) {
        return {
          ...(old ?? {
            projectId: group.projectId,
            endpointIndexes: group.endpointIndexes,
            creditsUsed: null,
            remaining: null,
            limit: null,
            cycleStart: null,
            cycleEnd: null,
            fetchedAtMs: null,
            attemptedAtMs,
          }),
          endpointIndexes: [...group.endpointIndexes],
          attemptedAtMs,
          error: error instanceof HeliusUsageError ? error.name : error instanceof Error ? error.name : 'Error',
        };
      }
    }));
  }

  private async fetchProject(group: ProjectGroup, attemptedAtMs: number): Promise<HeliusProjectUsage> {
    if (!PROJECT_ID_PATTERN.test(group.projectId)) throw new HeliusUsageError('invalid_project_id');
    if (group.apiKey === null || group.apiKey === '') throw new HeliusUsageError('rpc_api_key_missing');
    const url = `${HELIUS_ADMIN_URL}/${encodeURIComponent(group.projectId)}/usage`;
    const response = await this.fetcher(url, {
      headers: { 'X-Api-Key': group.apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new HeliusUsageError(`helius_http_${response.status}`);
    const raw: unknown = await response.json();
    const subscription = isRecord(raw) && isRecord(raw.subscriptionDetails) ? raw.subscriptionDetails : null;
    const cycle = isRecord(raw) && isRecord(raw.creditCycle) ? raw.creditCycle : null;
    const creditsRemaining = isRecord(raw) ? raw.creditsRemaining : undefined;
    const creditsUsed = isRecord(raw) ? raw.creditsUsed : undefined;
    const prepaidRemaining = isRecord(raw) ? raw.prepaidCreditsRemaining : undefined;
    const prepaidUsed = isRecord(raw) ? raw.prepaidCreditsUsed : undefined;
    const creditsLimit = subscription?.creditsLimit;
    if (!finiteNonNegative(creditsRemaining) || !finiteNonNegative(creditsUsed) ||
        !finiteNonNegative(prepaidRemaining) || !finiteNonNegative(prepaidUsed) ||
        (creditsLimit !== null && creditsLimit !== undefined && !finiteNonNegative(creditsLimit))) {
      throw new HeliusUsageError('invalid_usage_response');
    }
    return {
      projectId: group.projectId,
      endpointIndexes: [...group.endpointIndexes],
      creditsUsed,
      remaining: creditsRemaining + prepaidRemaining,
      limit: finiteNonNegative(creditsLimit) ? creditsLimit + prepaidRemaining + prepaidUsed : null,
      cycleStart: cycle === null ? null : cycleDate(cycle.start),
      cycleEnd: cycle === null ? null : cycleDate(cycle.end),
      fetchedAtMs: attemptedAtMs,
      attemptedAtMs,
      error: null,
    };
  }
}
