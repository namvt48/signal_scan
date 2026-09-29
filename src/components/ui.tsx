import { useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { Check, Copy, Warning, X } from '@phosphor-icons/react';
import { TIERS, type Tier } from '../types';

// --- copy to clipboard (with non-secure-context fallback) -------------------

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return (
    <button
      type="button"
      onClick={() => {
        void copyText(value).then((ok) => {
          if (!ok) return;
          setCopied(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1200);
        });
      }}
      title={label || value}
      aria-label="Copy"
      className={
        label
          ? 'inline-flex items-center gap-1.5 font-mono text-xs text-ink2 transition-colors hover:text-pos'
          : `inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] border transition-colors ${
              copied
                ? 'border-pos bg-pos text-white'
                : 'border-line bg-surface2 text-muted hover:border-ink hover:bg-ink hover:text-lime'
            }`
      }
    >
      {label ? (
        <>
          <span>{copied ? 'Copied' : label}</span>
          {copied ? <Check size={13} weight="bold" className="text-pos" /> : <Copy size={13} className="opacity-50" />}
        </>
      ) : copied ? (
        <Check size={12} weight="bold" />
      ) : (
        <Copy size={12} />
      )}
    </button>
  );
}

// --- buttons ------------------------------------------------------------------

type ButtonVariant = 'primary' | 'ghost' | 'danger';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-ink hover:opacity-90 active:scale-[0.98]',
  ghost: 'border border-line text-ink2 hover:bg-surface2 hover:text-ink active:scale-[0.98]',
  danger: 'border border-neg/40 bg-neg/10 text-neg hover:bg-neg/20 active:scale-[0.98]',
};

