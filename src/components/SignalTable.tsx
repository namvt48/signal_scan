import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { MagnifyingGlass, XLogo } from '@phosphor-icons/react';
import { dataStore } from '../services/dataStore';
import { useAllFactors } from '../services/debugFlags';
import { CHAIN_LINKS } from '../chain';
import { ENTRY_VOLUME_THRESHOLD, SHOW_CLAN, SHOW_FOMO } from '../config';
import { RATED_TIERS, type Chain, type FomoUserStat, type NansenThresholds, type Tier, type TokenSignal, type TrackedWalletStat } from '../types';
import { ago, compact, fmtInt, fmtNum, pct, shortAddr, usd } from '../lib/format';
import { freshPercentageInRange, percentageInRange, volumeClass } from '../lib/signalMetrics';
import { TokenNote } from './TokenNote';
import { FreshWalletChart } from './FreshWalletChart';
import { CheckSquare, Chip, EmptyState, ErrorState, Modal, Pill, SkeletonRows, TableShell, Td, Th, TierBadge, TierSelect, TokenAvatar, walletNameClass } from './ui';
import { ChainBadge } from './ChainBadge';
import { useAuth } from '../auth/use-auth';

// Shared chrome for the three Nansen columns: subtle tint + a rule at the group's edges.
const NS_HEAD = 'bg-lime-soft!';
const NS_CELL = 'bg-lime-soft/40';
const NS_START = 'border-l! border-l-line!';
const NS_END = 'border-r! border-r-line!';

/* Nansen cells: green + semibold means the factor passes — colour is the only cue now the dot is gone. */
function SetupValue({ value, pass }: { value: string; pass: boolean }) {
  return (
    <span
      className={`flex items-center justify-center font-mono text-[13px] tabular-nums ${
        pass ? 'font-semibold text-pos' : 'font-normal text-ink2'
      }`}
    >
      {value}
    </span>
  );
}

/*
 * Inline/full wallet table, six fixed columns so every row lines up — and the inline
 * table lines up with the modal table. Numerics right-aligned mono; long names truncate.
 */
/** Column share of the wallet table — declared on <col> so widths survive with no header row. */
const WALLET_COLS: readonly string[] = SHOW_CLAN
  ? ['30%', '12%', '15%', '11%', '17%', '15%']
  : ['34%', '17%', '13%', '19%', '17%'];

/*
 * FOMO column shares, parallel to WALLET_COLS: User / Clan? / Trades / Buy $ / Sell PnL / Age.
 * Same SHOW_CLAN rule so the inline table, the header sub-line, and the modal table
 * line up row for row. Shares track each column's widest content (user 2026-10-01):
 * the old split starved the right pair (Sell PnL ↔ Age ~16px) and left Clan/Trades
 * with >100px of dead space, so the horizontal rhythm read ragged.
 */
const FOMO_COLS: readonly string[] = SHOW_CLAN
  ? ['24%', '11%', '13%', '16%', '16%', '20%']
  : ['30%', '16%', '17%', '20%', '17%'];

/** FOMO lives inside the "Tracked by" column as a second stacked list, so the column count is unchanged. */
const FOMO_EXTRA = 0;
/** Keep ticker text readable beside its note button in both deployment variants. */
const TABLE_MIN_W = SHOW_FOMO ? 'min-w-[2568px]' : 'min-w-[2184px]';

/**
 * Row value behind the three "Tracked" columns. The FOMO dash has no wallet watch-list,
 * so they read the FOMO aggregate instead (user 2026-10-01, extended 2026-10-02): Inflow =
 * Σ FOMO large-BUY $, Holding = Σ the users' hold %, "Tracked in" = the FOMO user count.
 * Display, sort AND filter all read these, so the number shown can never disagree with
 * the one being ordered/filtered.
 */
const rowInflow = (s: TokenSignal): number => (SHOW_FOMO ? s.fomoUsers.reduce((n, u) => n + u.buyUsd, 0) : s.trackedInflow);
const rowHolding = (s: TokenSignal): number => (SHOW_FOMO ? s.fomoUsers.reduce((n, u) => n + (u.holdingPct ?? 0), 0) : s.trackedHolding);
const rowTrackedIn = (s: TokenSignal): number => (SHOW_FOMO ? s.fomoUsers.length : s.trackedWallets.length);

/**
 * Wallet breakdown rows (Wallet / Clan / Bal / TXs / Inflow / Age). `head` adds the
 * column labels — the inline cell relies on the "Tracked by" Th sub-line above,
 * so only the popup (a standalone table) renders them.
 */
