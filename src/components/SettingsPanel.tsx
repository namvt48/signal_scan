import { useEffect, useState, type FormEvent } from 'react';
import type { NansenThresholds, Settings } from '../types';
import { dataStore } from '../services/dataStore';
import { useAllFactors, setAllFactors as setAllFactorsFlag } from '../services/debugFlags';
import { Button, Modal, TextField } from './ui';

type ThresholdKey = keyof NansenThresholds;

interface FieldSpec {
  key: ThresholdKey;
  label: string;
  /** Inclusive lower bound; omitted = 0. */
  min?: number;
  /** Inclusive upper bound; omitted = unbounded (only percents cap at 100). */
  max?: number;
  /** Input step; omitted = "any". */
  step?: string;
  /** Render with thousands separators (these hold large whole numbers). */
  grouped?: boolean;
  /** Helper line rendered under the input. */
  hint?: string;
}

const FIELDS: FieldSpec[] = [
  { key: 'freshMinPct', label: 'Fresh wallet %', max: 100 },
  { key: 't100MinMultiple', label: 'Top-100 multiple', min: 1, step: '0.01' },
  { key: 'lfMin', label: 'Low float min', step: '1', grouped: true },
  { key: 'lfMax', label: 'Low float max', step: '1', grouped: true },
  { key: 'minUsd', label: 'Min USD' },
  { key: 'minMc', label: 'Min market cap', step: '1', grouped: true },
  { key: 'maxMc', label: 'Max market cap', min: -1, step: '1', grouped: true, hint: '-1 = no max' },
];

/** Field pairs rendered side by side inside one band box; a `hi` key is never rendered on its own. */
const BANDS: { title: string; lo: ThresholdKey; hi: ThresholdKey }[] = [
  { title: 'Low float band', lo: 'lfMin', hi: 'lfMax' },
  { title: 'Market cap band (USD)', lo: 'minMc', hi: 'maxMc' },
];

type Draft = Record<ThresholdKey, string>;

/** Thousands separators for display; "" when the draft holds no real number. */
function group(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString('en-US') : '';
}

/** Re-group after every keystroke, so typing and editing both stay readable. Keeps a leading "-" (maxMc uses -1 = no cap). */
function regroup(s: string): string {
  const sign = s.trimStart().startsWith('-') ? '-' : '';
  const digits = s.replace(/\D/g, '');
  return digits ? sign + Number(digits).toLocaleString('en-US') : '';
}

function toDraft(v: NansenThresholds): Draft {
  return {
    freshMinPct: String(v.freshMinPct),
    t100MinMultiple: String(v.t100MinMultiple),
    lfMin: group(v.lfMin),
    lfMax: group(v.lfMax),
    minUsd: String(v.minUsd),
    minMc: group(v.minMc),
    maxMc: group(v.maxMc),
  };
}

function parse(d: Draft): { ok: true; values: NansenThresholds } | { ok: false; error: string } {
  /* Grouped fields are typed with "," separators; strip them before coercing. */
  const num = (k: ThresholdKey): number => Number(d[k].replaceAll(',', ''));
  const values: NansenThresholds = {
    freshMinPct: num('freshMinPct'),
    t100MinMultiple: num('t100MinMultiple'),
    lfMin: num('lfMin'),
    lfMax: num('lfMax'),
    minUsd: num('minUsd'),
    minMc: num('minMc'),
    maxMc: num('maxMc'),
  };
  for (const f of FIELDS) {
    const n = values[f.key];
    const min = f.min ?? 0;
    if (!Number.isFinite(n)) return { ok: false, error: `${f.label} must be a valid number.` };
    if (n < min) return { ok: false, error: min === 0 ? `${f.label} must be ≥ 0.` : `${f.label} must be ≥ ${min}.` };
    if (f.max !== undefined && n > f.max) return { ok: false, error: `${f.label} must be between 0 and ${f.max}.` };
  }
  if (values.lfMin > values.lfMax) return { ok: false, error: 'Low float min must be ≤ low float max.' };
  // minMc / maxMc follow the server: 0 (minMc) or -1 (maxMc) = that edge OFF (unbounded),
  // so the band is only inverted — and worth rejecting — once BOTH edges are armed (> 0).
  if (values.minMc > 0 && values.maxMc > 0 && values.minMc > values.maxMc) {
    return { ok: false, error: 'Min market cap must be ≤ max market cap.' };
  }
  return { ok: true, values };
}

