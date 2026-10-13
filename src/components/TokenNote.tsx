import { NotePencil } from '@phosphor-icons/react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Chain } from '../types';
import { dataStore } from '../services/dataStore';
import { useAuth } from '../auth/use-auth';

interface Props { ca: string; chain: Chain; symbol?: string; note?: string; onSaved: (note: string) => void }
type Point = { top: number; left: number; width: number; height: number; side: 'above' | 'below'; arrow: number };

export function TokenNote({ ca, chain, symbol, note = '', onSaved }: Props) {
  const { role } = useAuth();
  const isAdmin = role === 'admin';
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState(false);
  const [draft, setDraft] = useState(note);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [point, setPoint] = useState<Point>({ top: 0, left: 0, width: 2080, height: 1440, side: 'below', arrow: 1040 });
  const previewTimer = useRef<number | undefined>(undefined);
  const area = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLElement>(null);

  useEffect(() => { if (!open) setDraft(note); }, [note, open]);
  useEffect(() => {
    if (!open && !preview) return;
    const position = () => {
      const rect = button.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(2080, window.innerWidth - 24);
      const maxHeight = Math.min(1440, window.innerHeight - 24);
      const naturalHeight = popup.current?.getBoundingClientRect().height;
      const requestedHeight = Math.max(naturalHeight ?? 0, open ? 520 : 0);
      const height = Math.min(requestedHeight || maxHeight, maxHeight);
      const left = Math.max(12, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 12));
      const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - 20);
      const spaceAbove = Math.max(0, rect.top - 20);
      const side = height <= spaceBelow ? 'below' : height <= spaceAbove ? 'above' : spaceBelow >= spaceAbove ? 'below' : 'above';
      const available = side === 'below' ? spaceBelow : spaceAbove;
      const fittedHeight = Math.max(1, Math.min(height, available));
      const top = side === 'below' ? rect.bottom + 8 : rect.top - fittedHeight - 8;
      const arrow = Math.max(16, Math.min(rect.left + rect.width / 2 - left, width - 16));
      setPoint({ top, left, width, height: fittedHeight, side, arrow });
    };
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    const resizeObserver = popup.current ? new ResizeObserver(position) : null;
    if (popup.current) resizeObserver?.observe(popup.current);
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      resizeObserver?.disconnect();
    };
  }, [open, preview]);

  useEffect(() => {
    if (!open) return;
    const focus = window.setTimeout(() => area.current?.focus(), 0);
    return () => clearTimeout(focus);
  }, [open]);

  const clearPreviewTimer = () => { if (previewTimer.current !== undefined) window.clearTimeout(previewTimer.current); };
  const close = () => { clearPreviewTimer(); setOpen(false); setPreview(false); setError(''); window.requestAnimationFrame(() => button.current?.focus()); };
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

  const popStyle = {
    top: point.top,
    left: point.left,
    width: point.width,
    maxHeight: point.height,
    '--editor-min-height': `${Math.min(520, point.height)}px`,
    '--ax': `${point.arrow}px`,
  } as React.CSSProperties;

  return <>
    <button
      ref={button}
      type="button"
      aria-label={`${isAdmin ? 'Edit' : 'View'} note${symbol ? ` for ${symbol}` : ''}`}
      aria-describedby={preview && !open && note ? `note-preview-${chain}-${ca}` : undefined}
      aria-expanded={open || preview}
      title={isAdmin ? (note ? 'Edit saved note' : 'Add note') : 'View note'}
      onMouseEnter={() => { if (note && !open) { clearPreviewTimer(); setPreview(true); } }}
      onMouseLeave={() => { previewTimer.current = window.setTimeout(() => setPreview(false), 140); }}
      onFocus={() => { if (note && !open) setPreview(true); }}
      onBlur={(event) => {
        if (!event.currentTarget.parentElement?.contains(event.relatedTarget as Node | null)) setPreview(false);
      }}
      onClick={() => { clearPreviewTimer(); setPreview(false); setDraft(note); setOpen(true); }}
      className={`note-flag${note ? ' has-note' : ''}`}
    >
      {note ? (
        <span aria-hidden="true" className="note-flag-mark">
          <svg viewBox="0 0 40 40" width="40" height="40" role="img">
            <path d="M8 13.5C8 8.8 12.4 5 18 5h8c5.6 0 10 3.8 10 8.5v6c0 4.7-4.4 8.5-10 8.5h-3l-7.5 6 .7-7C11.5 25.8 8 22.5 8 18.5z" fill="#F6C92F" stroke="#171717" strokeWidth="2.6" strokeLinejoin="round" />
            <path d="M21.8 10.5l.7 9.2M22.4 23.5h.1" fill="none" stroke="#171717" strokeWidth="3" strokeLinecap="round" />
            <path d="M15.5 3.3l-1.3-2M31.3 3.8l1.3-2M36.4 9l2-1.2" fill="none" stroke="#171717" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </span>
      ) : <NotePencil size={26} weight="regular" aria-hidden="true" />}
    </button>
    {preview && !open && createPortal(<section ref={popup} id={`note-preview-${chain}-${ca}`} role="tooltip" aria-label={`Saved note${symbol ? ` for ${symbol}` : ''}`} onMouseEnter={clearPreviewTimer} onMouseLeave={() => { previewTimer.current = window.setTimeout(() => setPreview(false), 140); }} onFocus={clearPreviewTimer} className={`note-pop note-tip ${point.side}`} style={popStyle}>
      <div className="note-pop-content note-tip-content">
        <div className="note-tip-head"><b>{symbol ? `$${symbol.toUpperCase()}` : ca.slice(0, 10)}</b> · Saved note</div>
        <div className="note-tip-body">{note}</div>
        <div className="note-tip-foot">Click to edit</div>
      </div>
    </section>, document.body)}
    {open && createPortal(<>
      <button aria-label="Close note" tabIndex={-1} onClick={close} className="fixed inset-0 z-[1000] cursor-default" />
      <section ref={popup} role="dialog" aria-modal="false" aria-label={`Note${symbol ? ` for ${symbol}` : ''}`} className={`note-pop note-editor ${point.side}`} style={popStyle} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
        <div className="note-pop-content note-editor-content">
          <div className="note-ed-head">
            <span className="note-ed-ico"><NotePencil size={28} weight="bold" aria-hidden="true" /></span>
            <strong className="note-ed-title">{symbol ? `$${symbol.toUpperCase()}` : ca.slice(0, 10)} <span>· Note</span></strong>
          </div>
          <textarea ref={area} value={isAdmin ? draft : note} readOnly={!isAdmin} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} rows={3} maxLength={2000} aria-label="Token note" placeholder={isAdmin ? 'Add context for this token…' : 'No note yet'} className="note-editor-textarea" />
          {error && <p role="alert" className="note-ed-error">{error}</p>}
          <div className="note-ed-foot">
            {isAdmin
              ? <><span className="note-ed-hint" title="Shift+Enter adds a new line">Enter saves</span><span className="note-ed-count">{draft.length}/2000</span><button type="button" onClick={close} className="note-btn ghost">Cancel</button><button type="button" disabled={saving} onClick={() => void save()} className="note-btn primary">{saving ? 'Saving…' : 'Save'}</button></>
              : <span className="note-ed-hint">Read only · Only admins can edit</span>}
          </div>
        </div>
      </section>
    </>, document.body)}
  </>;
}
