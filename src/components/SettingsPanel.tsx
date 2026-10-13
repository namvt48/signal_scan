import { useEffect, useState, type FormEvent } from 'react';
import type { NansenThresholds, Settings, TelegramAlertRules } from '../types';
import { dataStore } from '../services/dataStore';
import { useAllFactors, setAllFactors as setAllFactorsFlag } from '../services/debugFlags';
import { Button, Modal, TextField } from './ui';
import { SHOW_FOMO } from '../config';

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
  const [signalError, setSignalError] = useState<string | null>(null);
  const [signalSaved, setSignalSaved] = useState(false);
  const [signalSaving, setSignalSaving] = useState(false);
  const [telegramDraft, setTelegramDraft] = useState<TelegramAlertRules | null>(null);
  const [telegramError, setTelegramError] = useState<string | null>(null);
  const [telegramSaved, setTelegramSaved] = useState(false);
  const [telegramSaving, setTelegramSaving] = useState(false);

  const renderField = (spec: FieldSpec) => {
    const grouped = spec.grouped === true;
    return (
      <div key={spec.key}>
        <label htmlFor={`settings-${spec.key}`} className="block text-xs font-medium text-ink">
          {spec.label}
        </label>
        <TextField
          id={`settings-${spec.key}`}
          type={grouped ? 'text' : 'number'}
          {...(grouped
            ? ({ inputMode: 'numeric' } as const)
            : ({ min: spec.min ?? 0, max: spec.max, step: spec.step ?? 'any', inputMode: 'decimal' } as const))}
          value={draft?.[spec.key] ?? ''}
          onChange={(e) => {
            const raw = e.target.value;
            setSignalSaved(false);
            setDraft((prev) => (prev ? { ...prev, [spec.key]: grouped ? regroup(raw) : raw } : prev));
          }}
          className="mt-1.5"
        />
        {spec.hint && <p className="mt-1 text-[10px] text-muted">{spec.hint}</p>}
      </div>
    );
  };
  const renderTelegramField = (key: keyof TelegramAlertRules, label: string, min = 0, max?: number) => (
    <div key={key}>
      <label htmlFor={`telegram-${key}`} className="block text-xs font-medium text-ink">{label}</label>
      <TextField
        id={`telegram-${key}`}
        type="number"
        min={min}
        max={max}
        step="any"
        value={telegramDraft?.[key] ?? ''}
        onChange={(e) => {
          setTelegramSaved(false);
          setTelegramDraft((prev) => prev ? { ...prev, [key]: Number(e.target.value) } : prev);
        }}
        className="mt-1.5"
      />
    </div>
  );


  useEffect(() => {
    let alive = true;
    dataStore.getSettings().then((next) => {
      if (!alive) return;
      setSettings(next);
      setDraft(toDraft(next.values));
    }).catch((e: unknown) => {
      if (alive) setSignalError(e instanceof Error ? e.message : String(e));
    });
    if (!SHOW_FOMO) {
      dataStore.getTelegramAlertRules().then((rules) => {
        if (alive) setTelegramDraft(rules);
      }).catch((e: unknown) => {
        if (alive) setTelegramError(e instanceof Error ? e.message : String(e));
      });
    }
    return () => {
      alive = false;
    };
  }, []);

  async function submitSignal(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!draft) return;
    const parsed = parse(draft);
    if (!parsed.ok) {
      setSignalError(parsed.error);
      setSignalSaved(false);
      return;
    }
    setSignalSaving(true);
    setSignalError(null);
    setSignalSaved(false);
    try {
      const next = await dataStore.updateSettings({ ...parsed.values });
      setSettings(next);
      onSaved?.(next);
      setSignalSaved(true);
    } catch (err) {
      setSignalError(err instanceof Error ? err.message : String(err));
    } finally {
      setSignalSaving(false);
    }
  }

  async function submitTelegramRules(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!telegramDraft) return;
    const { minMcK, maxMcK, ...otherRules } = telegramDraft;
    if (Object.values(otherRules).some((value) => !Number.isFinite(value) || value < 0) ||
        telegramDraft.minFwPct > 100 ||
        [minMcK, maxMcK].some((value) => !Number.isFinite(value) || (value !== -1 && value < 0)) ||
        (minMcK >= 0 && maxMcK >= 0 && minMcK > maxMcK)) {
      setTelegramError('MC bounds must be -1 or ≥ 0 with Min MC ≤ Max MC; other thresholds must be non-negative and Min FW ≤ 100.');
      setTelegramSaved(false);
      return;
    }
    setTelegramSaving(true);
    setTelegramError(null);
    setTelegramSaved(false);
    try {
      const next = await dataStore.updateTelegramAlertRules(telegramDraft);
      setTelegramDraft(next);
      setTelegramSaved(true);
    } catch (err) {
      setTelegramError(err instanceof Error ? err.message : String(err));
    } finally {
      setTelegramSaving(false);
    }
  }

  return (
    <Modal
      title="Threshold settings"
      onClose={onClose}
      wide
      className="max-h-[calc(100vh-2rem)] overflow-y-auto"
    >
      <div className={`grid grid-cols-1 gap-4 ${SHOW_FOMO ? '' : 'lg:grid-cols-2'}`}>
        <section className="rounded-lg border border-line p-4" aria-labelledby="signal-thresholds-title">
          <h3 id="signal-thresholds-title" className="text-sm font-semibold text-ink">Signal thresholds</h3>
          {signalError && <p role="alert" className="mt-2 text-xs text-neg">{signalError}</p>}
          {signalSaved && <p role="status" className="mt-2 text-xs text-pos">Signal thresholds saved.</p>}
          {!draft ? (
            <p className="mt-3 text-xs text-muted">{signalError ?? 'Loading signal thresholds…'}</p>
          ) : (
            <form onSubmit={(e) => void submitSignal(e)} className="mt-3">
              <div className="space-y-4">
                {FIELDS.map((field) => {
                  if (BANDS.some((band) => band.hi === field.key)) return null;
                  const band = BANDS.find((item) => item.lo === field.key);
                  if (!band) return renderField(field);
                  return (
                    <div key={band.title} className="rounded-md border border-line p-3">
                      <span className="block text-xs font-medium text-ink">{band.title}</span>
                      <div className="mt-2 grid grid-cols-2 gap-3">
                        {renderField(FIELDS.find((item) => item.key === band.lo)!)}
                        {renderField(FIELDS.find((item) => item.key === band.hi)!)}
                      </div>
                    </div>
                  );
                })}
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
              <div className="mt-4 flex items-center justify-between gap-2">
                <Button
                  variant="ghost"
                  disabled={!settings || signalSaving}
                  onClick={() => {
                    if (!settings) return;
                    setDraft(toDraft(settings.defaults));
                    setSignalError(null);
                    setSignalSaved(false);
                    setAllFactorsFlag(false);
                  }}
                >
                  Reset to defaults
                </Button>
                <Button type="submit" disabled={signalSaving}>
                  {signalSaving ? 'Saving…' : 'Save signal thresholds'}
                </Button>
              </div>
            </form>
          )}
        </section>

        {!SHOW_FOMO && (
          <section className="rounded-lg border border-line p-4" aria-labelledby="telegram-thresholds-title">
            <h3 id="telegram-thresholds-title" className="text-sm font-semibold text-ink">Telegram alert thresholds</h3>
            <p className="mt-1 text-xs text-muted">
              Saved separately from signal thresholds. MC values are in K USD; -1 disables either bound. Tracker Buying is per-wallet BUY amount in USD; 0 disables it.
            </p>
            <p className="mt-1 text-xs text-muted">
              FW alerts require current FW &gt;= Min FW and growth &gt; FW growth; the previous FW baseline may be below Min FW.
            </p>
            {telegramError && <p role="alert" className="mt-2 text-xs text-neg">{telegramError}</p>}
            {telegramSaved && <p role="status" className="mt-2 text-xs text-pos">Telegram alert thresholds saved.</p>}
            {!telegramDraft ? (
              <p className="mt-3 text-xs text-muted">{telegramError ?? 'Loading Telegram thresholds…'}</p>
            ) : (
              <form onSubmit={(e) => void submitTelegramRules(e)} className="mt-3">
                <div className="space-y-3">
                  <div>
                    <p className="text-xs font-medium text-ink">Market cap filter · K USD</p>
                    <p className="mt-1 text-[10px] text-muted">Set either bound to -1 to disable it.</p>
                    <div className="mt-2 grid grid-cols-2 gap-3">
                      {renderTelegramField('minMcK', 'Min MC', -1)}
                      {renderTelegramField('maxMcK', 'Max MC', -1)}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    {renderTelegramField('fwGrowthPct', 'FW growth (%)')}
                    {renderTelegramField('minFwPct', 'Min FW (%)', 0, 100)}
                  </div>
                  {renderTelegramField('t100GrowthPct', 'T100 growth (%)')}
                  {renderTelegramField('trackerBuyingK', 'Tracker Buying > (K USD)')}
                </div>
                <div className="mt-4 flex justify-end">
                  <Button type="submit" disabled={telegramSaving}>
                    {telegramSaving ? 'Saving…' : 'Save Telegram thresholds'}
                  </Button>
                </div>
              </form>
            )}
          </section>
        )}
      </div>
    </Modal>
  );
}
