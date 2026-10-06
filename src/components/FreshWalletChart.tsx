import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { pct } from '../lib/format';

type Point = { t: number; value: number };
interface Props { ca: string; symbol?: string; fresh?: number; pass: boolean; history?: Point[]; updatedAt?: number }
type Position = { top: number; left: number };
const fmt = pct;
const fmtTime = (n: number) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(n);

export function FreshWalletChart({ ca, symbol, fresh, pass, history = [], updatedAt }: Props) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<Position>({ top: 0, left: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const popupId = useId();
  const popup = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number>();
  const show = () => { clearTimeout(closeTimer.current); setOpen(true); };
  const hideSoon = () => { clearTimeout(closeTimer.current); closeTimer.current = window.setTimeout(() => setOpen(false), 150); };
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  const usable = history.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.value)).slice().sort((a, b) => a.t - b.t);
  const minT = usable[0]?.t ?? 0;
  const maxT = usable[usable.length - 1]?.t ?? minT + 1;
  const minV = Math.min(...usable.map((p) => p.value));
  const maxV = Math.max(...usable.map((p) => p.value));
  const pad = Math.max((maxV - minV) * 0.12, Math.abs(maxV) * 0.03, 1);
  const low = Math.max(0, minV - pad);
  const high = Math.min(100, maxV + pad);
  const coords = usable.map((p) => ({ ...p, x: usable.length === 1 ? 50 : 44 + ((p.t - minT) / Math.max(1, maxT - minT)) * 420, y: 22 + (1 - (p.value - low) / (high - low)) * 136 }));
  const path = coords.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ');

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = trigger.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.min(500, window.innerWidth - 24);
      setPosition({ top: Math.max(12, Math.min(r.bottom + 8, window.innerHeight - 330)), left: Math.max(12, Math.min(r.left, window.innerWidth - width - 12)) });
    };
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    const outside = (e: PointerEvent) => { if (e.target instanceof Node && !popup.current?.contains(e.target) && !trigger.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { clearTimeout(closeTimer.current); setOpen(false); } };
    document.addEventListener('keydown', key);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); };
  }, [open]);

  const label = fresh == null || !Number.isFinite(fresh) ? '—' : fmt(fresh);
  return <>
    <button ref={trigger} type="button" onClick={() => setOpen((v) => !v)} onMouseEnter={show} onMouseLeave={hideSoon} onFocus={show} onBlur={hideSoon} aria-describedby={open ? popupId : undefined} aria-label={`Fresh wallet metric for ${symbol || ca}: ${label}; ${pass ? 'passes' : 'does not pass'}`} aria-expanded={open} className={`w-full rounded px-1 py-0.5 font-mono text-[13px] tabular-nums underline decoration-dotted underline-offset-2 focus-visible:outline-2 focus-visible:outline-accent ${pass ? 'font-semibold text-pos' : 'font-normal text-ink2'}`}>{label}</button>
    {open && createPortal(<div ref={popup} id={popupId} role="tooltip" className="fixed z-[1000] max-h-[min(320px,calc(100vh-24px))] w-[min(500px,calc(100vw-24px))] overflow-auto rounded-lg border border-line bg-surface p-3 text-ink shadow-md" style={position} onMouseEnter={show} onMouseLeave={hideSoon}>
      <div className="mb-2 flex items-baseline justify-between gap-3"><strong className="text-sm">Fresh wallets{symbol ? ` · ${symbol}` : ''}</strong><span className={`text-sm font-semibold ${pass ? 'text-pos' : 'text-ink2'}`}>{label}</span></div>
      {usable.length >= 2 ? <div className="w-full"><svg viewBox="0 0 480 190" role="img" aria-label="Fresh wallet history over time" className="block h-auto w-full">
        {[0, 0.5, 1].map((f) => { const y = 22 + f * 136; const v = high - f * (high - low); return <g key={f}><line x1="44" x2="464" y1={y} y2={y} stroke="var(--c-line)" strokeDasharray="3 4"/><text x="39" y={y + 4} textAnchor="end" fill="var(--c-muted)" fontSize="10">{fmt(v)}</text></g>; })}
        <path d={path} fill="none" stroke="var(--c-pos)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        {coords.map((p, i) => <circle key={`${p.t}-${i}`} cx={p.x} cy={p.y} r="3" fill="var(--c-pos)"><title>{`${fmtTime(p.t)}: ${fmt(p.value)}`}</title></circle>)}
        <text x="44" y="179" fill="var(--c-muted)" fontSize="10">{fmtTime(minT)}</text><text x="464" y="179" textAnchor="end" fill="var(--c-muted)" fontSize="10">{fmtTime(maxT)}</text>
      </svg><ol className="mt-2 grid max-h-20 grid-cols-2 gap-x-3 overflow-auto border-t border-line pt-2 text-xs text-ink2">{usable.map((p, i) => <li key={`${p.t}-${i}`} className="flex justify-between gap-2"><time dateTime={new Date(p.t).toISOString()}>{fmtTime(p.t)}</time><span className="font-mono">{fmt(p.value)}</span></li>)}</ol></div> : usable.length === 1 ? <div className="rounded bg-surface2 px-3 py-3 text-sm text-ink2"><p>Only one successful reading is available.</p><p className="mt-1 font-mono">{fmtTime(usable[0]!.t)} · {fmt(usable[0]!.value)}</p></div> : <p className="rounded bg-surface2 px-3 py-3 text-sm text-ink2">No successful fresh-wallet history is available yet.</p>}
      <p className="mt-2 text-xs text-muted">{updatedAt != null && Number.isFinite(updatedAt) ? `Metric refreshed ${fmtTime(updatedAt)}.` : 'Refresh time unavailable.'}</p>
      <p className="mt-1 text-xs text-muted">Snapshots accumulate from existing metric updates; this chart makes no upstream requests.</p>
    </div>, document.body)}
  </>;
}
