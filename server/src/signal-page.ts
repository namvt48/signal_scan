import type { TokenSignal } from './signals.js';

export type SignalView = 'dashboard' | 'rated';

export interface SignalPageStats {
  /** Every tracked CA that assembleSignals returned (the "Tokens tracked" tile). */
  tracked: number;
  /** Rows the dashboard treats as active: score >= 1 or an explicit tier. */
  active: number;
  watch: number;
  /** 24h volume of the rows the unfiltered view renders. */
  volume24h: number;
  tiers: { s: number; a: number; b: number };
}

export interface SignalPageOptions {
  view: SignalView;
  allFactors: boolean;
  limit: number;
  offset: number;
  showFomo: boolean;
}

export interface SignalPage {
  rows: TokenSignal[];
  total: number;
  stats: SignalPageStats;
}

const TIER_RANK: Record<string, number> = { 'S+': 0, S: 1, 'A+': 2, A: 3, 'B+': 4, B: 5, P: 6 };

function activityAt(signal: TokenSignal, showFomo: boolean): number {
  let latest = signal.trackedActivityAt;
  if (showFomo) {
    for (const user of signal.fomoUsers) if (user.lastTs > latest) latest = user.lastTs;
  }
  return latest;
}

/** Same default ordering as SignalTable: Pass rows sink, then newest activity wins. */
function byActivity(a: TokenSignal, b: TokenSignal, showFomo: boolean): number {
  const ap = a.tier === 'P' ? 1 : 0;
  const bp = b.tier === 'P' ? 1 : 0;
  if (ap !== bp) return ap - bp;
  return activityAt(b, showFomo) - activityAt(a, showFomo);
}

/**
 * Slice the assembled list for the dashboard's infinite scroll. The view filter
 * and sort run on the FULL cached array, so every page is globally ordered and
 * page N+1 continues where page N stopped. Stats describe the full view, not
 * the slice, so the summary tiles stay correct while rows stream in.
 */
export function buildSignalPage(signals: readonly TokenSignal[], options: SignalPageOptions): SignalPage {
  const passing = signals.filter((signal) => signal.nansen.score >= 1 || signal.tier !== null);
  const rated = signals.filter((signal) => signal.tier !== null && signal.tier !== 'P');
  const tiers = {
    s: rated.filter((signal) => signal.tier === 'S+' || signal.tier === 'S').length,
    a: rated.filter((signal) => signal.tier === 'A+' || signal.tier === 'A').length,
    b: rated.filter((signal) => signal.tier === 'B+' || signal.tier === 'B').length,
  };

  const rows = options.view === 'rated'
    ? [...rated].sort((a, b) => {
      const ar = TIER_RANK[a.tier ?? ''] ?? 99;
      const br = TIER_RANK[b.tier ?? ''] ?? 99;
      return ar !== br ? ar - br : byActivity(a, b, options.showFomo);
    })
    : [...(options.allFactors ? signals : passing)].sort((a, b) => byActivity(a, b, options.showFomo));

  const volumeRows = options.view === 'rated' ? rated : options.allFactors ? signals : passing;
  return {
    rows: rows.slice(options.offset, options.offset + options.limit),
    total: rows.length,
    stats: {
      tracked: signals.length,
      active: passing.length,
      watch: signals.length - passing.length,
      volume24h: volumeRows.reduce((sum, signal) => sum + signal.volume24h, 0),
      tiers,
    },
  };
}
