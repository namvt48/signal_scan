const COHORT_LABELS_URL =
  process.env.COHORT_LABELS_URL || 'http://ct-wallet-alpha-engine:8081/api/pnl/cohort-labels';
const COHORT_REFRESH_MS = 60 * 60 * 1000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface CohortLabels {
  rank?: string;
  groups: string[];
}

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readLabels(payload: unknown): Map<string, CohortLabels> {
  if (!isRecord(payload) || payload.schema !== 'canonical_cohort_label_index_v1' || !Array.isArray(payload.wallets)) {
    throw new Error('unexpected cohort labels response shape');
  }

  const next = new Map<string, CohortLabels>();
  for (const row of payload.wallets) {
    if (!isRecord(row) || typeof row.wallet !== 'string' || row.wallet.length === 0) continue;

    const label = isRecord(row.label) ? row.label : undefined;
    const identity = label && isRecord(label.labels) ? label.labels : undefined;
    const groupLabels = isRecord(row.group_labels) ? row.group_labels : undefined;
    const rank = typeof identity?.rank === 'string' && identity.rank.length > 0 ? identity.rank.slice(0, 8) : undefined;
    const groups = Array.isArray(groupLabels?.qualified_labels)
      ? [...new Set(groupLabels.qualified_labels.filter((group): group is string => typeof group === 'string' && group.length > 0))]
      : [];

    next.set(row.wallet, { ...(rank ? { rank } : {}), groups });
  }
  return next;
}

export class CohortLabelIndex {
  private labels = new Map<string, CohortLabels>();
  private refreshInFlight: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly fetcher: Fetcher = fetch,
    private readonly endpoint = COHORT_LABELS_URL,
  ) {}

  get(wallet: string): CohortLabels | undefined {
    return this.labels.get(wallet);
  }

  /** Replace the snapshot atomically; malformed top-level responses leave the old cache intact. */
  replaceFromPayload(payload: unknown): void {
    this.labels = readLabels(payload);
  }

  refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = this.fetchSnapshot().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  start(onError: (error: unknown) => void, onSuccess: (wallets: number) => void): void {
    if (this.timer) return;
    const refresh = () => void this.refresh().then(() => onSuccess(this.labels.size)).catch(onError);
    refresh();
    this.timer = setInterval(refresh, COHORT_REFRESH_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async fetchSnapshot(): Promise<void> {
    const response = await this.fetcher(this.endpoint, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`cohort labels HTTP ${response.status}`);
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      throw new Error(`cohort labels response exceeds ${MAX_RESPONSE_BYTES} bytes`);
    }
    const payload: unknown = await response.json();
    this.replaceFromPayload(payload);
  }
}

export const cohortLabelIndex = new CohortLabelIndex();