function WalletTable({ wallets, head = false }: { wallets: TrackedWalletStat[]; head?: boolean }) {
  return (
    <table className="w-full table-fixed border-collapse">
      <colgroup>
        {WALLET_COLS.map((w, i) => (
          <col key={i} style={{ width: w }} />
        ))}
      </colgroup>
      {head && (
        <thead>
          <tr className="font-mono text-[9px] font-bold uppercase tracking-[0.03em] text-[#9AA79C]">
            <th className="pb-1 pr-3 text-left">Wallet</th>
            {SHOW_CLAN && <th className="pb-1 pr-3 text-left">Clan</th>}
            <th className="pb-1 pr-3 text-right">Bal</th>
            <th className="pb-1 pr-3 text-right">TXs</th>
            <th className="pb-1 pr-3 text-right">Inflow</th>
            <th className="pb-1 pl-1 text-left">Age</th>
          </tr>
        </thead>
      )}
      <tbody>
        {wallets.map((w) => (
          <tr key={w.name}>
            <td className="py-1 pr-3 text-[11px]">
              <span className="block truncate font-medium text-ink" title={w.name}>
                <span className={walletNameClass(w.tags)}>{w.name}</span>
              </span>
            </td>
            {SHOW_CLAN && (
              <td className="py-1 pr-3 text-[10.5px]">
                {w.clan ? (
                  <span className="block truncate font-mono text-ink2" title={w.clan}>
                    {w.clan}
                  </span>
                ) : (
                  <span className="text-muted">—</span>
                )}
              </td>
            )}
            <td className="py-1 pr-3 text-right font-mono text-[11px] tabular-nums text-ink2">
              {w.balUsd !== undefined ? usd(w.balUsd) : '—'}
            </td>
            <td className="py-1 pr-3 text-right font-mono text-[11px] tabular-nums">
              <span className="font-semibold text-pos">{w.buys}</span>
              <span className="text-muted">/</span>
              <span className="font-semibold text-neg">{w.sells}</span>
            </td>
            <td className={`py-1 pr-3 text-right font-mono text-[11px] font-medium tabular-nums ${w.inflow >= 0 ? 'text-pos' : 'text-neg'}`}>
              <span className={volumeClass(w.inflow, 'inflow')}>{usd(w.inflow)}</span>
            </td>
            <td className="whitespace-nowrap py-1 pl-1 text-[10.5px] text-muted">{ago(w.lastTs)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/*
 * FOMO breakdown rows (User / Clan? / Trades / Buy $ / Sell PnL / Age), sibling of WalletTable.
 * `buyUsd` is Σ large-BUY size and `sellPnlUsd` is Σ realised PnL on SELL rows — reported
 * separately, never a net figure. Newest trade first; long handles truncate; numerics
 * right-aligned mono like the wallet rows.
 */
function FomoTable({ users, head = false }: { users: FomoUserStat[]; head?: boolean }) {
  const rows = [...users].sort((a, b) => b.lastTs - a.lastTs);
  return (
    <table className="w-full table-fixed border-collapse">
      <colgroup>
        {FOMO_COLS.map((w, i) => (
          <col key={i} style={{ width: w }} />
        ))}
      </colgroup>
      {head && (
        <thead>
          <tr className="font-mono text-[9px] font-bold uppercase tracking-[0.03em] text-[#9AA79C]">
            <th className="pb-1 pr-3 text-left">User</th>
            {SHOW_CLAN && <th className="pb-1 pr-3 text-left">Clan</th>}
            <th className="pb-1 pr-3 text-right">Trades</th>
            <th className="pb-1 pr-3 text-right">Buy $</th>
            <th className="pb-1 pr-3 text-right">Sell PnL</th>
            <th className="pb-1 pl-1 text-left">Age</th>
          </tr>
        </thead>
      )}
      <tbody>
        {rows.map((u) => (
          <tr key={u.handle}>
            <td className="py-1 pr-3 text-[11px]">
              <span className={`block truncate font-medium text-ink ${walletNameClass(u.tags)}`} title={u.name || u.handle}>
                {u.handle}
              </span>
            </td>
            {SHOW_CLAN && (
              <td className="py-1 pr-3 text-[10.5px]">
                {u.clan ? (
                  <span className="block truncate font-mono text-ink2" title={u.clan}>
                    {u.clan}
                  </span>
                ) : (
                  <span className="text-muted">—</span>
                )}
              </td>
            )}
            <td className="py-1 pr-3 text-right font-mono text-[11px] tabular-nums">
              <span className="font-semibold text-pos">{u.buys}</span>
              <span className="text-muted">/</span>
              <span className="font-semibold text-neg">{u.sells}</span>
            </td>
            <td className="py-1 pr-3 text-right font-mono text-[11px] font-medium tabular-nums text-pos" title="Σ large BUY sizes — not net inflow/PnL">
              <span className={volumeClass(u.buyUsd, 'buy')}>{usd(u.buyUsd)}</span>
            </td>
            <td
              className={`py-1 pr-3 text-right font-mono text-[11px] font-medium tabular-nums ${u.sellPnlUsd >= 0 ? 'text-pos' : 'text-neg'}`}
              title="Σ realised PnL on SELL rows — not sell volume"
            >
              {usd(u.sellPnlUsd)}
            </td>
            <td className="whitespace-nowrap py-1 pl-3 text-[10.5px] text-muted">{ago(u.lastTs)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/*
 * CA cell: GMGN address link, the token's X account, and a CA search on X. The X button
 * links ONLY to the token's X account and renders as a disabled non-link (never a search)
 * when `xHandle` is unknown; the magnifier always searches the CA on X.
 */
function CaCell({ ca, chain, xHandle }: { ca: string; chain: Chain; xHandle?: string }) {
  const searchUrl = `https://x.com/search?q=${encodeURIComponent(ca)}`;
  const iconCls =
    'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-surface2 hover:text-pos';
  return (
    <div className="flex w-full items-center justify-center gap-1.5">
      <a
        href={`https://gmgn.ai/${CHAIN_LINKS[chain].gmgnSlug}/token/${ca}`}
        target="_blank"
        rel="noopener noreferrer"
        title={`Open ${ca} on GMGN`}
        aria-label={`Open contract address ${ca} on GMGN`}
        className="min-w-0 truncate font-mono text-[11.5px] text-ink transition-colors hover:text-pos"
      >
        {shortAddr(ca)}
      </a>
      {xHandle ? (
        <a
          href={`https://x.com/${xHandle}`}
          target="_blank"
          rel="noopener noreferrer"
          title={`Open @${xHandle} on X`}
          aria-label={`Open @${xHandle} on X`}
          className={iconCls}
        >
          <XLogo size={11} weight="bold" />
        </a>
      ) : (
        <span
          aria-disabled="true"
          title="No X account on record"
          className="inline-flex h-5 w-5 shrink-0 cursor-not-allowed items-center justify-center rounded text-muted opacity-40"
        >
          <XLogo size={11} weight="bold" />
        </span>
      )}
      <a
        href={searchUrl}
        target="_blank"
        rel="noopener noreferrer"
        title="Search this CA on X"
        aria-label="Search this contract address on X"
        className={iconCls}
      >
        <MagnifyingGlass size={11} weight="bold" />
      </a>
    </div>
  );
}

/* Reference .hero: giant headline left, lime coin right. */
function Hero({ count }: { count: number }) {
  return (
    <section className="mb-[34px] mt-2 grid items-center gap-6 grid-cols-[1.1fr_0.9fr] max-[820px]:grid-cols-1">
      <div>
        <h1 className="font-display text-[clamp(28px,3.6vw,42px)] font-extrabold leading-[1.12] tracking-[-0.01em] text-ink">
          Studying
          <br />
          attention before
          <br />
          it becomes <span className="text-neg">price</span>
        </h1>
        <p className="mt-4 max-w-[440px] text-[14.5px] leading-[1.5] text-ink2">
          Top <b className="font-bold text-ink">{count} tokens</b> ranked by {SHOW_FOMO ? 'latest FOMO buy' : 'latest tracked wallet activity'}.
        </p>
      </div>
      <div className="relative flex h-[220px] items-center justify-center">
        <div
          className="flex h-[190px] w-[190px] flex-col items-center justify-center rounded-full text-center text-white shadow-[0_18px_40px_rgba(62,125,82,0.35),inset_0_0_0_6px_rgba(255,255,255,0.08)]"
          style={{ background: 'radial-gradient(circle at 35% 30%, #D7FA4B, #3E7D52 55%, #17211B 100%)' }}
        >
          <span className="text-[19px] font-extrabold leading-none tracking-[-0.01em]">⌁ SCAN</span>
          <span className="mt-1 text-[8.5px] tracking-[0.15em] opacity-85">SMART MONEY SIGNAL</span>
        </div>
        <span className="absolute right-[-4px] top-1.5 animate-pulse rotate-[6deg] rounded-full border-[1.5px] border-neg bg-white px-2.5 py-[5px] font-mono text-[11px] font-semibold text-neg">
          live feed
        </span>
      </div>
    </section>
  );
}

/* Rated tab: tier rank order (S+ → B) — the Rated table always sorts by this, never by column. */
const TIER_RANK: Record<Tier, number> = { 'S+': 0, S: 1, 'A+': 2, A: 3, 'B+': 4, B: 5, P: 6 };

/** Count of tokens in a tier group ('s' = S+/S, 'a' = A+/A, 'b' = B+/B). */
const tieredCount = (list: TokenSignal[], g: 's' | 'a' | 'b') =>
  list.filter((s) =>
    g === 's' ? s.tier === 'S+' || s.tier === 'S' : g === 'a' ? s.tier === 'A+' || s.tier === 'A' : s.tier === 'B+' || s.tier === 'B',
  ).length;

/* Rated-tab hero: same layout grammar as Hero, star medallion instead of the lime coin. */
function RatedHero() {
  return (
    <section className="mb-[34px] mt-2 grid items-center gap-6 grid-cols-[1.1fr_0.9fr] max-[820px]:grid-cols-1">
      <div>
        <h1 className="font-display text-[clamp(28px,3.6vw,42px)] font-extrabold leading-[1.12] tracking-[-0.01em] text-ink">
          The plays you've<br />tiered <span className="hero-accent">yourself</span>
        </h1>
        <p className="mt-4 max-w-[440px] text-[14.5px] leading-[1.5] text-ink2">
          Filtered live from the Dashboard by the <b className="font-bold text-ink">Tier</b> you assign each token — change a tier on the Dashboard tab and this list updates.
        </p>
      </div>
      <div className="relative flex h-[220px] items-center justify-center">
        <div className="scan-badge">
          <div className="bolt">⭐ RATED</div>
          <div className="sub">YOUR OWN CALLS</div>
        </div>
      </div>
    </section>
  );
}

/* Reference .stat-row: four rounded tiles; hi = dark/active, watch = warn number. */
type StatCell = { label: string; value: string; variant?: 'hi' | 'watch'; numStyle?: CSSProperties };

function StatRow({ cells }: { cells: StatCell[] }) {
  return (
    <div className="stat-row">
      {cells.map((c) => (
        <div key={c.label} className={`stat-tile${c.variant ? ` ${c.variant}` : ''}`}>
          <div className="lbl">{c.label}</div>
          <div className="num" style={c.numStyle}>
            {c.value}
          </div>
        </div>
      ))}
    </div>
  );
}

function ScanFooter() {
  return (
    <footer className="relative mt-4 flex items-end justify-between overflow-hidden px-1 pb-2 pt-6">
      <div aria-hidden className="absolute bottom-[-32px] right-[-32px] h-40 w-40 bg-lime opacity-90 [clip-path:polygon(100%_0,100%_100%,0_100%)]" />
      <div className="relative font-mono text-[10.5px] leading-[1.6] tracking-[0.04em] text-muted">
        DATA POWERED BY
        <br />
        <b className="text-ink">SIGNAL_SCAN ENGINE</b>
      </div>
      <div className="relative text-right font-mono text-[10.5px] leading-[1.6] text-muted">
        MORE SIGNAL.
        <br />
        LESS NOISE.
        <br />
        SCAN ON.
      </div>
    </footer>
  );
}

const HL_HEAD = 'text-center!';
/**
 * Centered header cell. Th's px-5 + nowrap left this column's content box (143.7px at
 * a 1950px table, 110px once the table is pinned to min-w-[1500px]) NARROWER than its
 * own label, so the label overflowed right and text-center stopped centering it —
 * "Tracked Holding" sat 6.1px and "Entry" 3.7px right of their columns. px-3 gives the
 * label room; whitespace-normal lets it wrap instead of overflow at min-w. The sort
 * caret rides in the gutter that frees up.
 */
const C_HEAD = `${HL_HEAD} px-3! whitespace-normal!`;

type SortKey = 'holders' | 'trackedIn' | 'trackedInflow' | 'trackedHolding' | 'volume1h' | 'volume24h' | 't100' | 'lf' | 'fresh' | 'mc';
/** null = default newest activity on A / newest FOMO BUY on B — no column armed. */
type SortState = { key: SortKey; dir: 'asc' | 'desc' } | null;

/** Nansen-setup factors the dashboard filter bar ANDs together. */
type NansenFactor = 't100' | 'lf' | 'fresh';

const SORT_LABEL: Record<SortKey, string> = {
  holders: 'holder count',
  trackedIn: 'Tracked in',
  trackedInflow: 'tracked inflow',
  trackedHolding: 'tracked holding',
  volume1h: '1H volume',
  volume24h: '24H volume',
  t100: 'Top100 multiple',
  lf: 'low float',
  fresh: 'fresh wallet %',
  mc: 'market cap',
};

/** MC header hint: the band in force, or whichever single edge is armed. */
function mcBand(t: NansenThresholds): string {
  if (t.minMc > 0 && t.maxMc > 0) return `${usd(t.minMc)}–${usd(t.maxMc)}`;
  return t.minMc > 0 ? `≥ ${usd(t.minMc)}` : `≤ ${usd(t.maxMc)}`;
}

/** Header cell that sorts on click: the whole label is the hit target, the caret its state. */
function SortTh({
  label,
  col,
  sort,
  onSort,
  className,
  subLabel,
}: {
  label: string;
  col: SortKey;
  sort: SortState;
  /* Required-but-undefined so the skeleton can omit it without exactOptionalPropertyTypes friction. */
  onSort: ((key: SortKey) => void) | undefined;
  className: string;
  subLabel?: ReactNode | undefined;
}) {
  const dir = sort?.key === col ? sort.dir : null;
  return (
    <Th className={className}>
      <button type="button" onClick={() => onSort?.(col)} title={`Sort by ${SORT_LABEL[col]}`} className="group block w-full cursor-pointer select-none">
        <span className="inline-flex items-center gap-1">
          {label}
          <span className={`text-[11px] font-semibold ${dir === null ? 'text-muted' : 'text-pos'} group-hover:text-ink2`}>
            {dir === 'asc' ? '▲' : dir === 'desc' ? '▼' : '↕'}
          </span>
        </span>
        {subLabel}
      </button>
    </Th>
  );
}

function SignalHead({
  thresholds,
  sort = null,
  onSort,
  allFactors = false,
}: {
  thresholds?: NansenThresholds | null;
  sort?: SortState;
  onSort?: (key: SortKey) => void;
  /* Debug-only: the STT column renders only while the allFactors flag is on. */
  allFactors?: boolean;
}) {
  return (
    <tr>
      {allFactors && <Th className="w-10 text-center!">STT</Th>}
      <Th className="w-20 px-2.5! text-center!">{null}</Th>
      <Th className="w-32">Ticker</Th>
      <Th className="w-16 text-center!">Tier</Th>
      <SortTh
        label="MC"
        col="mc"
        sort={sort}
        onSort={onSort}
        className="w-24 text-center! px-3! whitespace-normal!"
        subLabel={
          thresholds && (thresholds.minMc > 0 || thresholds.maxMc > 0) ? (
            <span className="mt-1 block font-mono text-[10px] font-medium text-muted">{mcBand(thresholds)}</span>
          ) : undefined
        }
      />
      <Th className="w-40 text-center!">CA</Th>
      <Th
        className={`${SHOW_FOMO ? 'w-[768px]' : 'w-96'} text-center!`}
        title={
          SHOW_FOMO
            ? 'FOMO watch-list activity. Buy $ is the sum of large BUY sizes, not net inflow or PnL.'
            : undefined
        }
      >
        {SHOW_FOMO ? (
          <>
            <span className="block font-mono text-[10px] font-bold tracking-[0.03em] text-muted uppercase">FOMO by</span>
            <span className="mt-1 grid font-mono text-[10px] font-medium text-muted" style={{ gridTemplateColumns: FOMO_COLS.join(' ') }}>
              <span className="text-left">User</span>
              {SHOW_CLAN && <span className="text-left">Clan</span>}
              <span className="pr-3 text-right">Trades</span>
              <span className="pr-3 text-right" title="Σ large BUY sizes — not net inflow/PnL">
                Buy $
              </span>
              <span className="pr-3 text-right" title="Σ realised PnL on SELL rows — not sell volume">
                Sell PnL
              </span>
              <span className="pl-3 text-left">Age</span>
            </span>
          </>
        ) : (
          <>
            Tracked by
            <span className="mt-1 grid font-mono text-[10px] font-medium text-muted" style={{ gridTemplateColumns: WALLET_COLS.join(' ') }}>
              <span className="text-left">Wallet</span>
              {SHOW_CLAN && <span className="text-left">Clan</span>}
              <span className="pr-3 text-right">Bal</span>
              <span className="pr-3 text-right">TXs</span>
              <span className="pr-3 text-right">Inflow</span>
              <span className="pl-1 text-left">Age</span>
            </span>
          </>
        )}
      </Th>
      <SortTh label="Tracked in" col="trackedIn" sort={sort} onSort={onSort} className="w-20 text-center!" />
      <SortTh
        label="Top100"
        col="t100"
        sort={sort}
        onSort={onSort}
        className={`w-24 ${C_HEAD} ${NS_HEAD} ${NS_START}`}
        subLabel={thresholds ? <span className="mt-1 block font-mono text-[10px] font-medium text-muted">≥ {thresholds.t100MinMultiple}</span> : undefined}
      />
      <SortTh
        label="Low Float"
        col="lf"
        sort={sort}
        onSort={onSort}
        className={`w-24 ${C_HEAD} ${NS_HEAD}`}
        subLabel={
          thresholds ? (
            <span className="mt-1 block font-mono text-[10px] font-medium text-muted">
              {compact(thresholds.lfMin)}–{compact(thresholds.lfMax)}
            </span>
          ) : undefined
        }
      />
      <SortTh
        label="Fresh"
        col="fresh"
        sort={sort}
        onSort={onSort}
        className={`w-24 ${C_HEAD} ${NS_HEAD} ${NS_END}`}
        subLabel={thresholds ? <span className="mt-1 block font-mono text-[10px] font-medium text-muted">≥ {thresholds.freshMinPct}%</span> : undefined}
      />
      <SortTh label="Holder" col="holders" sort={sort} onSort={onSort} className={`w-24 ${C_HEAD}`} />
      <SortTh label="Tracked Inflow" col="trackedInflow" sort={sort} onSort={onSort} className={`w-28 ${C_HEAD}`} />
      <SortTh label="Tracked Holding" col="trackedHolding" sort={sort} onSort={onSort} className={`w-28 ${C_HEAD}`} />
      <SortTh label="1H Volume" col="volume1h" sort={sort} onSort={onSort} className={`w-28 ${C_HEAD}`} />
      <SortTh label="24H Volume" col="volume24h" sort={sort} onSort={onSort} className={`w-28 ${C_HEAD}`} />
      <Th className={`w-28 ${C_HEAD}`} title="Gross DEX buy volume in the last 24 hours">Buying 24H</Th>
      <Th className={`w-28 ${C_HEAD}`} title="Gross DEX sell volume in the last 24 hours — not realised PnL">Sell 24H</Th>
      <Th className="w-14 text-center! px-3! whitespace-normal!">Entry</Th>
    </tr>
  );
}

export default function SignalTable({
  refreshKey,
  mode = 'dashboard',
  onTierChange: notifyTierChange,
}: {
  refreshKey?: number;
  mode?: 'dashboard' | 'rated';
  /** Called after a tier PUT settles so a sibling (kept-alive, possibly hidden) table refetches. */
  onTierChange?: () => void;
}) {
  const [signals, setSignals] = useState<TokenSignal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [walletsPopup, setWalletsPopup] = useState<TokenSignal | null>(null);
  const [fomoPopup, setFomoPopup] = useState<TokenSignal | null>(null);
  const allFactors = useAllFactors();
  // Tier edits are admin-only (server also enforces); viewers see a read-only badge.
  const { role } = useAuth();
  const isAdmin = role === 'admin';
  const [thresholds, setThresholds] = useState<NansenThresholds | null>(null);
  const [sort, setSort] = useState<SortState>(null);
  const [tierError, setTierError] = useState<string | null>(null);
  const [nansenFilter, setNansenFilter] = useState<Set<NansenFactor>>(new Set());
  const [holdingOnly, setHoldingOnly] = useState(false);
  const [mcMin, setMcMin] = useState('');
  const [mcMax, setMcMax] = useState('');
  const [freshMin, setFreshMin] = useState('');
  const [freshMax, setFreshMax] = useState('');
  const [holdingMin, setHoldingMin] = useState('');
  const [holdingMax, setHoldingMax] = useState('');
  const [rankFilter, setRankFilter] = useState<Set<Tier>>(new Set(RATED_TIERS));

  useEffect(() => {
    let alive = true;
    const load = (first: boolean) => {
      dataStore
        .listSignals(mode === 'rated' ? true : allFactors)
        .then((rows) => {
          if (alive) setSignals(rows);
        })
        .catch((e: unknown) => {
          if (alive && first) setError(e instanceof Error ? e.message : String(e));
        });
      dataStore
        .getSettings()
        .then((s) => {
          if (alive) setThresholds(s.values);
        })
        .catch(() => {
          /* display toggle only — a read failure keeps the last value */
        });
    };
    load(true);
    // Server sweeps on its own cadence; 30s poll picks changed rows up without a reload.
    const id = setInterval(() => load(false), 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [refreshKey, allFactors, mode]);

  if (error) return <ErrorState message={error} onRetry={() => window.location.reload()} />;

  if (!signals) {
    return (
      <TableShell>
        <table className={`table-fixed w-full ${TABLE_MIN_W} border-collapse text-left`}>
          <thead>
            <SignalHead allFactors={allFactors} />
          </thead>
          <SkeletonRows rows={8} cols={(allFactors ? 19 : 18) + FOMO_EXTRA} />
        </table>
      </TableShell>
    );
  }

  // score >= 1 is the "active signal" line counted in the strip below;
  // allFactors (debug) widens the TABLE to every tracked CA, not just passers.
  const passing = signals.filter((s) => s.nansen.score >= 1 || s.tier !== null);
  const base = allFactors ? signals : passing;

  // Client-side filters. mcPass fails open on absent marketCap, matching the
  // server's convention — unknown is not evidence.
  const nansenPass = (s: TokenSignal) => nansenFilter.size === 0 || [...nansenFilter].every((k) => s.nansen.pass[k]);
  const holdingPass = (s: TokenSignal) => !holdingOnly || rowHolding(s) > 0;
  // Inputs are entered in THOUSANDS of dollars (the label says "K$") — multiply by
  // 1000 to compare against the raw-USD marketCap, same as the reference design.
  const mcPass = (s: TokenSignal) => {
    const min = mcMin.trim() === '' ? null : Number(mcMin) * 1000;
    const max = mcMax.trim() === '' ? null : Number(mcMax) * 1000;
    if (s.marketCap === undefined) return true;
    if (min !== null && Number.isFinite(min) && s.marketCap < min) return false;
    if (max !== null && Number.isFinite(max) && s.marketCap > max) return false;
    return true;
  };
  const extraActive = holdingOnly || [mcMin, mcMax, freshMin, freshMax, holdingMin, holdingMax].some((v) => v.trim() !== '');
  const filtered = base.filter((s) => nansenPass(s) && holdingPass(s) && mcPass(s)
    && freshPercentageInRange(s.nansen, freshMin, freshMax)
    && percentageInRange(rowHolding(s), holdingMin, holdingMax));

  // P is dashboard-only — it never enters the Rated tab (user 2026-09-29).
  const ratedAll = signals.filter((s): s is TokenSignal & { tier: Tier } => s.tier !== null && s.tier !== 'P');
  // Rated is ALWAYS tier-ordered (S+ → B) — the column sort state does not apply.
  const ratedVisible = ratedAll
    .filter((s) => rankFilter.has(s.tier))
    .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier]);

  if (mode === 'rated') {
    if (ratedAll.length === 0) {
      return (
        <div className="frame frame-empty">
          <div className="empty-title">No tokens have been tiered yet.</div>
          <div className="empty-sub">Go to the Dashboard tab, set a Tier (S+, S, A+, A, B+, B) for a few tokens, then come back here.</div>
        </div>
      );
    }
  } else if (base.length === 0) {
    return <EmptyState title="No signals yet" hint="Signals will appear once the alpha engine starts streaming tokens." />;
  }

  const sortVal = (s: TokenSignal, key: SortKey): number | undefined =>
    key === 'holders'
      ? s.holders
      : key === 'trackedInflow'
        ? rowInflow(s)
        : key === 'trackedHolding'
          ? rowHolding(s)
          : key === 'volume1h'
            ? s.volume1h
            : key === 't100'
              ? s.nansen.t100?.multiple
              : key === 'lf'
                ? s.nansen.lf
                : key === 'fresh'
                  ? s.nansen.fresh
                  : key === 'mc'
                    ? s.marketCap
                    : key === 'trackedIn'
                      ? rowTrackedIn(s)
                      : s.volume24h;

  const sorted = [...filtered].sort((a, b) => {
    // Pass ("P") always sinks below every non-P row, in BOTH directions and with no
    // column armed — same "always loses" shape as an undefined metric below.
    const ap = a.tier === 'P' ? 1 : 0;
    const bp = b.tier === 'P' ? 1 : 0;
    if (ap !== bp) return ap - bp;
    // Default: newest FOMO BUY on B; newest wallet-watch activity on A.
    if (!sort) return SHOW_FOMO
      ? (b.fomoBuyAt ?? 0) - (a.fomoBuyAt ?? 0)
      : b.trackedActivityAt - a.trackedActivityAt;
    const av = sortVal(a, sort.key);
    const bv = sortVal(b, sort.key);
    // A metric with no value yet (1H volume before its first sweep) sinks in BOTH directions.
    if (av === undefined || bv === undefined) return av === bv ? 0 : av === undefined ? 1 : -1;
    return sort.dir === 'asc' ? av - bv : bv - av;
  });
  const visible: TokenSignal[] = mode === 'rated' ? ratedVisible : sorted;
  const totalVolume = visible.reduce((acc, s) => acc + s.volume24h, 0);

  /* First click arms a column (desc for these magnitudes); clicking it again flips the direction. */
  const toggleSort = (key: SortKey) =>
    setSort((prev) => (prev?.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }));

  const toggleNansen = (k: NansenFactor) =>
    setNansenFilter((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const toggleRank = (t: Tier) =>
    setRankFilter((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });

  /** Optimistic tier write: flip the row now, revert + surface the error if the PUT fails. */
  const onTierChange = (row: TokenSignal, tier: Tier | null) => {
    setTierError(null);
    const prev = row.tier;
    setSignals((cur) => (tier === 'P' ? cur?.filter((r) => r.id !== row.id) ?? cur : cur?.map((r) => (r.id === row.id ? { ...r, tier } : r)) ?? cur));
    dataStore
      .setTier(row.ca, row.chain, tier)
      .then(() => notifyTierChange?.())
      .catch((e: unknown) => {
        setSignals((cur) => cur?.map((r) => (r.id === row.id ? { ...r, tier: prev } : r)) ?? cur);
        setTierError(e instanceof Error ? e.message : String(e));
      });
  };

  const summaryCells: StatCell[] =
    mode === 'rated'
      ? [
          { label: 'Tiered so far', value: String(ratedAll.length) },
          { label: 'S-tier (S+/S)', value: String(tieredCount(ratedAll, 's')), numStyle: { color: '#6B7A1B' } },
          { label: 'A-tier (A+/A)', value: String(tieredCount(ratedAll, 'a')), numStyle: { color: 'var(--c-pos)' } },
          { label: 'B-tier (B+/B)', value: String(tieredCount(ratedAll, 'b')), numStyle: { color: 'var(--c-muted)' } },
        ]
      : [
          { label: 'Tokens tracked', value: String(signals.length) },
          { label: 'Active signal', value: String(passing.length), variant: 'hi' },
          { label: 'Watch signal', value: String(signals.length - passing.length), variant: 'watch' },
          { label: '24H volume, combined', value: usd(totalVolume) },
        ];

  const ratedEmpty = mode === 'rated' && visible.length === 0;
  const colCount = (allFactors ? 19 : 18) + FOMO_EXTRA;

  return (
    <div className="w-full">
      {mode === 'rated' ? <RatedHero /> : <Hero count={visible.length} />}
      <StatRow cells={summaryCells} />
      <div className="section-head">
        <h2>{mode === 'rated' ? 'Rated watchlist' : 'Token watchlist'}</h2>
        <span className="meta">
          {mode === 'rated'
            ? rankFilter.size < RATED_TIERS.length
              ? `Showing ${visible.length}/${ratedAll.length} rated tokens (filtered by rank)`
              : `${ratedAll.length}/${signals.length} tokens tiered`
            : sort
              ? `sorted by ${SORT_LABEL[sort.key]}, ${sort.dir === 'asc' ? 'ascending' : 'descending'}`
              : SHOW_FOMO ? 'sorted by latest FOMO buy' : 'sorted by tracked activity'}
        </span>
      </div>
      {tierError && <p className="px-1 pb-2 text-[12px] font-semibold text-neg">Tier update failed: {tierError}</p>}
      {mode === 'rated' ? (
        <div className="filter-row">
          <span className="filter-label">Filter by rank</span>
          <Chip variant="all" on={rankFilter.size === RATED_TIERS.length} onClick={() => setRankFilter(new Set(RATED_TIERS))}>
            All
          </Chip>
          {RATED_TIERS.map((t) => (
            <Chip key={t} variant="tier" tier={t} on={rankFilter.has(t)} onClick={() => toggleRank(t)}>
              {t}
            </Chip>
          ))}
        </div>
      ) : (
        <>
          <div className="filter-row">
            <span className="filter-label">Filter by Nansen setup</span>
            <Chip variant="all" on={nansenFilter.size === 0} onClick={() => setNansenFilter(new Set())}>
              All
            </Chip>
            <Chip variant="nansen" on={nansenFilter.has('t100')} onClick={() => toggleNansen('t100')}>
              Top100
            </Chip>
            <Chip variant="nansen" on={nansenFilter.has('lf')} onClick={() => toggleNansen('lf')}>
              Low Float
            </Chip>
            <Chip variant="nansen" on={nansenFilter.has('fresh')} onClick={() => toggleNansen('fresh')}>
              Fresh Wallet
            </Chip>
            {nansenFilter.size > 0 && (
              <span className="filter-label" style={{ marginLeft: 4, textTransform: 'none', fontWeight: 600 }}>
                {filtered.length}/{base.length} tokens meet the selected conditions
              </span>
            )}
          </div>
          <div className="filter-row">
            <span className="filter-label">More filters</span>
            <Chip variant="nansen" on={holdingOnly} onClick={() => setHoldingOnly((v) => !v)}>
              Still holding
            </Chip>
            <span className="filter-label" style={{ marginLeft: 8, textTransform: 'none' }}>
              Market Cap (K$)
            </span>
            <input
              type="number"
              inputMode="numeric"
              className="mc-filter-input"
              placeholder="Min"
              aria-label="Minimum market cap"
              value={mcMin}
              onChange={(e) => setMcMin(e.target.value)}
            />
            <span style={{ color: 'var(--c-muted)', fontWeight: 700 }}>–</span>
            <input
              type="number"
              inputMode="numeric"
              className="mc-filter-input"
              placeholder="Max"
              aria-label="Maximum market cap"
              value={mcMax}
              onChange={(e) => setMcMax(e.target.value)}
            />
            <span className="filter-label" style={{ marginLeft: 8, textTransform: 'none' }}>Fresh wallets (%)</span>
            <input type="number" min="0" max="100" step="any" inputMode="decimal" className="mc-filter-input" placeholder="Min" aria-label="Minimum fresh wallets percentage" value={freshMin} onChange={(e) => setFreshMin(e.target.value)} />
            <span className="text-muted font-bold">–</span>
            <input type="number" min="0" max="100" step="any" inputMode="decimal" className="mc-filter-input" placeholder="Max" aria-label="Maximum fresh wallets percentage" value={freshMax} onChange={(e) => setFreshMax(e.target.value)} />
            <span className="filter-label" style={{ marginLeft: 8, textTransform: 'none' }}>Tracked holding (%)</span>
            <input type="number" min="0" max="100" step="any" inputMode="decimal" className="mc-filter-input" placeholder="Min" aria-label="Minimum tracked holding percentage" value={holdingMin} onChange={(e) => setHoldingMin(e.target.value)} />
            <span className="text-muted font-bold">–</span>
            <input type="number" min="0" max="100" step="any" inputMode="decimal" className="mc-filter-input" placeholder="Max" aria-label="Maximum tracked holding percentage" value={holdingMax} onChange={(e) => setHoldingMax(e.target.value)} />
            {extraActive && (
              <button type="button" className="text-[12px] font-semibold text-pos hover:underline" onClick={() => {
                setHoldingOnly(false); setMcMin(''); setMcMax(''); setFreshMin(''); setFreshMax(''); setHoldingMin(''); setHoldingMax('');
              }}>Reset filters</button>
            )}
            {extraActive && (
              <span className="filter-label" style={{ marginLeft: 4, textTransform: 'none', fontWeight: 600 }}>
                {filtered.length}/{base.length} tokens match
              </span>
            )}
          </div>
        </>
      )}
      {ratedEmpty ? (
        <div className="frame frame-empty">
          <div className="empty-title">No tokens match the current filter.</div>
          <div className="empty-sub">Click "All" above or select other ranks to see them again.</div>
        </div>
      ) : (
        <div className="frame">
          <div className="overflow-x-auto">
            <table className={`w-full ${TABLE_MIN_W} table-fixed border-collapse text-left`}>
              <thead>
                <SignalHead
                  thresholds={thresholds}
                  sort={mode === 'rated' ? null : sort}
                  onSort={mode === 'rated' ? undefined : toggleSort}
                  allFactors={allFactors}
                />
              </thead>
              <tbody className="[&>tr:last-child>td]:border-b-0">
                {visible.length === 0 ? (
                  <tr>
                    <td colSpan={colCount} className="px-6 py-10 text-center text-[13px] font-semibold text-muted">
                      No tokens match the selected filters.
                    </td>
                  </tr>
                ) : (
                  visible.map((s, i) => {
                    const green = s.volume24h < ENTRY_VOLUME_THRESHOLD;
                    const isPass = s.tier === 'P';
                    return (
                      <tr
                        key={s.id}
                        className={`transition-colors ${
                          isPass
                            ? 'bg-surface2 text-muted opacity-45 hover:bg-hover hover:opacity-90'
                            : 'odd:bg-surface even:bg-surface2 hover:bg-hover'
                        }`}
                      >
                        {allFactors && (
                          <Td className="w-10 text-center font-mono text-[13px] tabular-nums text-muted">{i + 1}</Td>
                        )}
                        <Td className="w-20 px-2.5! text-center!">
                          <div className="relative inline-block">
                            <TokenAvatar iconUrl={s.iconUrl} symbol={s.symbol} ca={s.ca} />
                            {SHOW_FOMO && (
                              <span className="absolute -bottom-1 -right-1">
                                <ChainBadge chain={s.chain} />
                              </span>
                            )}
                          </div>
                        </Td>
                        <Td className="w-32">
                          <span
                            className="flex items-center gap-[2px] text-[13.5px] font-bold text-ink"
                            title={s.symbol ? `$${s.symbol.toUpperCase()}` : undefined}
                          >
                            <span aria-hidden className="text-pos">
                              $
                            </span>
                            <span className="min-w-0 truncate">{s.symbol?.toUpperCase() ?? '—'}</span>
                            <TokenNote ca={s.ca} chain={s.chain} symbol={s.symbol} note={s.note} onSaved={(note) => {
                              setSignals((rows) => rows?.map((row) => row.ca === s.ca && row.chain === s.chain ? { ...row, note } : row) ?? rows);
                              notifyTierChange?.();
                            }} />
                          </span>
                        </Td>
                        <Td className="w-16 text-center">
                          {isAdmin ? (
                            <TierSelect tier={s.tier} onChange={(t) => onTierChange(s, t)} />
                          ) : (
                            <TierBadge tier={s.tier} />
                          )}
                        </Td>
                        <Td className="w-24 text-center font-mono text-[13px] tabular-nums text-ink2">
                          {s.marketCap !== undefined ? usd(s.marketCap) : '—'}
                        </Td>
                        <Td className="w-40 text-center">
                          <CaCell ca={s.ca} chain={s.chain} xHandle={s.xHandle} />
                        </Td>
                        <Td className={SHOW_FOMO ? 'w-[768px]' : 'w-96'}>
                          {SHOW_FOMO ? (
                            <div className="min-w-0">
                              {s.fomoUsers.length === 0 ? (
                                <Pill active={false}>none</Pill>
                              ) : (
                                <>
                                  <FomoTable users={s.fomoUsers.slice(0, 3)} />
                                  {s.fomoUsers.length > 3 && (
                                    <button
                                      type="button"
                                      onClick={() => setFomoPopup(s)}
                                      className="mt-1.5 block text-[10.5px] font-medium text-pos hover:underline"
                                      title="Xem toàn bộ FOMO user đã trade token này"
                                    >
                                      +{s.fomoUsers.length - 3} more
                                    </button>
                                  )}
                                </>
                              )}
                            </div>
                          ) : s.trackedWallets.length === 0 ? (
                            <Pill active={false}>none</Pill>
                          ) : (
                            <div className="min-w-0">
                              <WalletTable wallets={s.trackedWallets.slice(0, 3)} />
                              {s.trackedWallets.length > 3 && (
                                <button
                                  type="button"
                                  onClick={() => setWalletsPopup(s)}
                                  className="mt-1.5 block text-[10.5px] font-medium text-pos hover:underline"
                                  title="Xem toàn bộ wallet đang track token này"
                                >
                                  +{s.trackedWallets.length - 3} more
                                </button>
                              )}
                            </div>
                          )}
                        </Td>
                        <Td className="w-20 text-center font-mono text-[13px] tabular-nums text-ink2">{rowTrackedIn(s)}</Td>
                        <Td className={`w-24 ${NS_CELL} ${NS_START}`}>
                          <SetupValue value={s.nansen.t100?.multiple !== undefined ? fmtNum(s.nansen.t100.multiple) : '—'} pass={s.nansen.pass.t100} />
                        </Td>
                        <Td className={`w-24 ${NS_CELL}`}>
                          <SetupValue value={s.nansen.lf !== undefined ? compact(s.nansen.lf) : '—'} pass={s.nansen.pass.lf} />
                        </Td>
                        <Td className={`w-24 ${NS_CELL} ${NS_END}`}>
                          <FreshWalletChart ca={s.ca} symbol={s.symbol} fresh={s.nansen.fresh} pass={s.nansen.pass.fresh} history={s.nansen.freshHistory} updatedAt={s.nansen.freshUpdatedAt} />
                        </Td>
                        <Td className="w-24 text-center font-mono tabular-nums text-[13px] text-ink2">{fmtInt(s.holders)}</Td>
                        <Td className="w-28">
                          <div className="text-center font-mono text-[13px] tabular-nums text-ink2"><span className={volumeClass(rowInflow(s), 'inflow')}>{usd(rowInflow(s))}</span></div>
                        </Td>
                        <Td className="w-28">
                          <div className="text-center font-mono text-[13px] tabular-nums text-ink2">{pct(rowHolding(s))}</div>
                        </Td>
                        <Td className="w-28">
                          <div className="text-center font-mono text-[13px] tabular-nums text-ink2">
                            {s.volume1h !== undefined ? usd(s.volume1h) : '—'}
                          </div>
                        </Td>
                        <Td className="w-28">
                          <div className="text-center font-mono text-[13px] tabular-nums text-ink2">{usd(s.volume24h)}</div>
                        </Td>
                        <Td className="w-28 text-center font-mono text-[13px] tabular-nums text-ink2">
                          <span className={volumeClass(s.buyVol24h, 'buy')}>{s.buyVol24h !== undefined ? usd(s.buyVol24h) : '—'}</span>
                        </Td>
                        <Td className="w-28 text-center font-mono text-[13px] tabular-nums">
                          <span className={volumeClass(s.sellVol24h, 'sell')}>{s.sellVol24h !== undefined ? usd(s.sellVol24h) : '—'}</span>
                        </Td>
                        <Td className="w-14 text-center">
                          <CheckSquare ok={green} title={`24H volume ${usd(s.volume24h)} · entry threshold ${usd(ENTRY_VOLUME_THRESHOLD)}`} />
                        </Td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <ScanFooter />
      {walletsPopup && (
        <Modal
          title={`Tracked by — ${walletsPopup.symbol ?? walletsPopup.ca} (${walletsPopup.trackedWallets.length} wallets)`}
          onClose={() => setWalletsPopup(null)}
        >
          <div className="max-h-72 overflow-auto">
            <WalletTable wallets={walletsPopup.trackedWallets} head />
          </div>
        </Modal>
      )}
      {SHOW_FOMO && fomoPopup && (
        <Modal
          title={`FOMO by — ${fomoPopup.symbol ?? fomoPopup.ca} (${fomoPopup.fomoUsers.length} users)`}
          onClose={() => setFomoPopup(null)}
        >
          <div className="max-h-72 overflow-auto">
            <FomoTable users={fomoPopup.fomoUsers} head />
          </div>
        </Modal>
      )}
    </div>
  );
}
