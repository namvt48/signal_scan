import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { MagnifyingGlass, XLogo } from '@phosphor-icons/react';
import { dataStore } from '../services/dataStore';
import { useAllFactors } from '../services/debugFlags';
import { CHAIN_LINKS } from '../chain';
import { SHOW_CLAN, SHOW_FOMO } from '../config';
import { RATED_TIERS, type Chain, type FomoUserStat, type NansenThresholds, type Tier, type TokenSignal, type TrackedWalletStat } from '../types';
import { ago, compact, formatTimestamp, pct, shortAddr, tokenAmount, usd } from '../lib/format';
import { sortTrackedWalletsByBalance, type WalletBalanceSort } from '../lib/walletSort';
import { freshDisplayValue, freshPercentageInRange, holderCountClass, percentageInRange, sumKnownPercentages, sumKnownUsd, trackedHoldingClass, trackedUsdClass, volume24hClass, volumeClass } from '../lib/signalMetrics';
import { compareFomoUserActivity } from '../lib/fomoSort';
import { TokenNote } from './TokenNote';
import { FreshWalletChart } from './FreshWalletChart';
import { T100Chart } from './T100Chart';
import { HolderCountChart } from './HolderCountChart';
import { MarketCapChart } from './MarketCapChart';
import { Chip, EmptyState, ErrorState, Modal, Pill, SkeletonRows, TableShell, Td, Th, TierBadge, TierSelect, TokenAvatar, walletNameClass } from './ui';
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
  ? ['19%', '10%', '8%', '14%', '18%', '11%', '12%', '8%']
  : ['21%', '8%', '16%', '19%', '11%', '14%', '11%'];

/*
 * FOMO column shares, parallel to WALLET_COLS: User / Clan? / Bal / Trades / Buy $ / Sell $ / Age.
 * Same SHOW_CLAN rule so the inline table, the header sub-line, and the modal table
 * line up row for row. Shares track each column's widest content (user 2026-10-01):
 * the old split starved the right pair (Sell $ ↔ Age ~16px) and left Clan/Trades
 * with >100px of dead space, so the horizontal rhythm read ragged.
 */
const FOMO_COLS: readonly string[] = SHOW_CLAN
  ? ['21%', '10%', '14%', '12%', '15%', '15%', '13%']
  : ['26%', '16%', '14%', '16%', '16%', '12%'];

/** FOMO lives inside the "Tracked by" column as a second stacked list, so the column count is unchanged. */
const FOMO_EXTRA = 0;
const INLINE_ACTIVITY_LIMIT = 5;
/** Keep ticker text readable beside its note button in both deployment variants. */
const TABLE_MIN_W = SHOW_FOMO ? 'min-w-[2324px]' : 'min-w-[2036px]';

/**
 * FOMO rows retain FOMO-user inflow/holding semantics. FOMO holding is the sum
 * of each user's position value ÷ CA market cap (not supply share). The FOMO
 * `Tracked in` count includes both matched FOMO users and native wallets that
 * traded this CA; their names remain separate in the breakdown so identities
 * are not conflated.
 */
const rowInflow = (s: TokenSignal): number | null => (SHOW_FOMO
  ? sumKnownUsd(s.fomoUsers.map((u) => u.buyUsd))
  : s.trackedInflow);
const rowHolding = (s: TokenSignal): number | undefined => (SHOW_FOMO
  ? sumKnownPercentages(s.fomoUsers.map((u) => u.holdingPct))
  : s.trackedHolding);
const rowHoldingPartial = (s: TokenSignal): boolean => SHOW_FOMO
  && s.fomoUsers.some((user) => user.holdingPct === undefined);
const rowTrackedIn = (s: TokenSignal): number =>
  SHOW_FOMO ? s.fomoUsers.length + s.trackedWallets.length : s.trackedWallets.length;

function walletBalanceLabel(wallet: { balUsd?: number; holdingPct?: number }): string {
  const balance = wallet.balUsd !== undefined ? usd(wallet.balUsd) : '—';
  const share = wallet.holdingPct !== undefined && Number.isFinite(wallet.holdingPct)
    ? ` (${pct(wallet.holdingPct)})`
    : '';
  return `${balance}${share}`;
}

