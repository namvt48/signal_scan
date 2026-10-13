export type ServiceStatus = 'healthy' | 'degraded' | 'down' | 'unknown';
export type CreditStatus = 'ok' | 'low' | 'exhausted' | 'unknown' | 'stale';

export interface ServiceSample {
  id: string;
  name: string;
  scope: string;
  status: ServiceStatus;
  checkedAt: string | null;
  latencyMs: number | null;
  detail: string | null;
}

export interface MetricSample {
  provider: string;
  key: string;
  label: string;
  unit: string;
  used: number | null;
  remaining: number | null;
  limit: number | null;
  threshold: number | null;
  status: CreditStatus;
  source: string;
  updatedAt: string | null;
}

export interface MonitorSnapshot {
  generatedAt: string;
  services: ServiceSample[];
  credits: MetricSample[];
  notifications: { discordConfigured: boolean; lastDeliveryAt: string | null; lastError: string | null };
}

export interface HistoryPoint {
  ts: number;
  value: number;
}

export interface HistorySeries {
  provider: string;
  key: string;
  label: string;
  unit: string;
  points: HistoryPoint[];
}