export default function SettingsPanel({ onClose, onSaved }: { onClose: () => void; onSaved?: (settings: Settings) => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const allFactors = useAllFactors();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const renderField = (spec: FieldSpec) => {
    /* Grouped fields can't be <input type="number"> — browsers reject "," in it. */
    const g = spec.grouped === true;
    return (
      <div key={spec.key}>
        <label htmlFor={`settings-${spec.key}`} className="block text-xs font-medium text-ink">
          {spec.label}
        </label>
        <TextField
          id={`settings-${spec.key}`}
          type={g ? 'text' : 'number'}
          {...(g
            ? ({ inputMode: 'numeric' } as const)
            : ({ min: spec.min ?? 0, max: spec.max, step: spec.step ?? 'any', inputMode: 'decimal' } as const))}
          value={draft?.[spec.key] ?? ''}
          onChange={(e) => {
            const raw = e.target.value;
            setDraft((prev) => (prev ? { ...prev, [spec.key]: g ? regroup(raw) : raw } : prev));
          }}
          className="mt-1.5"
        />
        {spec.hint && <p className="mt-1 text-[10px] text-muted">{spec.hint}</p>}
      </div>
    );
  };

  useEffect(() => {
    let alive = true;
    dataStore
      .getSettings()
      .then((s) => {
        if (!alive) return;
        setSettings(s);
        setDraft(toDraft(s.values));
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!draft) return;
    const parsed = parse(draft);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const next = await dataStore.updateSettings({ ...parsed.values });
      onSaved?.(next);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Signal thresholds" onClose={onClose}>
      {!draft ? (
        <p className="text-xs text-muted">{error ?? 'Loading…'}</p>
      ) : (
        <form onSubmit={(e) => void submit(e)}>
          <div className="space-y-4">
            {FIELDS.map((f) => {
              /* A band's upper edge is rendered by its lower edge's field, never on its own. */
              if (BANDS.some((b) => b.hi === f.key)) return null;
              const band = BANDS.find((b) => b.lo === f.key);
              if (!band) return renderField(f);
              return (
                <div key={band.title} className="rounded-md border border-line p-3">
                  <span className="block text-xs font-medium text-ink">{band.title}</span>
                  <div className="mt-2 grid grid-cols-2 gap-3">
                    {renderField(FIELDS.find((x) => x.key === band.lo)!)}
                    {renderField(FIELDS.find((x) => x.key === band.hi)!)}
                  </div>
                </div>
              );
            })}
            <div>
              <label htmlFor="settings-all-factors" className="flex items-center gap-2 text-xs font-medium text-ink">
                <input
                  id="settings-all-factors"
                  type="checkbox"
                  checked={allFactors}
                  onChange={(e) => setAllFactorsFlag(e.target.checked)}
                  className="h-3.5 w-3.5 accent-accent"
                />
                Show all factors (debug)
              </label>
            </div>
          </div>
          {error && <p className="mt-3 text-xs text-neg">{error}</p>}
          <div className="mt-5 flex items-center justify-between gap-2">
            <Button
              variant="ghost"
              disabled={saving}
              onClick={() => {
                if (!settings) return;
                setDraft(toDraft(settings.defaults));
                setAllFactorsFlag(false);
              }}
            >
              Reset to defaults
            </Button>
            <div className="flex gap-2">
              <Button variant="ghost" disabled={saving} onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        </form>
      )}
    </Modal>
  );
}
