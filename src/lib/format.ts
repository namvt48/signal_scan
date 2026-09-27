import type { BalRange } from '../types';

export function shortAddr(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 5)}...${addr.slice(-4)}` : addr;
}

/**
 * Chuẩn hiển thị số (2026-09-24): làm tròn tới 3 số thập phân rồi bỏ số 0 thừa
 * (0.05596151 -> "0.056"), KHÔNG dấu chấm ngăn nghìn. compact() mới rút gọn K/M/B/T.
 */
export function fmtNum(n: number): string {
  return String(Number(n.toFixed(3)));
}

const SCALES: readonly [number, string][] = [
  [1e12, 'T'],
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'K'],
];

export function compact(n: number): string {
  const abs = Math.abs(n);
  for (const [size, suffix] of SCALES) {
    if (abs >= size) return `${fmtNum(n / size)}${suffix}`;
  }
  return fmtNum(n);
}

export function usd(n: number): string {
  return `${n < 0 ? '-$' : '$'}${compact(Math.abs(n))}`;
}

/** Số nguyên đầy đủ, ngăn nghìn bằng dấu phẩy: 2044 -> "2,044". */
export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** 3.8214 -> "3.82%"; 18.42 -> "18.4%" — cùng chuẩn với fmtNum. */
export function pct(n: number): string {
  return `${fmtNum(n)}%`;
}

/**
 * Balance-chart extremes (top-100 total balance, token units): "831.1M / 819.2M"
 * (đỉnh / đáy). "—" when the window has no crawled data yet.
 */
/** Bal = đỉnh ÷ đáy; "—" khi thiếu data. */
export function balRange(r?: BalRange): string {
  if (!r || r.trough === 0) return '—';
  return fmtNum(r.peak / r.trough);
}

/** 07 Sep 2026 */
export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/**
 * Compact relative age, largest sensible unit only: 12m ago, 5h 12m ago, 3d 4h ago.
 * Empty string when there is no timestamp (ts <= 0).
 */
export function ago(ts: number, now: number = Date.now()): string {
  if (ts <= 0) return '';
  const mins = Math.max(0, Math.floor((now - ts) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m ago`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h ago`;
}
