import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AlertMetricObservation } from '../alert-feed.js';
import { DEFAULT_TELEGRAM_ALERT_RULES, type TelegramAlertRules } from '../telegram-alert-settings.js';
import type { TelegramAlert } from './telegram.js';
import type { FomoApiSample, HistorySeries, MetricSample, MonitorSnapshot, ServiceSample } from './types.js';


interface MetricRow {
  provider: string;
  metric_key: string;
  label: string;
  unit: string;
  used: number | null;
  delta: number;
  remaining: number | null;
  limit_value: number | null;
  threshold: number | null;
  status: MetricSample['status'];
  source: string;
  updated_at: string | null;
  ts: number;
}

interface ServiceRow {
  id: string;
  name: string;
  scope: string;
  status: ServiceSample['status'];
  checked_at: string | null;
  latency_ms: number | null;
  detail: string | null;
  ts: number;
}

interface FomoApiSampleRow extends FomoApiSample {
  ts: number;
}

interface UsageRow {
  provider: string;
  metric_key: string;
  label: string;
  unit: string;
  amount: number;
}

interface PendingTelegramAlert {
  alertId: string;
  attempts: number;
  sentParts: number;
  deliveryMode: 'photo' | 'text';
  payload: TelegramAlert;
}

export class MonitorStore {
  private readonly db: Database.Database;
  private lastPrunedAt = 0;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metric_samples (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        provider TEXT NOT NULL,
        metric_key TEXT NOT NULL,
        label TEXT NOT NULL,
        unit TEXT NOT NULL,
        used REAL,
        delta REAL NOT NULL,
        remaining REAL,
        limit_value REAL,
        threshold REAL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        updated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS metric_samples_time ON metric_samples(ts);
      CREATE INDEX IF NOT EXISTS metric_samples_key_time ON metric_samples(provider, metric_key, ts DESC, id DESC);
      CREATE TABLE IF NOT EXISTS service_samples (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        service_id TEXT NOT NULL,
        name TEXT NOT NULL,
        scope TEXT NOT NULL,
        status TEXT NOT NULL,
        checked_at TEXT,
        latency_ms REAL,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS service_samples_key_time ON service_samples(service_id, ts DESC, id DESC);
      CREATE TABLE IF NOT EXISTS notification_state (
        state_key TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        sent_at INTEGER,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS alert_cursors (
        source TEXT PRIMARY KEY,
        observation_id INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS alert_baselines (
        source TEXT NOT NULL,
        chain TEXT NOT NULL,
        ca TEXT NOT NULL,
        metric TEXT NOT NULL,
        value REAL NOT NULL,
        previous_value REAL,
        PRIMARY KEY (source, chain, ca, metric)
      );
      CREATE TABLE IF NOT EXISTS telegram_alert_outbox (
        alert_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        next_attempt_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        sent_at INTEGER,
        last_error TEXT,
        delivery_state TEXT NOT NULL DEFAULT 'pending',
        sent_parts INTEGER NOT NULL DEFAULT 0,
        delivery_mode TEXT NOT NULL DEFAULT 'photo'
      );
      CREATE TABLE IF NOT EXISTS fomo_api_samples (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        instance TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        operations INTEGER NOT NULL,
        attempted_operations INTEGER NOT NULL,
        attempts INTEGER NOT NULL,
        attempt_failures INTEGER NOT NULL,
        successes INTEGER NOT NULL,
        no_data INTEGER NOT NULL,
        incomplete INTEGER NOT NULL,
        failures INTEGER NOT NULL,
        deferred INTEGER NOT NULL,
        credits_cost REAL NOT NULL,
        last_outcome TEXT,
        last_outcome_at_ms INTEGER,
        sampled_at_ms INTEGER NOT NULL,
        upstream_api_status TEXT NOT NULL,
        upstream_live_data_status TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS fomo_api_samples_key_time
        ON fomo_api_samples(instance, endpoint, ts DESC, id DESC);
    `);
    const baselineColumns = this.db.pragma('table_info(alert_baselines)') as { name: string }[];
    if (!baselineColumns.some((column) => column.name === 'previous_value')) {
      this.db.exec('ALTER TABLE alert_baselines ADD COLUMN previous_value REAL');
    }
    const outboxColumns = this.db.pragma('table_info(telegram_alert_outbox)') as { name: string }[];
    if (!outboxColumns.some((column) => column.name === 'delivery_state')) {
      this.db.exec(`
        ALTER TABLE telegram_alert_outbox
        ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'pending'
      `);
      this.db.exec(`
        UPDATE telegram_alert_outbox SET delivery_state = 'sent'
        WHERE sent_at IS NOT NULL AND delivery_state = 'pending';
        UPDATE telegram_alert_outbox
        SET delivery_state = 'uncertain',
            last_error = COALESCE(last_error, 'delivery outcome predates single-attempt protection')
        WHERE sent_at IS NULL AND attempts > 0 AND delivery_state = 'pending';
      `);
    }
    const currentOutboxColumns = this.db.pragma('table_info(telegram_alert_outbox)') as { name: string }[];
    if (!currentOutboxColumns.some((column) => column.name === 'sent_parts')) {
      this.db.exec(`
        ALTER TABLE telegram_alert_outbox
        ADD COLUMN sent_parts INTEGER NOT NULL DEFAULT 0
      `);
    }
    const updatedOutboxColumns = this.db.pragma('table_info(telegram_alert_outbox)') as { name: string }[];
    if (!updatedOutboxColumns.some((column) => column.name === 'delivery_mode')) {
      this.db.exec(`
        ALTER TABLE telegram_alert_outbox ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'photo';
        UPDATE telegram_alert_outbox SET delivery_mode = 'text' WHERE sent_parts > 0;
      `);
    }
  }

  recordMetrics(metrics: readonly MetricSample[], ts = Date.now()): void {
    const latest = this.db.prepare(
      'SELECT used FROM metric_samples WHERE provider = ? AND metric_key = ? ORDER BY ts DESC, id DESC LIMIT 1',
    );
    const previousNansenCallers = this.db.prepare(`
      SELECT SUM(used) AS used
      FROM metric_samples
      WHERE provider = 'Nansen' AND metric_key IN ('caller-a', 'caller-b')
        AND id IN (
          SELECT MAX(id)
          FROM metric_samples
          WHERE provider = 'Nansen' AND metric_key IN ('caller-a', 'caller-b')
          GROUP BY metric_key
        )
    `);
    const insert = this.db.prepare(`
      INSERT INTO metric_samples (
        ts, provider, metric_key, label, unit, used, delta, remaining,
        limit_value, threshold, status, source, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const writeAll = this.db.transaction((rows: readonly MetricSample[]) => {
      for (const row of rows) {
        const previous = latest.get(row.provider, row.key) as { used: number | null } | undefined;
        const legacyNansenUsed = row.provider === 'Nansen' && row.key === 'shared-daily' && previous === undefined
          ? (previousNansenCallers.get() as { used: number | null }).used
          : null;
        const delta = row.used === null
          ? 0
          : previous !== undefined
            ? previous.used === null
              ? 0
              : Math.max(0, row.used >= previous.used ? row.used - previous.used : row.used)
            : legacyNansenUsed === null
              ? 0
              : Math.max(0, row.used >= legacyNansenUsed ? row.used - legacyNansenUsed : row.used);
        insert.run(
          ts,
          row.provider,
          row.key,
          row.label,
          row.unit,
          row.used,
          delta,
          row.remaining,
          row.limit,
          row.threshold,
          row.status,
          row.source,
          row.updatedAt,
        );
      }
    });
    writeAll(metrics);
  }


  recordServices(services: readonly ServiceSample[], ts = Date.now()): void {
    const insert = this.db.prepare(`
      INSERT INTO service_samples (
        ts, service_id, name, scope, status, checked_at, latency_ms, detail
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const writeAll = this.db.transaction((rows: readonly ServiceSample[]) => {
      for (const row of rows) {
        insert.run(ts, row.id, row.name, row.scope, row.status, row.checkedAt, row.latencyMs, row.detail);
      }
    });
    writeAll(services);
  }

  recordFomoApiSamples(samples: readonly FomoApiSample[], ts = Date.now()): void {
    const insert = this.db.prepare(`
      INSERT INTO fomo_api_samples (
        ts, instance, endpoint, operations, attempted_operations, attempts, attempt_failures,
        successes, no_data, incomplete, failures, deferred, credits_cost, last_outcome,
        last_outcome_at_ms, sampled_at_ms, upstream_api_status, upstream_live_data_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const writeAll = this.db.transaction((rows: readonly FomoApiSample[]) => {
      for (const sample of rows) {
        insert.run(
          ts, sample.instance, sample.endpoint, sample.operations, sample.attemptedOperations,
          sample.attempts, sample.attemptFailures, sample.successes, sample.noData,
          sample.incomplete, sample.failures, sample.deferred, 0,
          sample.lastOutcome, sample.lastOutcomeAtMs, sample.sampledAtMs,
          sample.upstreamApiStatus, sample.upstreamLiveDataStatus,
        );
      }
    });
    writeAll(samples);
  }

  snapshot(now = Date.now(), staleAfterMs = 300_000): Pick<MonitorSnapshot, 'services' | 'credits' | 'fomoApi'> {
    const serviceRows = this.db.prepare(`
      SELECT s.service_id AS id, s.name, s.scope, s.status, s.checked_at AS checked_at,
             s.latency_ms AS latency_ms, s.detail, s.ts
      FROM service_samples s
      JOIN (SELECT service_id, MAX(id) AS latest_id FROM service_samples GROUP BY service_id) latest
        ON latest.latest_id = s.id
      ORDER BY s.scope, s.name
    `).all() as ServiceRow[];
    const metricRows = this.db.prepare(`
      SELECT m.provider, m.metric_key, m.label, m.unit, m.used, m.remaining,
             m.limit_value, m.threshold, m.status, m.source, m.updated_at, m.ts
      FROM metric_samples m
      JOIN (SELECT provider, metric_key, MAX(id) AS latest_id FROM metric_samples GROUP BY provider, metric_key) latest
        ON latest.latest_id = m.id
      ORDER BY m.provider, m.label
    `).all() as MetricRow[];
    const fomoApiRows = this.db.prepare(`
      SELECT f.instance, f.endpoint, f.operations,
             f.attempted_operations AS attemptedOperations,
             f.attempts, f.attempt_failures AS attemptFailures,
             f.successes, f.no_data AS noData, f.incomplete, f.failures, f.deferred,
             f.last_outcome AS lastOutcome,
             f.last_outcome_at_ms AS lastOutcomeAtMs, f.sampled_at_ms AS sampledAtMs,
             f.upstream_api_status AS upstreamApiStatus,
             f.upstream_live_data_status AS upstreamLiveDataStatus, f.ts
      FROM fomo_api_samples f
      JOIN (
        SELECT instance, endpoint, MAX(id) AS latest_id
        FROM fomo_api_samples GROUP BY instance, endpoint
      ) latest ON latest.latest_id = f.id
      ORDER BY f.instance, f.endpoint
    `).all() as FomoApiSampleRow[];
    const hasSharedNansen = metricRows.some((row) => row.provider === 'Nansen' && row.metric_key === 'shared-daily');
    const hasMergedSolana = metricRows.some((row) =>
      row.provider === 'Solana RPC' && row.metric_key.startsWith('solana-rpc-'),
    );
    const visibleMetricRows = metricRows.filter((row) =>
      !(hasSharedNansen && row.provider === 'Nansen' && (row.metric_key === 'caller-a' || row.metric_key === 'caller-b')) &&
      !(hasMergedSolana && row.provider === 'Solana RPC' && !row.metric_key.startsWith('solana-rpc-')),
    );
    return {
      services: serviceRows.map((row) => ({
        id: row.id,
        name: row.name,
        scope: row.scope,
        status: row.ts + staleAfterMs < now ? 'unknown' : row.status,
        checkedAt: row.checked_at,
        latencyMs: row.latency_ms,
        detail: row.ts + staleAfterMs < now ? 'No recent health sample' : row.detail,
      })),
      credits: visibleMetricRows.map((row) => ({
        provider: row.provider,
        key: row.metric_key,
        label: row.label,
        unit: row.unit,
        used: row.used,
        remaining: row.remaining,
        limit: row.limit_value,
        threshold: row.threshold,
        status: row.ts + staleAfterMs < now ? 'stale' : row.status,
        source: row.source,
        updatedAt: row.updated_at,
      })),
      fomoApi: fomoApiRows.map((row) => {
        const stale = row.ts + staleAfterMs < now;
        const { ts: _ts, ...sample } = row;
        return {
          ...sample,
          upstreamApiStatus: stale ? 'unknown' : sample.upstreamApiStatus,
          upstreamLiveDataStatus: stale ? 'unknown' : sample.upstreamLiveDataStatus,
          stale,
        };
      }),
    };
  }
  history(hours: number, now = Date.now()): { series: HistorySeries[] } {
    const since = now - hours * 3_600_000;
    const rows = this.db.prepare(`
      SELECT ts, provider, metric_key, label, unit, delta
      FROM metric_samples
      WHERE ts >= ? AND ts <= ?
      ORDER BY ts, id
    `).all(since, now) as Array<Pick<MetricRow, 'ts' | 'provider' | 'metric_key' | 'label' | 'unit' | 'delta'>>;
    const hasMergedSolana = rows.some((row) =>
      row.provider === 'Solana RPC' && row.metric_key.startsWith('solana-rpc-'),
    );
    const byKey = new Map<string, {
      provider: string;
      key: string;
      label: string;
      unit: string;
      deltas: Map<number, number>;
    }>();
    for (const row of rows) {
      if (hasMergedSolana && row.provider === 'Solana RPC' && !row.metric_key.startsWith('solana-rpc-')) continue;
      const isNansen = row.provider === 'Nansen' &&
        (row.metric_key === 'caller-a' || row.metric_key === 'caller-b' || row.metric_key === 'shared-daily');
      const metricKey = isNansen ? 'shared-daily' : row.metric_key;
      const key = `${row.provider}\0${metricKey}`;
      let series = byKey.get(key);
      if (series === undefined) {
        series = {
          provider: row.provider,
          key: metricKey,
          label: isNansen ? 'Nansen shared account · internal daily budget' : row.label,
          unit: row.unit,
          deltas: new Map(),
        };
        byKey.set(key, series);
      }
      series.deltas.set(row.ts, (series.deltas.get(row.ts) ?? 0) + row.delta);
    }
    const series = [...byKey.values()].map(({ deltas, ...row }): HistorySeries => {
      let total = 0;
      const points = [...deltas.entries()].sort(([left], [right]) => left - right).map(([ts, delta]) => {
        total += delta;
        return { ts, value: total };
      });
      return { ...row, points };
    });
    return { series };
  }

  usageBetween(start: number, end: number): UsageRow[] {
    const rows = this.db.prepare(`
      SELECT provider, metric_key, label, unit, SUM(delta) AS amount
      FROM metric_samples
      WHERE ts >= ? AND ts < ?
      GROUP BY provider, metric_key, label, unit
      ORDER BY provider, label
    `).all(start, end) as UsageRow[];
    const hasMergedSolana = rows.some((row) =>
      row.provider === 'Solana RPC' && row.metric_key.startsWith('solana-rpc-'),
    );
    const merged = new Map<string, UsageRow>();
    for (const row of rows) {
      if (hasMergedSolana && row.provider === 'Solana RPC' && !row.metric_key.startsWith('solana-rpc-')) continue;
      const isNansen = row.provider === 'Nansen' &&
        (row.metric_key === 'caller-a' || row.metric_key === 'caller-b' || row.metric_key === 'shared-daily');
      const metricKey = isNansen ? 'shared-daily' : row.metric_key;
      const key = `${row.provider}\0${metricKey}\0${row.unit}`;
      const previous = merged.get(key);
      merged.set(key, {
        provider: row.provider,
        metric_key: metricKey,
        label: isNansen ? 'Nansen shared account · internal daily budget' : row.label,
        unit: row.unit,
        amount: (previous?.amount ?? 0) + row.amount,
      });
    }
    return [...merged.values()].sort((left, right) =>
      left.provider.localeCompare(right.provider) || left.label.localeCompare(right.label),
    );
  }


  notificationState(key: string): { state: string; sentAt: number | null; error: string | null } | null {
    const row = this.db.prepare(
      'SELECT state, sent_at, last_error FROM notification_state WHERE state_key = ?',
    ).get(key) as { state: string; sent_at: number | null; last_error: string | null } | undefined;
    return row === undefined ? null : { state: row.state, sentAt: row.sent_at, error: row.last_error };
  }

  setNotificationState(key: string, state: string, sentAt: number | null, error: string | null): void {
    this.db.prepare(`
      INSERT INTO notification_state (state_key, state, sent_at, last_error) VALUES (?, ?, ?, ?)
      ON CONFLICT(state_key) DO UPDATE SET state = excluded.state, sent_at = excluded.sent_at,
        last_error = excluded.last_error
    `).run(key, state, sentAt, error);
  }
  lastNotificationDeliveryAt(): number | null {
    const row = this.db.prepare('SELECT MAX(sent_at) AS latest FROM notification_state').get() as { latest: number | null };
    return row.latest;
  }


  alertCursor(source: 'A' | 'B'): number {
    const row = this.db.prepare('SELECT observation_id FROM alert_cursors WHERE source = ?')
      .get(source) as { observation_id: number } | undefined;
    return row?.observation_id ?? 0;
  }

  commitAlertObservations(
    source: 'A' | 'B',
    observations: readonly AlertMetricObservation[],
    rules: TelegramAlertRules = DEFAULT_TELEGRAM_ALERT_RULES,
    fomoRules: TelegramAlertRules = rules,
    throughId?: number,
  ): number {
    const transaction = this.db.transaction((rows: readonly AlertMetricObservation[]) => {
      let cursor = this.alertCursor(source);
      const skippedHighId = Number.isSafeInteger(throughId) && (throughId as number) > cursor
        ? throughId as number
        : cursor;
      const previousValue = this.db.prepare(`
        SELECT value, previous_value FROM alert_baselines
        WHERE source = ? AND chain = ? AND ca = ? AND metric = ?
      `);
      const saveBaseline = this.db.prepare(`
        INSERT INTO alert_baselines (source, chain, ca, metric, value, previous_value)
        VALUES (?, ?, ?, ?, ?, NULL)
        ON CONFLICT(source, chain, ca, metric) DO UPDATE SET
          previous_value = alert_baselines.value,
          value = excluded.value
      `);
      const enqueue = this.db.prepare(`
        INSERT OR IGNORE INTO telegram_alert_outbox
          (alert_id, payload_json, created_at, next_attempt_at)
        VALUES (?, ?, ?, ?)
      `);
      for (const observation of rows) {
        if (observation.id <= cursor) continue;
        const activeRules = observation.origin === 'fomo' ? fomoRules : rules;
        const baseline = observation.metric === 'trackerBuy' ? undefined :
          previousValue.get(source, observation.chain, observation.ca, observation.metric) as
            | { value: number; previous_value: number | null }
            | undefined;
        const current = observation.value;
        const freshPctForAlert = observation.metric === 'fresh' ? current : observation.snapshot.freshPct;
        const marketCapK = observation.snapshot.marketCap === null ? null : observation.snapshot.marketCap / 1000;
        const marketCapAllowed = (activeRules.minMcK === -1 && activeRules.maxMcK === -1) ||
          (marketCapK !== null && Number.isFinite(marketCapK) &&
            (activeRules.minMcK === -1 || marketCapK >= activeRules.minMcK) &&
            (activeRules.maxMcK === -1 || marketCapK <= activeRules.maxMcK));
        const minHolders = activeRules.minHolders ?? -1;
        const maxHolders = activeRules.maxHolders ?? -1;
        const holders = observation.snapshot.holders;
        const holdersAllowed = (minHolders === -1 && maxHolders === -1) ||
          (typeof holders === 'number' && Number.isFinite(holders) &&
            (minHolders === -1 || holders >= minHolders) &&
            (maxHolders === -1 || holders <= maxHolders));
        const growthThreshold = observation.metric === 'fresh' ? activeRules.fwGrowthPct : activeRules.t100GrowthPct;
        const freshAllowed = observation.metric !== 'fresh' ||
          (freshPctForAlert !== null &&
            Number.isFinite(freshPctForAlert) &&
            freshPctForAlert >= activeRules.minFwPct);
        const firstT100 = observation.metric === 't100' &&
          typeof observation.snapshot.t100First === 'number' &&
          Number.isFinite(observation.snapshot.t100First) &&
          observation.snapshot.t100First > 0
          ? observation.snapshot.t100First
          : undefined;
        const qualifyingBaseline = observation.metric === 'trackerBuy' || !freshAllowed
          ? undefined
          : observation.metric === 't100' && firstT100 !== undefined
            ? current > firstT100 * (1 + growthThreshold / 100) ? firstT100 : undefined
            : [baseline?.value, baseline?.previous_value].find((candidate) =>
              candidate !== undefined &&
              candidate !== null &&
              candidate > 0 &&
              current > candidate * (1 + growthThreshold / 100));
        const shouldAlert = marketCapAllowed && holdersAllowed && (observation.metric === 'trackerBuy'
          ? activeRules.trackerBuyingK > 0 &&
            observation.snapshot.trackerBuyer !== undefined &&
            current > activeRules.trackerBuyingK * 1000
          : qualifyingBaseline !== undefined);
        if (shouldAlert) {
          const snapshot = observation.snapshot;
          const alert: TelegramAlert = {
            alertId: `${source}:${observation.id}`,
            chain: observation.chain,
            ca: observation.ca,
            ...(snapshot.symbol ? { symbol: snapshot.symbol } : {}),
            ...(snapshot.marketCap !== null ? { marketCap: snapshot.marketCap } : {}),
            ...(snapshot.marketCapAt !== null ? { marketCapAt: snapshot.marketCapAt } : {}),
            trigger: {
              metric: observation.metric,
              previous: qualifyingBaseline ?? 0,
              current,
              responseAt: observation.responseAt,
              ...(observation.metric === 'trackerBuy' && observation.snapshot.trackerBuyer
                ? { buyer: observation.snapshot.trackerBuyer }
                : {}),
            },
            nansen: {
              ...(snapshot.freshPct !== null ? { freshPct: snapshot.freshPct } : {}),
              ...(snapshot.t100Multiple !== null ? { t100Multiple: snapshot.t100Multiple } : {}),
              ...(snapshot.lf !== null ? { lf: snapshot.lf } : {}),
            },
            ...(snapshot.trackedHoldingPct !== null ? { trackedHoldingPct: snapshot.trackedHoldingPct } : {}),
            ...(snapshot.iconUrl ? { iconUrl: snapshot.iconUrl } : {}),
            ...(snapshot.xHandle ? { xHandle: snapshot.xHandle } : {}),
            ...(snapshot.tracked ? { tracked: snapshot.tracked } : {}),
            source,
          };
          enqueue.run(alert.alertId, JSON.stringify(alert), snapshot.capturedAt, snapshot.capturedAt);
        }
        if (observation.metric !== 'trackerBuy') {
          // Advance even outside the MC range; otherwise entering range could replay old growth.
          saveBaseline.run(source, observation.chain, observation.ca, observation.metric, current);
        }
        cursor = observation.id;
      }
      cursor = Math.max(cursor, skippedHighId);
      this.db.prepare(`
        INSERT INTO alert_cursors (source, observation_id) VALUES (?, ?)
        ON CONFLICT(source) DO UPDATE SET observation_id = excluded.observation_id
      `).run(source, cursor);
      return cursor;
    });
    return transaction(observations);
  }

  pendingTelegramAlerts(now: number, limit: number): PendingTelegramAlert[] {
    const rows = this.db.prepare(`
      SELECT alert_id, payload_json, attempts, sent_parts, delivery_mode FROM telegram_alert_outbox
      WHERE sent_at IS NULL AND delivery_state = 'pending' AND next_attempt_at <= ?
      ORDER BY created_at, alert_id LIMIT ?
    `).all(now, limit) as {
      alert_id: string;
      payload_json: string;
      attempts: number;
      sent_parts: number;
      delivery_mode: 'photo' | 'text';
    }[];
    return rows.map((row) => ({
      alertId: row.alert_id,
      attempts: row.attempts,
      sentParts: row.sent_parts,
      deliveryMode: row.delivery_mode,
      payload: JSON.parse(row.payload_json) as TelegramAlert,
    }));
  }
  markTelegramAlertSending(alertId: string): boolean {
    const result = this.db.prepare(`
      UPDATE telegram_alert_outbox SET delivery_state = 'sending'
      WHERE alert_id = ? AND sent_at IS NULL AND delivery_state = 'pending'
    `).run(alertId);
    return result.changes === 1;
  }
  markTelegramAlertSuppressed(alertId: string): void {
    this.db.prepare(`
      UPDATE telegram_alert_outbox
      SET delivery_state = 'suppressed', last_error = 'source_b_sol_suppressed'
      WHERE alert_id = ? AND sent_at IS NULL AND delivery_state = 'pending'
    `).run(alertId);
  }
  markTelegramAlertPartSent(alertId: string, sentParts: number, deliveryMode: 'photo' | 'text'): boolean {
    if (!Number.isSafeInteger(sentParts) || sentParts < 1) return false;
    const result = this.db.prepare(`
      UPDATE telegram_alert_outbox SET sent_parts = ?, delivery_mode = ?
      WHERE alert_id = ? AND delivery_state = 'sending' AND sent_parts = ?
    `).run(sentParts, deliveryMode, alertId, sentParts - 1);
    return result.changes === 1;
  }


  markTelegramAlertSent(alertId: string, sentAt: number): void {
    this.db.prepare(`
      UPDATE telegram_alert_outbox
      SET sent_at = ?, last_error = NULL, delivery_state = 'sent'
      WHERE alert_id = ? AND delivery_state = 'sending'
    `).run(sentAt, alertId);

  }
  markTelegramAlertFailure(alertId: string, nextAttemptAt: number, error: string): void {
    this.db.prepare(`
      UPDATE telegram_alert_outbox
      SET attempts = attempts + 1, next_attempt_at = ?, last_error = ?, delivery_state = 'pending'
      WHERE alert_id = ? AND sent_at IS NULL AND delivery_state = 'sending'
    `).run(nextAttemptAt, error.slice(0, 200), alertId);
  }

  markTelegramAlertUncertain(alertId: string, error: string): void {
    this.db.prepare(`
      UPDATE telegram_alert_outbox
      SET attempts = attempts + 1, last_error = ?, delivery_state = 'uncertain'
      WHERE alert_id = ? AND sent_at IS NULL AND delivery_state = 'sending'
    `).run(error.slice(0, 200), alertId);
  }

  markTelegramAlertRejected(alertId: string, error: string): void {
    this.db.prepare(`
      UPDATE telegram_alert_outbox
      SET attempts = attempts + 1, last_error = ?, delivery_state = 'rejected'
      WHERE alert_id = ? AND sent_at IS NULL AND delivery_state = 'sending'
    `).run(error.slice(0, 200), alertId);
  }

  prune(now = Date.now()): void {
    if (now - this.lastPrunedAt < 3_600_000) return;
    this.db.prepare('DELETE FROM metric_samples WHERE ts < ?').run(now - 90 * 86_400_000);
    this.db.prepare('DELETE FROM fomo_api_samples WHERE ts < ?').run(now - 14 * 86_400_000);
    this.db.prepare('DELETE FROM service_samples WHERE ts < ?').run(now - 14 * 86_400_000);
    this.lastPrunedAt = now;
  }

  close(): void {
    this.db.close();
  }
}
