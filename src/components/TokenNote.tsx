import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Chain } from '../types';
import { dataStore } from '../services/dataStore';
import { useAuth } from '../auth/use-auth';

interface Props { ca: string; chain: Chain; symbol?: string; note?: string; onSaved: (note: string) => void }
type Point = { top: number; left: number; width: number };

export function TokenNote({ ca, chain, symbol, note = '', onSaved }: Props) {
  const { role } = useAuth();
  const isAdmin = role === 'admin';
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(note);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [point, setPoint] = useState<Point>({ top: 0, left: 0, width: 320 });
  const button = useRef<HTMLButtonElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);

  useEffect(() => { if (!open) setDraft(note); }, [note, open]);
  useEffect(() => {
    if (!open) return;
    const position = () => {
      const rect = button.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(340, window.innerWidth - 24);
      setPoint({ top: Math.min(rect.bottom + 8, window.innerHeight - 260), left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), width });
    };
    position();
    const focus = window.setTimeout(() => area.current?.focus(), 0);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => { clearTimeout(focus); window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); };
  }, [open]);

  const close = () => { setOpen(false); setError(''); window.requestAnimationFrame(() => button.current?.focus()); };
  const save = async () => {
    if (!isAdmin || saving) return;
    setSaving(true); setError('');
    try { await dataStore.setNote(ca, chain, draft); onSaved(draft); setOpen(false); window.requestAnimationFrame(() => button.current?.focus()); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save note. Please try again.'); }
    finally { setSaving(false); }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (isAdmin && event.key === 'Enter' && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing) { event.preventDefault(); void save(); }
  };

  return <>
    <button ref={button} type="button" aria-label={`${isAdmin ? 'Edit' : 'View'} note${symbol ? ` for ${symbol}` : ''}`} aria-expanded={open} title={isAdmin ? (note ? 'Edit saved note' : 'Add note') : 'View note'} onClick={() => { setDraft(note); setOpen(true); }} className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-line focus-visible:outline-2 focus-visible:outline-accent ${note ? 'bg-lime-soft text-pos' : 'bg-surface text-muted hover:bg-hover'}`} style={{ fontSize: 13 }}>✎</button>
    {open && createPortal(<>
      <button aria-label="Close note" tabIndex={-1} onClick={close} className="fixed inset-0 z-[1000] cursor-default" />
      <section role="dialog" aria-modal="false" aria-label={`Note${symbol ? ` for ${symbol}` : ''}`} className="fixed z-[1001] rounded-lg border border-line bg-surface p-3 text-ink shadow-md" style={{ top: Math.max(12, point.top), left: point.left, width: point.width }} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
        <div className="mb-2 flex items-center justify-between"><strong className="text-sm">{symbol ? `$${symbol.toUpperCase()}` : ca.slice(0, 10)} · Note</strong><button type="button" onClick={close} aria-label="Cancel" className="rounded px-2 py-1 text-muted hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent">×</button></div>
        <textarea ref={area} value={isAdmin ? draft : note} readOnly={!isAdmin} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} rows={4} maxLength={2000} aria-label="Token note" placeholder={isAdmin ? 'Add context for this token…' : 'No note yet'} className="w-full resize-y rounded border border-line bg-surface px-2 py-2 text-sm text-ink placeholder:text-muted focus:border-accent focus:outline-none" />
        {error && <p role="alert" className="mt-2 text-sm text-neg">{error}</p>}
        {isAdmin ? <div className="mt-2 flex items-center justify-between gap-2"><span className="text-[10px] text-muted">Enter to save · Esc to cancel<br />Shift+Enter for a new line</span><button type="button" disabled={saving} onClick={() => void save()} className="rounded-full bg-pos px-3 py-1.5 text-sm font-semibold text-surface disabled:opacity-60">{saving ? 'Saving…' : 'Save'}</button></div> : <p className="mt-2 text-[10px] text-muted">Read only · Only admins can edit</p>}
      </section>
    </>, document.body)}
  </>;
}