export function Button({ variant = 'primary', className = '', type = 'button', children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      type={type}
      {...rest}
      className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-all disabled:pointer-events-none disabled:opacity-40 ${BUTTON_VARIANTS[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function IconButton({ className = '', children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-md text-ink2 transition-colors hover:bg-surface2 hover:text-ink ${className}`}
    >
      {children}
    </button>
  );
}

// --- inputs ---------------------------------------------------------------------

export function TextField({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={`h-8 w-full rounded-md border border-line bg-surface px-2.5 text-xs text-ink placeholder:text-muted focus:border-accent focus:outline-none ${className}`}
    />
  );
}

export function Select({ className = '', children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...rest}
      className={`h-8 rounded-md border border-line bg-surface px-2 text-xs text-ink focus:border-accent focus:outline-none ${className}`}
    >
      {children}
    </select>
  );
}

// --- badges -----------------------------------------------------------------------

const TIER_STYLES: Record<string, string> = {
  'S+': 'border-pos/40 bg-good-ink text-pos',
  S: 'border-pos/40 bg-good-ink text-pos',
  'A+': 'border-warn/40 bg-watch-ink text-warn',
  A: 'border-warn/40 bg-watch-ink text-warn',
  'B+': 'border-neut/40 bg-surface2 text-neut',
  B: 'border-neut/40 bg-surface2 text-neut',
};

/** Tag → extra class applied to a wallet's display name (styles in index.css). */
const WALLET_NAME_TAG_STYLES: Record<string, string> = {
  Unicon: 'wl-name rainbow',
};

/** Extra class for a wallet name based on its tags; '' when no tag matches. First match wins. */
export function walletNameClass(tags: string[] = []): string {
  const hit = tags.find((t) => t in WALLET_NAME_TAG_STYLES);
  return hit ? WALLET_NAME_TAG_STYLES[hit] : '';
}

export function TierBadge({ tier }: { tier: string | null }) {
  if (tier === null) {
    return (
      <span className="inline-flex h-5 min-w-6 items-center justify-center rounded border border-line bg-surface px-1.5 font-mono text-xs text-muted">
        —
      </span>
    );
  }
  return (
    <span className={`inline-flex h-5 min-w-6 items-center justify-center rounded border px-1.5 font-mono text-xs ${TIER_STYLES[tier] ?? TIER_STYLES.B}`}>
      {tier}
    </span>
  );
}

/** Native tier picker used in the table's Tier column. '' = unrated (−). */
export function TierSelect({ tier, onChange, className = '' }: { tier: Tier | null; onChange: (tier: Tier | null) => void; className?: string }) {
  return (
    <select
      value={tier ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? null : (e.target.value as Tier))}
      aria-label="Tier"
      data-tier={tier ?? ''}
      className={`tier-select ${className}`}
    >
      <option value="">−</option>
      {TIERS.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
  );
}

type ChipVariant = 'default' | 'all' | 'nansen' | 'tier';

/** Toggleable filter chip; variant + tier drive the reference chrome (.filter-chip). */
export function Chip({
  on,
  onClick,
  children,
  title,
  variant = 'default',
  tier,
}: {
  on: boolean;
  onClick: () => void;
  children: ReactNode;
  title?: string;
  variant?: ChipVariant;
  tier?: Tier;
}) {
  const cls = ['filter-chip'];
  if (variant === 'all') cls.push('all');
  if (variant === 'nansen') cls.push('nansen-chip');
  cls.push(on ? 'on' : 'off');
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={on}
      data-tier={variant === 'tier' ? (tier ?? '') : undefined}
      className={cls.join(' ')}
    >
      {children}
    </button>
  );
}

export function StatusBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex h-5 items-center rounded-full border border-neut/40 bg-neut/10 px-2 font-mono text-[11px] text-neut">
      {label}
    </span>
  );
}

export function Pill({ active, children, title }: { active: boolean; children: ReactNode; title?: string }) {
  return active ? (
    <span title={title} className="inline-block rounded-full bg-lime-soft px-2.5 py-1 text-[10.5px] font-bold text-ink">
      {children}
    </span>
  ) : (
    <span title={title} className="inline-block px-2.5 py-1 text-[11px] font-bold text-muted">
      {children}
    </span>
  );
}

export function CheckSquare({ ok, title }: { ok: boolean; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex h-[19px] w-[19px] items-center justify-center rounded-[5px] text-white ${ok ? 'bg-pos' : 'bg-muted'}`}
    >
      {ok ? <Check size={11} weight="bold" /> : <X size={11} weight="bold" />}
    </span>
  );
}

// --- table shell + cells -------------------------------------------------------------

export function TableShell({ children }: { children: ReactNode }) {
  return <div className="overflow-x-auto rounded-3xl bg-surface shadow-md">{children}</div>;
}

export function Th({ className = '', children, title }: { className?: string; children: ReactNode; title?: string }) {
  return (
    <th
      title={title}
      className={`sticky top-0 z-10 whitespace-nowrap border-b-2 border-line bg-surface3 px-[14px] py-[14px] text-left text-[11px] font-semibold uppercase tracking-[0.03em] text-muted ${className}`}
    >
      {children}
    </th>
  );
}

export function Td({ className = '', children, title }: { className?: string; children: ReactNode; title?: string }) {
  return (
    <td title={title} className={`border-b border-line px-[14px] py-[14px] align-middle text-[13px] ${className}`}>
      {children}
    </td>
  );
}

/*
 * Token avatar (reference .ava-badge): the icon when the API supplied one, else the
 * symbol's first letter on the dark lime badge. A failing image flips to the badge so
 * a broken icon URL never renders a broken img. Hovering an icon pops a large preview
 * beside it: `fixed` on purpose — the table's `overflow-x-auto` ancestor would clip an
 * absolutely-positioned child (a scroll container clips both axes).
 */
export function TokenAvatar({ iconUrl, symbol }: { iconUrl?: string; symbol?: string; ca: string }) {
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState<{ x: number; y: number } | null>(null);
  const letter = symbol ? symbol.slice(0, 1).toUpperCase() : '';
  if (iconUrl && !failed) {
    // ponytail: preview size is fixed; make it a CSS var if it ever needs to be themed.
    const Z = 320;
    const GAP = 12;
    return (
      <>
        <img
          src={iconUrl}
          alt={symbol ? `${symbol} logo` : 'token logo'}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          onMouseEnter={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setZoom({
              x: Math.min(r.right + GAP, Math.max(GAP, window.innerWidth - Z - GAP)),
              y: r.top + r.height / 2,
            });
          }}
          onMouseLeave={() => setZoom(null)}
          className="mx-auto block h-14 w-14 rounded-2xl border border-line object-cover"
        />
        {zoom && (
          <img
            src={iconUrl}
            alt=""
            aria-hidden="true"
            className="pointer-events-none fixed z-50 -translate-y-1/2 rounded-2xl border border-line object-cover shadow-md"
            style={{ left: zoom.x, top: zoom.y, width: Z, height: Z }}
          />
        )}
      </>
    );
  }
  return (
    <span aria-hidden="true" className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-white/15 bg-dark text-[24px] font-extrabold text-lime">
      {letter || '-'}
    </span>
  );
}

export function SkeletonRows({ rows = 6, cols }: { rows?: number; cols: number }) {
  return (
    <tbody>
      {Array.from({ length: rows }, (_, i) => (
        <tr key={i} className="border-b border-line/60">
          {Array.from({ length: cols }, (_, j) => (
            <td key={j} className="px-3 py-3">
              <div className="h-3.5 animate-pulse rounded bg-surface2" style={{ width: `${55 + ((i * 13 + j * 29) % 40)}%` }} />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}

// --- page states ----------------------------------------------------------------------

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line bg-surface py-16 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {hint && <p className="mx-auto mt-1 max-w-sm text-xs text-muted">{hint}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-lg border border-neg/40 bg-neg/5 py-12 text-center">
      <Warning size={20} className="mx-auto text-neg" />
      <p className="mt-2 text-sm font-medium text-ink">Something went wrong</p>
      <p className="mx-auto mt-1 max-w-sm text-xs text-ink2">{message}</p>
      {onRetry && (
        <div className="mt-4 flex justify-center">
          <Button variant="ghost" onClick={onRetry}>
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}

// --- modal ------------------------------------------------------------------------------

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-md rounded-xl border border-line bg-surface p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          <IconButton onClick={onClose} aria-label="Close">
            <X size={15} />
          </IconButton>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ConfirmDialog({ title, message, confirmLabel = 'Delete', onConfirm, onClose }: { title: string; message: string; confirmLabel?: string; onConfirm: () => void; onClose: () => void }) {
  return (
    <Modal title={title} onClose={onClose}>
      <p className="text-xs text-ink2">{message}</p>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="danger"
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