function tokenBalanceTooltip(amount?: number): string | undefined {
  const formatted = tokenAmount(amount);
  return formatted === undefined ? undefined : `Current token balance: ${formatted}`;
}

/**
 * Wallet breakdown rows (Wallet / Clan / Bal / TXs / Inflow / Age). `head` adds the
 * column labels — the inline cell relies on the "Tracked by" Th sub-line above,
 * so only the popup (a standalone table) renders them.
 */
interface WalletTableProps {
  wallets: TrackedWalletStat[];
  head?: boolean;
  balanceSort: WalletBalanceSort;
  onBalanceSort: () => void;
  limit?: number;
}

function WalletTable({ wallets, head = false, balanceSort, onBalanceSort, limit }: WalletTableProps) {
  const sortedWallets = sortTrackedWalletsByBalance(wallets, balanceSort);
  const rows = limit === undefined ? sortedWallets : sortedWallets.slice(0, limit);
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
            <th className="pb-1 pr-2 text-left">Wallet</th>
            {SHOW_CLAN && <th className="pb-1 pr-2 text-left">Clan</th>}
            <th className="pb-1 pr-1 text-center">Rank</th>
            <th className="pb-1 pr-1 text-left">Group</th>
            <th className="whitespace-nowrap pb-1 pr-1 text-right">
              <button type="button" onClick={onBalanceSort} title="Sort tracked wallets by balance within this CA" className="group cursor-pointer select-none">
                Bal <SortIcon dir={balanceSort} />
              </button>
            </th>
            <th className="pb-1 pr-2 text-right">TXs</th>
            <th className="pb-1 pr-2 text-right">Inflow</th>
            <th className="pb-1 pl-1 text-left">Age</th>
          </tr>
        </thead>
      )}
      <tbody>
        {rows.map((w) => (
          <tr key={w.name}>
            <td className="py-1 pr-2 text-[11px]">
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
            <td className="py-1 pr-1 text-center font-mono text-[10px]">
              {w.rank ? (
                <span className="cohort-rank" data-rank={w.rank}>{w.rank}</span>
              ) : (
                <span className="text-muted">—</span>
              )}
            </td>
            <td className="py-1 pr-1 font-mono text-[9px]">
              {w.groups?.length ? (
                <span className="inline-flex gap-1 whitespace-nowrap" aria-label={w.groups.join(', ')}>
                  {w.groups.map((group) => (
                    <span key={group} className="cohort-group" title={group}>
                      {group.split('_', 1)[0]}
                    </span>
                  ))}
                </span>
              ) : (
                <span className="text-muted">—</span>
              )}
            </td>
            <td className="whitespace-nowrap py-1 pr-1 text-right font-mono text-[11px] tabular-nums text-ink2">
              <span className={trackedUsdClass(w.balUsd)} title={tokenBalanceTooltip(w.holdingAmount)}>{walletBalanceLabel(w)}</span>
            </td>
            <td className="py-1 pr-2 text-right font-mono text-[11px] tabular-nums">
              <span className="font-semibold text-pos">{w.buys}</span>
              <span className="text-muted">/</span>
              <span className="font-semibold text-neg">{w.sells}</span>
            </td>
            <td className={`py-1 pr-2 text-right font-mono text-[11px] font-medium tabular-nums ${w.inflow >= 0 ? 'text-pos' : 'text-neg'}`}>
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
 * FOMO breakdown rows (User / Clan? / Bal / Trades / Buy $ / Sell $ / Age), sibling of WalletTable.
 * `buyUsd` is Σ BUY spend and `sellUsd` is Σ SELL proceeds — reported separately,
 * never a net figure. Bal is position value; its parenthesized percentage is
 * that value divided by the CA market cap. Newest trade first; long handles
 * truncate; numerics right-aligned mono like the wallet rows.
 */
function FomoTable({ users, head = false, limit }: { users: FomoUserStat[]; head?: boolean; limit?: number }) {
  const sortedRows = [...users].sort((a, b) => b.lastTs - a.lastTs);
  const rows = limit === undefined ? sortedRows : sortedRows.slice(0, limit);
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
            <th className="whitespace-nowrap pb-1 pr-1 text-right">Bal</th>
            <th className="pb-1 pr-3 text-right">Trades</th>
            <th className="pb-1 pr-3 text-right">Buy $</th>
            <th className="pb-1 pr-3 text-right">Sell $</th>
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
            <td className="whitespace-nowrap py-1 pr-1 text-right font-mono text-[11px] tabular-nums text-ink2" title="Current position value; parenthesized percentage is position value ÷ CA market cap">
              <span className={trackedUsdClass(u.balUsd)} title={tokenBalanceTooltip(u.holdingAmount)}>{walletBalanceLabel(u)}</span>
            </td>
            <td className="py-1 pr-3 text-right font-mono text-[11px] tabular-nums">
              <span className="font-semibold text-pos">{u.buys}</span>
              <span className="text-muted">/</span>
              <span className="font-semibold text-neg">{u.sells}</span>
            </td>
            <td className="py-1 pr-3 text-right font-mono text-[11px] font-medium tabular-nums text-pos" title="24h BUY spend; — when any in-window amount is unavailable">
              <span className={volumeClass(u.buyUsd ?? undefined, 'buy')}>{u.buyUsd === null ? '—' : usd(u.buyUsd)}</span>
            </td>
            <td
              className="py-1 pr-3 text-right font-mono text-[11px] font-medium tabular-nums text-neg"
              title="Σ sell proceeds (USD actually received) in the last 24h; — when any sell amount is unavailable"
            >
              {u.sellUsd === null ? '—' : usd(u.sellUsd)}
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
          Top <b className="font-bold text-ink">{count} tokens</b> ranked by {SHOW_FOMO ? 'latest FOMO-user trade in the 24h stats window' : 'latest tracked wallet activity'}.
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
 * "Tracked Holding" sat 6.1px to the right of its column. px-3 gives the label room;
 * whitespace-normal lets it wrap instead of overflow at min-w. The sort caret rides in the gutter that frees up.
 */
const C_HEAD = `${HL_HEAD} px-3! whitespace-normal!`;

type SortKey = 'holders' | 'trackedIn' | 'trackedInflow' | 'trackedHolding' | 'volume1h' | 'volume24h' | 't100' | 'lf' | 'fresh' | 'mc';
/** null = default newest activity on A / newest social or native trade on B — no column armed. */
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

interface SortIconProps {
  dir: WalletBalanceSort;
}

function SortIcon({ dir }: SortIconProps) {
  return (
    <span className={`text-[11px] font-semibold ${dir === null ? 'text-muted' : 'text-pos'} group-hover:text-ink2`}>
      {dir === 'asc' ? '▲' : dir === 'desc' ? '▼' : '↕'}
    </span>
  );
}

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
          <SortIcon dir={dir} />
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
  walletBalanceSort = null,
  onWalletBalanceSort,
}: {
  thresholds?: NansenThresholds | null;
  sort?: SortState;
  onSort?: (key: SortKey) => void;
  /* Debug-only: the STT column renders only while the allFactors flag is on. */
  allFactors?: boolean;
  walletBalanceSort?: WalletBalanceSort;
  onWalletBalanceSort?: () => void;
}) {
  return (
    <tr>
      {allFactors && <Th className="w-10 text-center!">STT</Th>}
      <Th className="w-20 px-2.5! text-center!">{null}</Th>
      <Th className="signal-ticker-col">Ticker</Th>
      <Th className="signal-tier-col w-16 text-center!">Tier</Th>
      <SortTh
        label="MC"
        col="mc"
        sort={sort}
        onSort={onSort}
        className="signal-mc-col w-24 text-center! px-3! whitespace-normal!"
        subLabel={
          thresholds && (thresholds.minMc > 0 || thresholds.maxMc > 0) ? (
            <span className="mt-1 block font-mono text-[10px] font-medium text-muted">{mcBand(thresholds)}</span>
          ) : undefined
        }
      />
      <Th className="signal-ca-col w-40 text-center!">CA</Th>
      <Th
        className={`signal-tracked-col ${SHOW_FOMO ? 'w-[768px]' : 'w-[480px]'} text-center!`}
        title={
          SHOW_FOMO
            ? 'FOMO watch-list activity. Buy $ is Σ BUY spend, Sell $ is Σ SELL proceeds — neither is net inflow or PnL.'
            : undefined
        }
      >
        {SHOW_FOMO ? (
          <>
            <span className="block font-mono text-[10px] font-bold tracking-[0.03em] text-muted uppercase">FOMO by</span>
            <span className="mt-1 grid font-mono text-[10px] font-medium text-muted" style={{ gridTemplateColumns: FOMO_COLS.join(' ') }}>
              <span className="text-left">User</span>
              {SHOW_CLAN && <span className="text-left">Clan</span>}
              <span className="whitespace-nowrap pr-1 text-right" title="Current position value; percentage = value ÷ market cap">Bal</span>
              <span className="pr-3 text-right">Trades</span>
              <span className="pr-3 text-right" title="Σ BUY spend — not net inflow/PnL">
                Buy $
              </span>
              <span className="pr-3 text-right" title="Σ SELL proceeds — not realised PnL">
                Sell $
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
              <span className="pr-1 text-center">Rank</span>
              <span className="pr-1 text-left">Group</span>
              <button
                type="button"
                onClick={onWalletBalanceSort}
                title="Sort tracked wallet balances within each CA; CA order stays unchanged"
                className="group cursor-pointer select-none whitespace-nowrap pr-1 text-right"
              >
                Bal <SortIcon dir={walletBalanceSort} />
              </button>
              <span className="pr-2 text-right">TXs</span>
              <span className="pr-2 text-right">Inflow</span>
              <span className="pl-1 text-left">Age</span>
            </span>
          </>
        )}
      </Th>
      <SortTh label="Tracked in" col="trackedIn" sort={sort} onSort={onSort} className="w-16 text-center!" />
      <SortTh
        label="Top100"
        col="t100"
        sort={sort}
        onSort={onSort}
        className={`w-20 ${C_HEAD} ${NS_HEAD} ${NS_START}`}
        subLabel={thresholds ? <span className="mt-1 block font-mono text-[10px] font-medium text-muted">≥ {thresholds.t100MinMultiple}</span> : undefined}
      />
      <SortTh
        label="Low Float"
        col="lf"
        sort={sort}
        onSort={onSort}
        className={`w-20 ${C_HEAD} ${NS_HEAD}`}
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
        className={`w-20 ${C_HEAD} ${NS_END}`}
        subLabel={thresholds ? <span className="mt-1 block font-mono text-[10px] font-medium text-muted">≥ {thresholds.freshMinPct}%</span> : undefined}
      />
      <SortTh label="Holder" col="holders" sort={sort} onSort={onSort} className={`w-20 ${C_HEAD}`} />
      <SortTh label="Tracked Inflow" col="trackedInflow" sort={sort} onSort={onSort} className={`w-24 ${C_HEAD}`} />
      <SortTh label="Tracked Holding" col="trackedHolding" sort={sort} onSort={onSort} className={`w-24 ${C_HEAD}`} />
      <SortTh label="1H Volume" col="volume1h" sort={sort} onSort={onSort} className={`w-24 ${C_HEAD}`} />
      <SortTh label="24H Volume" col="volume24h" sort={sort} onSort={onSort} className={`w-24 ${C_HEAD}`} />
    </tr>
  );
}

export default function SignalTable({
  refreshKey,
  mode = 'dashboard',
  active = true,
  onTierChange: notifyTierChange,
}: {
  refreshKey?: number;
  mode?: 'dashboard' | 'rated';
  active?: boolean;
  /** Called after a tier PUT settles so a sibling (kept-alive, possibly hidden) table refetches. */
  onTierChange?: () => void;
}) {
  const [signals, setSignals] = useState<TokenSignal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [walletsPopup, setWalletsPopup] = useState<TokenSignal | null>(null);
  const [fomoPopup, setFomoPopup] = useState<TokenSignal | null>(null);
  const lastSignalsAt = useRef(0);
  const queryKeyRef = useRef<string | null>(null);
  const refreshKeyRef = useRef<number | undefined>(undefined);
  const allFactors = useAllFactors();
  // Tier edits are admin-only (server also enforces); viewers see a read-only badge.
  const { role } = useAuth();
  const isAdmin = role === 'admin';
  const [thresholds, setThresholds] = useState<NansenThresholds | null>(null);
  const [walletBalanceSort, setWalletBalanceSort] = useState<WalletBalanceSort>(null);
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

  const openActivity = (signal: TokenSignal, target: 'wallets' | 'fomo') => {
    setWalletsPopup(target === 'wallets' ? signal : null);
    setFomoPopup(target === 'fomo' ? signal : null);
  };
  const closeActivity = () => {
    setWalletsPopup(null);
    setFomoPopup(null);
  };

  const toggleWalletBalanceSort = () => setWalletBalanceSort((current) => current === 'desc' ? 'asc' : 'desc');
  useEffect(() => {
    if (!active) return;
    let alive = true;
    let loading = false;
    let settingsLoaded = false;
    let controller: AbortController | null = null;
    const load = (first: boolean) => {
      if (document.visibilityState !== 'visible' || loading) return;
      loading = true;
      controller = new AbortController();
      dataStore
        .listSignals(mode === 'rated' ? true : allFactors, controller.signal)
        .then((rows) => {
          if (alive) {
            setSignals(rows);
            lastSignalsAt.current = Date.now();
          }
        })
        .catch((e: unknown) => {
          if (alive && first && !(e instanceof DOMException && e.name === 'AbortError')) {
            setError(e instanceof Error ? e.message : String(e));
          }
        })
        .finally(() => {
          loading = false;
        });
      if (first || !settingsLoaded) {
        settingsLoaded = true;
        dataStore
          .getSettings()
          .then((s) => {
            if (alive) setThresholds(s.values);
          })
          .catch(() => {
            /* display toggle only — a read failure keeps the last value */
          });
      }
    };
    const queryKey = `${mode}:${mode === 'rated' || allFactors ? '1' : '0'}`;
    const forceRefresh = queryKeyRef.current !== queryKey || refreshKeyRef.current !== refreshKey;
    queryKeyRef.current = queryKey;
    refreshKeyRef.current = refreshKey;
    if (forceRefresh || !signals || Date.now() - lastSignalsAt.current >= 30_000) load(true);
    const id = setInterval(() => load(false), 30_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') load(!settingsLoaded);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      alive = false;
      controller?.abort();
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [active, refreshKey, allFactors, mode]);

  if (error) return <ErrorState message={error} onRetry={() => window.location.reload()} />;

  if (!signals) {
    const loadingSummaryCells: StatCell[] = mode === 'rated'
      ? [
          { label: 'Tiered so far', value: '—' },
          { label: 'S-tier (S+/S)', value: '—' },
          { label: 'A-tier (A+/A)', value: '—' },
          { label: 'B-tier (B+/B)', value: '—' },
        ]
      : [
          { label: 'Tokens tracked', value: '—' },
          { label: 'Active signal', value: '—', variant: 'hi' },
          { label: 'Watch signal', value: '—', variant: 'watch' },
          { label: '24H volume, combined', value: '—' },
        ];
    return (
      <div className="w-full">
        <StatRow cells={loadingSummaryCells} />
        <TableShell>
          <table className={`table-fixed w-full ${TABLE_MIN_W} border-collapse text-left`}>
            <thead>
              <SignalHead allFactors={allFactors} walletBalanceSort={walletBalanceSort} />
            </thead>
            <SkeletonRows rows={8} cols={(allFactors ? 16 : 15) + FOMO_EXTRA} />
          </table>
        </TableShell>
      </div>
    );
  }

  // score >= 1 is the "active signal" line counted in the strip below;
  // allFactors (debug) widens the TABLE to every tracked CA, not just passers.
  const passing = signals.filter((s) => s.nansen.score >= 1 || s.tier !== null);
  const base = allFactors ? signals : passing;

  // Client-side filters. mcPass fails open on absent marketCap, matching the
  // server's convention — unknown is not evidence.
  const nansenPass = (s: TokenSignal) => nansenFilter.size === 0 || [...nansenFilter].every((k) => s.nansen.pass[k]);
  const holdingPass = (s: TokenSignal) => {
    const holding = rowHolding(s);
    return !holdingOnly || (holding !== undefined && holding > 0);
  };
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
        <div className="w-full">
          <RatedHero />
          <StatRow
            cells={[
              { label: 'Tiered so far', value: '0' },
              { label: 'S-tier (S+/S)', value: '0' },
              { label: 'A-tier (A+/A)', value: '0' },
              { label: 'B-tier (B+/B)', value: '0' },
            ]}
          />
          <div className="frame frame-empty">
            <div className="empty-title">No tokens have been tiered yet.</div>
            <div className="empty-sub">Go to the Dashboard tab, set a Tier (S+, S, A+, A, B+, B) for a few tokens, then come back here.</div>
          </div>
        </div>
      );
    }
  } else if (base.length === 0) {
    return (
      <div className="w-full">
        <Hero count={0} />
        <StatRow
          cells={[
            { label: 'Tokens tracked', value: String(signals.length) },
            { label: 'Active signal', value: String(passing.length), variant: 'hi' },
            { label: 'Watch signal', value: String(signals.length - passing.length), variant: 'watch' },
            { label: '24H volume, combined', value: usd(0) },
          ]}
        />
        <EmptyState title="No signals yet" hint="Signals will appear once the alpha engine starts streaming tokens." />
      </div>
    );
  }

  const sortVal = (s: TokenSignal, key: SortKey): number | null | undefined =>
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
    // Default FOMO order uses the latest FOMO-user trade in the same 24h window as Age.
    if (!sort) return SHOW_FOMO
      ? compareFomoUserActivity(a, b)
      : b.trackedActivityAt - a.trackedActivityAt;
    const av = sortVal(a, sort.key);
    const bv = sortVal(b, sort.key);
    // A metric with no value yet (1H volume before its first sweep) sinks in BOTH directions.
    if (av == null || bv == null) return av === bv ? 0 : av == null ? 1 : -1;
    return sort.dir === 'asc' ? av - bv : bv - av;
  });
  const visible: TokenSignal[] = mode === 'rated' ? ratedVisible : sorted;
  /* Cap one symbol's contribution: a 95-char Zalgo ticker (2026-10-21) inflated the column to
     1204px and left a blank gap before Tier. Real tickers up to 16 chars still size the column. */
  const tickerWidth = visible.reduce(
    (width, signal) => Math.max(width, Math.min(signal.symbol?.length ?? 1, 16) * 12 + 64),
    128,
  );
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
    setSignals((cur) => cur?.map((r) => (r.id === row.id ? { ...r, tier } : r)) ?? cur);
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
  const colCount = (allFactors ? 16 : 15) + FOMO_EXTRA;

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
              : SHOW_FOMO ? 'sorted by latest FOMO-user trade (24h)' : 'sorted by tracked activity'}
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
            <table className={`w-full ${TABLE_MIN_W} table-fixed border-collapse text-left`} style={{ '--ticker-width': `${tickerWidth}px` } as CSSProperties}>
              <thead>
                <SignalHead
                  thresholds={thresholds}
                  sort={mode === 'rated' ? null : sort}
                  onSort={mode === 'rated' ? undefined : toggleSort}
                  allFactors={allFactors}
                  walletBalanceSort={walletBalanceSort}
                  onWalletBalanceSort={toggleWalletBalanceSort}
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
                    const inflow = rowInflow(s);
                    const holding = rowHolding(s);
                    const holdingPartial = rowHoldingPartial(s);
                    const trackedWalletCount = s.trackedWallets.length;
                    const fomoUserCount = s.fomoUsers.length;
                    const hiddenActivityCount = Math.max(0, fomoUserCount - INLINE_ACTIVITY_LIMIT)
                      + Math.max(0, trackedWalletCount - INLINE_ACTIVITY_LIMIT);
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
                        <Td className="signal-ticker-col">
                          <span
                            className="ticker-cell flex items-center gap-[2px] text-[13.5px] font-bold text-ink"
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
                        <Td className="signal-tier-col w-16 text-center">
                          {isAdmin ? (
                            <TierSelect tier={s.tier} onChange={(t) => onTierChange(s, t)} />
                          ) : (
                            <TierBadge tier={s.tier} />
                          )}
                        </Td>
                        <Td
                          className="signal-mc-col w-24 text-center font-mono text-[13px] tabular-nums text-ink2"
                          title={s.dataUpdatedAt?.marketCap != null ? `Market cap response: ${formatTimestamp(s.dataUpdatedAt.marketCap)}` : undefined}
                        >
                          <MarketCapChart ca={s.ca} symbol={s.symbol} marketCap={s.marketCap} history={s.marketCapHistory} />
                        </Td>
                        <Td className="signal-ca-col w-40 text-center">
                          <CaCell ca={s.ca} chain={s.chain} xHandle={s.xHandle} />
                        </Td>
                        <Td className={`signal-tracked-col ${SHOW_FOMO ? 'w-[768px]' : 'w-[480px]'}`}>
                          {SHOW_FOMO ? (
                            <div className="min-w-0 space-y-1.5">
                              {fomoUserCount > 0 && (
                                <section>
                                  <div className="mb-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide text-muted">FOMO users</div>
                                  <FomoTable users={s.fomoUsers} limit={INLINE_ACTIVITY_LIMIT} />
                                </section>
                              )}
                              {trackedWalletCount > 0 && (
                                <section className={fomoUserCount > 0 ? 'border-t border-line/60 pt-1.5' : ''}>
                                  <div className="mb-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide text-muted">Native wallets</div>
                                  <WalletTable wallets={s.trackedWallets} limit={INLINE_ACTIVITY_LIMIT} balanceSort={walletBalanceSort} onBalanceSort={toggleWalletBalanceSort} />
                                </section>
                              )}
                              {fomoUserCount === 0 && trackedWalletCount === 0 && <Pill active={false}>none</Pill>}
                              {hiddenActivityCount > 0 && (
                                <button
                                  type="button"
                                  onClick={() => void openActivity(s, 'fomo')}
                                  className="mt-1.5 block text-[10.5px] font-medium text-pos hover:underline"
                                  title="Xem toàn bộ FOMO users và native wallets đã trade token này"
                                >
                                  +{hiddenActivityCount} more
                                </button>
                              )}
                            </div>
                          ) : trackedWalletCount === 0 ? (
                            <Pill active={false}>none</Pill>
                          ) : (
                            <div className="min-w-0">
                              <WalletTable wallets={s.trackedWallets} limit={INLINE_ACTIVITY_LIMIT} balanceSort={walletBalanceSort} onBalanceSort={toggleWalletBalanceSort} />
                              {trackedWalletCount > INLINE_ACTIVITY_LIMIT && (
                                <button
                                  type="button"
                                  onClick={() => void openActivity(s, 'wallets')}
                                  className="mt-1.5 block text-[10.5px] font-medium text-pos hover:underline"
                                  title="Xem toàn bộ wallet đang track token này"
                                >
                                  +{trackedWalletCount - INLINE_ACTIVITY_LIMIT} more
                                </button>
                              )}
                            </div>
                          )}
                        </Td>
                        <Td className="w-16 text-center font-mono text-[13px] tabular-nums text-ink2">{rowTrackedIn(s)}</Td>
                        <Td className={`w-20 ${NS_CELL} ${NS_START}`}>
                          <T100Chart
                            ca={s.ca}
                            symbol={s.symbol}
                            multiple={s.nansen.t100?.multiple}
                            pass={s.nansen.pass.t100}
                            history={s.nansen.t100History}
                            updatedAt={s.nansen.t100History?.at(-1)?.t}
                          />
                        </Td>
                        <Td className={`w-20 ${NS_CELL}`}>
                          <SetupValue value={s.nansen.lf !== undefined ? compact(s.nansen.lf) : '—'} pass={s.nansen.pass.lf} />
                        </Td>
                        <Td className={`w-20 ${NS_CELL} ${NS_END}`}>
                          <FreshWalletChart ca={s.ca} symbol={s.symbol} fresh={freshDisplayValue(s.nansen.rawFresh ?? s.nansen.fresh, thresholds?.freshMinPct ?? null, allFactors)} freshCurrent={s.nansen.freshCurrent} hasFreshTimestamp={(s.dataUpdatedAt?.fresh ?? s.nansen.freshUpdatedAt) !== undefined} pass={s.nansen.pass.fresh} history={s.nansen.freshHistory} marketCapHistory={s.marketCapHistory} updatedAt={s.dataUpdatedAt?.fresh ?? s.nansen.freshUpdatedAt} />
                        </Td>
                        <Td
                          className="w-20 text-center font-mono tabular-nums text-[13px] text-ink2"
                          title={s.dataUpdatedAt?.holders != null ? `Holder response: ${formatTimestamp(s.dataUpdatedAt.holders)}` : undefined}
                        >
                          <HolderCountChart
                            ca={s.ca}
                            symbol={s.symbol}
                            holders={s.holders}
                            marketCapHistory={s.marketCapHistory}
                            history={s.holdersHistory}
                            updatedAt={s.holdersHistory?.at(-1)?.t ?? s.dataUpdatedAt?.holders}
                            valueClassName={holderCountClass(s.holders)}
                          />
                        </Td>
                        <Td className="w-24">
                          <div className="text-center font-mono text-[13px] tabular-nums text-ink2" title={inflow === null ? 'One or more in-window FOMO BUY amounts are unavailable' : undefined}><span className={volumeClass(inflow ?? undefined, 'inflow')}>{inflow === null ? '—' : usd(inflow)}</span></div>
                        </Td>
                        <Td className="w-24">
                          <div className="text-center font-mono text-[13px] tabular-nums text-ink2" title={holdingPartial ? 'Σ FOMO position value ÷ CA market cap; unknown users are omitted' : undefined}>
                            <span className={trackedHoldingClass(holding)}>{holding !== undefined ? `${holdingPartial ? '≈' : ''}${pct(holding)}` : '—'}</span>
                          </div>
                        </Td>
                        <Td className="w-24">
                          <div
                            className="text-center font-mono text-[13px] tabular-nums text-ink2"
                            title={s.dataUpdatedAt?.volume24h != null ? `Volume response: ${formatTimestamp(s.dataUpdatedAt.volume24h)}` : undefined}
                          >
                            {s.volume1h !== undefined ? usd(s.volume1h) : '—'}
                          </div>
                        </Td>
                        <Td className="w-24">
                          <div
                            className="text-center font-mono text-[13px] tabular-nums text-ink2"
                            title={s.dataUpdatedAt?.volume24h != null ? `Volume response: ${formatTimestamp(s.dataUpdatedAt.volume24h)}` : undefined}
                          >
                            <span className={volume24hClass(s.volume24h)}>{usd(s.volume24h)}</span>
                          </div>
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
          onClose={closeActivity}
          className="trade-breakdown-modal"
        >
          <div className="trade-breakdown-content overflow-auto">
            {walletsPopup.trackedWallets.length > 0
              ? <WalletTable wallets={walletsPopup.trackedWallets} head balanceSort={walletBalanceSort} onBalanceSort={toggleWalletBalanceSort} />
              : <p className="text-xs text-muted">No tracked native-wallet trades.</p>}
          </div>
        </Modal>
      )}
      {SHOW_FOMO && fomoPopup && (
        <Modal
          title={`FOMO by — ${fomoPopup.symbol ?? fomoPopup.ca} (${fomoPopup.fomoUsers.length} users · ${fomoPopup.trackedWallets.length} native wallets)`}
          onClose={closeActivity}
          className="trade-breakdown-modal"
        >
          <div className="trade-breakdown-content space-y-4 overflow-auto">
            <p className="font-mono text-xs text-ink2">
              Tracked holding: {rowHolding(fomoPopup) !== undefined
                ? `${rowHoldingPartial(fomoPopup) ? '≈' : ''}${pct(rowHolding(fomoPopup)!)}`
                : '— (not measured)'}
            </p>
            <section>
              <h3 className="mb-2 font-mono text-[10px] font-bold uppercase tracking-wide text-muted">FOMO users</h3>
              {fomoPopup.fomoUsers.length > 0
                ? <FomoTable users={fomoPopup.fomoUsers} head />
                : <p className="text-xs text-muted">No FOMO users traded this CA.</p>}
            </section>
            <section className="border-t border-line pt-3">
              <h3 className="mb-2 font-mono text-[10px] font-bold uppercase tracking-wide text-muted">Native wallets</h3>
              {fomoPopup.trackedWallets.length > 0
                ? <WalletTable wallets={fomoPopup.trackedWallets} head balanceSort={walletBalanceSort} onBalanceSort={toggleWalletBalanceSort} />
                : <p className="text-xs text-muted">No tracked native-wallet trades.</p>}
            </section>
          </div>
        </Modal>
      )}
    </div>
  );
}
