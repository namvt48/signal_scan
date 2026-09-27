import { useEffect, useState, type ReactNode } from 'react';
import { dataStore } from '../services/dataStore';
import { useAllFactors } from '../services/debugFlags';
import { ENTRY_VOLUME_THRESHOLD, SHOW_CLAN } from '../config';
import type { NansenThresholds, TokenSignal, TrackedWalletStat } from '../types';
import { ago, compact, fmtInt, fmtNum, pct, shortAddr, usd } from '../lib/format';
import { CheckSquare, EmptyState, ErrorState, Modal, Pill, SkeletonRows, TableShell, Td, Th, TierBadge, TokenAvatar, walletNameClass } from './ui';

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

/**
 * Wallet breakdown rows (Wallet / Clan / Bal / TXs / Inflow / Age). `head` adds the
 * column labels — the inline cell relies on the "Tracked by" Th sub-line above,
 * so only the popup (a standalone table) renders them.
 */
function WalletTable({ wallets, head = false }: { wallets: TrackedWalletStat[]; head?: boolean }) {
  return (
    <table className="w-full table-fixed border-collapse">
      <colgroup>
        {WALLET_COLS.map((w) => (
          <col key={w} style={{ width: w }} />
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
              {usd(w.inflow)}
            </td>
            <td className="whitespace-nowrap py-1 pl-1 text-[10.5px] text-muted">{ago(w.lastTs)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* CA cell: opens the token page on GMGN in a new tab. */
function CaCell({ ca }: { ca: string }) {
  return (
    <a
      href={`https://gmgn.ai/sol/token/${ca}`}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open ${ca} on GMGN`}
      aria-label={`Open contract address ${ca} on GMGN`}
      className="flex w-full items-center justify-center"
    >
      <span className="min-w-0 truncate font-mono text-[11.5px] text-ink transition-colors hover:text-pos">
        {shortAddr(ca)}
      </span>
    </a>
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
          Top <b className="font-bold text-ink">{count} tokens</b> ranked by latest tracked wallet activity.
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

/* Reference .summary: flex cells in one rounded white panel, dividers between. */
function SummaryStrip({ cells }: { cells: { label: string; value: string; tone?: string }[] }) {
  return (
    <div className="mb-[22px] flex flex-wrap overflow-hidden rounded-[14px] border border-line bg-surface">
      {cells.map((c) => (
        <div
          key={c.label}
          className="min-w-[220px] flex-1 border-l border-line px-[22px] py-4 first:border-l-0 max-[820px]:flex-[1_1_50%] max-[820px]:min-w-0"
        >
          <div className="mb-1.5 font-mono text-[11.5px] font-semibold uppercase tracking-[0.05em] text-muted">{c.label}</div>
          <div className={`text-[26px] font-extrabold ${c.tone ?? 'text-ink'}`}>{c.value}</div>
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

type SortKey = 'holders' | 'trackedInflow' | 'trackedHolding' | 'volume1h' | 'volume24h' | 't100' | 'lf' | 'fresh' | 'mc';
/** null = the order the table ships with (newest tracked activity first) — no column armed. */
type SortState = { key: SortKey; dir: 'asc' | 'desc' } | null;

const SORT_LABEL: Record<SortKey, string> = {
  holders: 'holder count',
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
}: {
  thresholds?: NansenThresholds | null;
  sort?: SortState;
  onSort?: (key: SortKey) => void;
}) {
  return (
    <tr>
      <Th className="w-20 px-2.5! text-center!">{null}</Th>
      <Th className="w-24">Ticker</Th>
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
      <Th className="w-36 text-center!">CA</Th>
      <Th className="w-96 text-center!">
        Tracked by
        <span className="mt-1 grid font-mono text-[10px] font-medium text-muted" style={{ gridTemplateColumns: WALLET_COLS.join(' ') }}>
          <span className="text-left">Wallet</span>
          {SHOW_CLAN && <span className="text-left">Clan</span>}
          <span className="pr-3 text-right">Bal</span>
          <span className="pr-3 text-right">TXs</span>
          <span className="pr-3 text-right">Inflow</span>
          <span className="pl-1 text-left">Age</span>
        </span>
      </Th>
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
      <Th className="w-14 text-center!">Tier</Th>
      <Th className="w-14 text-center! px-3! whitespace-normal!">Entry</Th>
    </tr>
  );
}

export default function SignalTable({ refreshKey }: { refreshKey?: number }) {
  const [signals, setSignals] = useState<TokenSignal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [walletsPopup, setWalletsPopup] = useState<TokenSignal | null>(null);
  const allFactors = useAllFactors();
  const [thresholds, setThresholds] = useState<NansenThresholds | null>(null);
  const [sort, setSort] = useState<SortState>(null);

  useEffect(() => {
    let alive = true;
    const load = (first: boolean) => {
      dataStore
        .listSignals(allFactors)
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
  }, [refreshKey, allFactors]);

  if (error) return <ErrorState message={error} onRetry={() => window.location.reload()} />;

  if (!signals) {
    return (
      <TableShell>
        <table className="table-fixed w-full min-w-[1928px] border-collapse text-left">
          <thead>
            <SignalHead />
          </thead>
          <SkeletonRows rows={8} cols={15} />
        </table>
      </TableShell>
    );
  }

  // score >= 1 is the "active signal" line counted in the strip below;
  // allFactors (debug) widens the TABLE to every tracked CA, not just passers.
  const passing = signals.filter((s) => s.nansen.score >= 1);
  const visible = allFactors ? signals : passing;

  if (visible.length === 0) {
    return <EmptyState title="No signals yet" hint="Signals will appear once the alpha engine starts streaming tokens." />;
  }

  const sortVal = (s: TokenSignal, key: SortKey): number | undefined =>
    key === 'holders'
      ? s.holders
      : key === 'trackedInflow'
        ? s.trackedInflow
        : key === 'trackedHolding'
          ? s.trackedHolding
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
                    : s.volume24h;

  const sorted = [...visible].sort((a, b) => {
    // No column armed: the order the table ships with (newest tracked activity first).
    if (!sort) return b.trackedActivityAt - a.trackedActivityAt;
    const av = sortVal(a, sort.key);
    const bv = sortVal(b, sort.key);
    // A metric with no value yet (1H volume before its first sweep) sinks in BOTH directions.
    if (av === undefined || bv === undefined) return av === bv ? 0 : av === undefined ? 1 : -1;
    return sort.dir === 'asc' ? av - bv : bv - av;
  });
  const totalVolume = visible.reduce((acc, s) => acc + s.volume24h, 0);

  /* First click arms a column (desc for these magnitudes); clicking it again flips the direction. */
  const toggleSort = (key: SortKey) =>
    setSort((prev) => (prev?.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }));

  return (
    <div className="w-full">
      <Hero count={visible.length} />
      <SummaryStrip
        cells={[
          { label: 'Tokens tracked', value: String(signals.length) },
          { label: 'Active signal', value: String(passing.length), tone: 'text-pos' },
          { label: 'Watch signal', value: String(signals.length - passing.length), tone: 'text-neg' },
          { label: '24H volume, combined', value: usd(totalVolume) },
        ]}
      />
      <div className="rounded-3xl bg-surface shadow-md">
        <div className="flex items-baseline justify-between px-6 pb-3.5 pt-5">
          <h2 className="text-[19px] font-extrabold text-ink">Token watchlist</h2>
          <span className="text-[12px] font-semibold text-muted">
            {sort ? `sorted by ${SORT_LABEL[sort.key]}, ${sort.dir === 'asc' ? 'ascending' : 'descending'}` : 'sorted by tracked activity'}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1928px] table-fixed border-collapse text-left">
            <thead>
              <SignalHead thresholds={thresholds} sort={sort} onSort={toggleSort} />
            </thead>
            <tbody className="[&>tr:last-child>td]:border-b-0">
              {sorted.map((s) => {
                const green = s.volume24h < ENTRY_VOLUME_THRESHOLD;
                return (
                  <tr key={s.id} className="odd:bg-surface even:bg-surface2 transition-colors hover:bg-hover">
                    <Td className="w-20 px-2.5! text-center!">
                      <TokenAvatar iconUrl={s.iconUrl} symbol={s.symbol} ca={s.ca} />
                    </Td>
                    <Td className="w-24">
                      <span
                        className="flex items-center gap-[2px] text-[13.5px] font-bold text-ink"
                        title={s.symbol ? `$${s.symbol.toUpperCase()}` : undefined}
                      >
                        <span aria-hidden className="text-pos">
                          $
                        </span>
                        <span className="min-w-0 truncate">{s.symbol?.toUpperCase() ?? '—'}</span>
                      </span>
                    </Td>
                    <Td className="w-24 text-center font-mono text-[13px] tabular-nums text-ink2">
                      {s.marketCap !== undefined ? usd(s.marketCap) : '—'}
                    </Td>
                    <Td className="w-24 text-center">
                      <CaCell ca={s.ca} />
                    </Td>
                    <Td className="w-96">
                      {s.trackedWallets.length === 0 ? (
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
                    <Td className={`w-24 ${NS_CELL} ${NS_START}`}>
                      <SetupValue value={s.nansen.t100?.multiple !== undefined ? fmtNum(s.nansen.t100.multiple) : '—'} pass={s.nansen.pass.t100} />
                    </Td>
                    <Td className={`w-24 ${NS_CELL}`}>
                      <SetupValue value={s.nansen.lf !== undefined ? compact(s.nansen.lf) : '—'} pass={s.nansen.pass.lf} />
                    </Td>
                    <Td className={`w-24 ${NS_CELL} ${NS_END}`}>
                      <SetupValue value={s.nansen.fresh !== undefined ? pct(s.nansen.fresh) : '—'} pass={s.nansen.pass.fresh} />
                    </Td>
                    <Td className="w-24 text-center font-mono tabular-nums text-[13px] text-ink2">{fmtInt(s.holders)}</Td>
                    <Td className="w-28">
                      <div className="text-center font-mono text-[13px] tabular-nums text-ink2">{usd(s.trackedInflow)}</div>
                    </Td>
                    <Td className="w-28">
                      <div className="text-center font-mono text-[13px] tabular-nums text-ink2">{pct(s.trackedHolding)}</div>
                    </Td>
                    <Td className="w-28">
                      <div className="text-center font-mono text-[13px] tabular-nums text-ink2">
                        {s.volume1h !== undefined ? usd(s.volume1h) : '—'}
                      </div>
                    </Td>
                    <Td className="w-28">
                      <div className="text-center font-mono text-[13px] tabular-nums text-ink2">{usd(s.volume24h)}</div>
                    </Td>
                    <Td className="w-14 text-center">
                      <TierBadge tier={s.tier} />
                    </Td>
                    <Td className="w-14 text-center">
                      <CheckSquare ok={green} title={`24H volume ${usd(s.volume24h)} · entry threshold ${usd(ENTRY_VOLUME_THRESHOLD)}`} />
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
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
    </div>
  );
}
