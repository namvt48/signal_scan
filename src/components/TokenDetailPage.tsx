import { useEffect, useState } from 'react';
import type { BalanceChart, TokenDetail } from '../types';
import { getBalanceChart, getTokenDetail } from '../services/tokenDetail';
import { compact, pct, usd } from '../lib/format';
import { CopyButton, ErrorState, SkeletonRows, TableShell, Td, Th } from './ui';

// Balance chart 24h — the green Nansen "Balance" series (top-100 total, tokens).
// Curve drawn in SVG (viewBox % space, non-scaling stroke); labels/gridlines are
// real HTML so text stays 11px at any width (SVG text would scale up).
function BalanceChartSvg({ points }: { points: { t: number | string; total: number }[] }) {
  const vals = points.map((p) => p.total);
  const max = Math.max(...vals);
  const min = Math.min(...vals);
  const pad = (max - min) * 0.1 || max * 0.05 || 1;
  const hi = max + pad;
  const lo = min - pad;
  const yPct = (v: number) => (1 - (v - lo) / (hi - lo)) * 100;

  const xs = points.map((_, i) => (i / Math.max(1, points.length - 1)) * 100);
  let path = `M${xs[0]!.toFixed(2)},${yPct(vals[0]!).toFixed(2)}`;
  for (let i = 1; i < points.length; i++) {
    const mx = ((xs[i - 1]! + xs[i]!) / 2).toFixed(2);
    path += ` C${mx},${yPct(vals[i - 1]!).toFixed(2)} ${mx},${yPct(vals[i]!).toFixed(2)} ${xs[i]!.toFixed(2)},${yPct(vals[i]!).toFixed(2)}`;
  }
  const area = `${path} L100,100 L0,100 Z`;

  const fmtT = (t: number | string): string => {
    const s = String(t);
    return s.includes('T') ? s.slice(11, 16) : s.slice(5, 10);
  };
  const ticks = [hi, lo + (hi - lo) / 2, lo];

  return (
    <div className="flex gap-3">
      <div className="relative h-56 w-14 shrink-0 text-right font-mono text-[11px] text-muted">
        {ticks.map((v) => (
          <span key={v} className="absolute right-0 -translate-y-1/2" style={{ top: `${yPct(v)}%` }}>
            {compact(v)}
          </span>
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <div className="relative h-56">
          {ticks.map((v) => (
            <div key={v} className="absolute inset-x-0 border-t border-dashed border-line" style={{ top: `${yPct(v)}%` }} />
          ))}
          <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Balance chart">
            <defs>
              <linearGradient id="balArea" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" style={{ stopColor: 'var(--c-pos)' }} stopOpacity="0.28" />
                <stop offset="100%" style={{ stopColor: 'var(--c-pos)' }} stopOpacity="0.02" />
              </linearGradient>
            </defs>
            <path d={area} fill="url(#balArea)" />
            <path d={path} fill="none" style={{ stroke: 'var(--c-pos)' }} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          </svg>
        </div>
        <div className="mt-1.5 flex justify-between font-mono text-[11px] text-muted">
          <span>{fmtT(points[0]?.t ?? '')}</span>
          <span>{fmtT(points[points.length - 1]?.t ?? '')}</span>
        </div>
      </div>
    </div>
  );
}

const METRIC_CARD = 'rounded-xl border border-line bg-surface p-4';

export default function TokenDetailPage({ chain, ca, onBack }: { chain: string; ca: string; onBack: () => void }) {
  const [detail, setDetail] = useState<TokenDetail | null | 'error'>(null);
  const [chart, setChart] = useState<BalanceChart | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setChart(null);
    setError(null);
    const load = (first: boolean) => {
      getTokenDetail(chain, ca)
        .then((d) => {
          if (alive) setDetail(d);
        })
        .catch((e: unknown) => {
          if (alive && first) setError(e instanceof Error ? e.message : String(e));
        });
      getBalanceChart(chain, ca, 'day')
        .then((c) => {
          if (alive) setChart(c);
        })
        .catch(() => undefined);
    };
    load(true);
    const id = setInterval(() => load(false), 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [chain, ca]);

  if (error) return <ErrorState message={error} onRetry={() => window.location.reload()} />;

  const loading = detail === null;
  const d = detail === 'error' ? null : detail;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <button onClick={onBack} className="text-sm text-muted hover:text-ink">
            ← Back to dashboard
          </button>
          <h2 className="mt-1 break-all font-mono text-base font-semibold text-ink">{ca}</h2>
        </div>
        <CopyButton value={ca} label="Copy CA" />
      </div>

      {/* 5 Nansen distribution metrics */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className={METRIC_CARD}>
          <p className="text-xs text-muted">Supply held by Top 100 Holders</p>
          <p className="mt-1 font-mono text-xl text-ink">{loading ? '…' : d?.top100SupplyPct != null ? pct(d.top100SupplyPct) : '—'}</p>
        </div>
        <div className={METRIC_CARD}>
          <p className="text-xs text-muted">Supply held by Fresh Wallets</p>
          <p className="mt-1 font-mono text-xl text-ink">{loading ? '…' : d?.freshSupplyPct != null ? pct(d.freshSupplyPct) : '—'}</p>
        </div>
        <div className={METRIC_CARD}>
          <p className="text-xs text-muted">Amount held by Median Holder</p>
          <p className="mt-1 font-mono text-xl text-ink">{loading ? '…' : d?.medianHolderUsd != null ? usd(d.medianHolderUsd) : d?.medianHolderAmount != null ? compact(d.medianHolderAmount) : '—'}</p>
        </div>
        <div className={METRIC_CARD}>
          <p className="text-xs text-muted">Holders · Price</p>
          <p className="mt-1 font-mono text-xl text-ink">{loading ? '…' : `${compact(d?.holders ?? 0)} · ${usd(d?.price ?? 0)}`}</p>
        </div>
      </div>

      {/* Balance chart 24h (yellow Nansen series) */}
      <div className="rounded-xl border border-line bg-surface p-4">
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <p className="text-xs text-muted">Balance (Top 100, 24h)</p>
          {chart && chart.points.length > 1 && (
            <p className="font-mono text-[11px] text-muted">
              data to {new Date(String(chart.points[chart.points.length - 1]!.t)).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
              {chart.cachedAt ? ` · crawled ${Math.max(0, Math.round((Date.now() - chart.cachedAt) / 60_000))}m ago` : ' · own snapshots'}
            </p>
          )}
        </div>
        {chart && chart.points.length > 1 ? (
          <BalanceChartSvg points={chart.points} />
        ) : (
          <p className="py-10 text-center text-sm text-muted">
            {chart && chart.points.length <= 1 ? 'Chưa đủ điểm dữ liệu cho chart.' : 'Đang tải chart…'}
          </p>
        )}
      </div>

      {/* Top 100 Addresses */}
      <div>
        <p className="mb-2 text-sm font-medium text-ink">Top 100 Addresses</p>
        <TableShell>
          <table className="table-fixed w-full min-w-[860px] border-collapse text-left">
            <thead>
              <tr>
                <Th className="w-10">#</Th>
                <Th className="w-[400px]">Address</Th>
                <Th className="w-24 text-right">% Supply</Th>
                <Th className="w-32 text-right">Balance (tokens)</Th>
                <Th className="w-28 text-right">Value</Th>
                <Th className="w-28 text-right">24h Chg</Th>
                <Th className="w-20">Flags</Th>
              </tr>
            </thead>
            {loading ? (
              <SkeletonRows rows={8} cols={7} />
            ) : (
              <tbody>
                {(d?.top100 ?? []).map((h, i) => (
                  <tr key={h.address} className="transition-colors hover:bg-surface2/50">
                    <Td className="text-muted">{i + 1}</Td>
                    <Td className="break-all">
                      <CopyButton value={h.address} label={h.address} />
                    </Td>
                    <Td className="text-right font-mono tabular-nums">{pct(h.percentOwnership)}</Td>
                    <Td className="text-right font-mono tabular-nums">{compact(h.balance)}</Td>
                    <Td className="text-right font-mono tabular-nums">{usd(h.balanceUsd)}</Td>
                    <Td className="text-right font-mono tabular-nums">
                      {h.chg24h === undefined ? (
                        <span className="text-muted">—</span>
                      ) : (
                        <span className={h.chg24h >= 0 ? 'text-pos' : 'text-neg'}>
                          {(h.chg24h >= 0 ? '+' : '') + compact(h.chg24h)}
                        </span>
                      )}
                    </Td>
                    <Td className="text-xs">
                      {h.addrType === 2 && <span className="text-warn">exchange</span>}
                      {h.isNew && <span className="text-pos">fresh</span>}
                      {h.addrType !== 2 && !h.isNew && <span className="text-muted">—</span>}
                    </Td>
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </TableShell>
      </div>
    </div>
  );
}
