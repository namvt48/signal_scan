import caNoteIcon from '../assets/ca-note.png';
import { NotePencil } from '@phosphor-icons/react';
import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Chain } from '../types';
import { dataStore } from '../services/dataStore';
import { useAuth } from '../auth/use-auth';

const MAX_NOTE_LENGTH = 1_300_000;
const MAX_PASTED_IMAGE_BYTES = 900_000;

function noteParts(value: string): Array<{ text: string } | { image: string }> {
  const parts: Array<{ text: string } | { image: string }> = [];
  const pattern = /!\[pasted image\]\((data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+)\)/g;
  let start = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > start) parts.push({ text: value.slice(start, index) });
    parts.push({ image: match[1] ?? '' });
    start = index + match[0].length;
  }
  if (start < value.length) parts.push({ text: value.slice(start) });
  return parts;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function noteHtml(value: string): string {
  return noteParts(value).map((part) => 'image' in part
    ? `<img data-note-image="true" contenteditable="false" src="${part.image}" alt="Pasted note attachment" class="note-attachment" title="Select and press Backspace to remove">`
    : escapeHtml(part.text).replaceAll('\n', '<br>')).join('');
}

function serializeEditor(node: Node, isRoot = false): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (!(node instanceof HTMLElement)) return '';
  if (node.tagName === 'IMG') {
    const src = node.getAttribute('src') ?? '';
    return node.dataset.noteImage === 'true' && /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(src)
      ? `![pasted image](${src})`
      : '';
  }
  if (node.tagName === 'BR') return '\n';
  const text = Array.from(node.childNodes, (child) => serializeEditor(child)).join('');
  return !isRoot && ['DIV', 'P'].includes(node.tagName) ? `${text}\n` : text;
}

function selectionAtEditorEnd(editor: HTMLElement, saved?: Range): Range {
  const selection = window.getSelection();
  if (saved && editor.contains(saved.startContainer)) return saved;
  if (selection?.rangeCount && editor.contains(selection.anchorNode)) return selection.getRangeAt(0);
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  return range;
}


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
  const [point, setPoint] = useState<Point>({ top: 0, left: 0, width: 1080, height: 520, side: 'below', arrow: 540 });
  const previewTimer = useRef<number | undefined>(undefined);
  const area = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const trailingBreakPlaceholder = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) setDraft(note);
  }, [note, open]);
  useEffect(() => {
    if (!open && !preview) return;
    const position = () => {
      const rect = button.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(1080, window.innerWidth - 24);
      const maxHeight = Math.min(520, window.innerHeight - 24);
      const naturalHeight = popup.current?.getBoundingClientRect().height;
      const requestedHeight = Math.max(naturalHeight ?? 0, open ? 360 : 0);
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
    if (!open || !area.current) return;
    trailingBreakPlaceholder.current = false;
    area.current.innerHTML = noteHtml(draft);
    const focus = window.setTimeout(() => area.current?.focus(), 0);
    return () => clearTimeout(focus);
  }, [open]);

  const syncDraft = (editor: HTMLDivElement) => {
    const serialized = serializeEditor(editor, true);
    const value = trailingBreakPlaceholder.current && serialized.endsWith('\n') ? serialized.slice(0, -1) : serialized;
    setDraft(value);
    return value;
  };

  const insertAtRange = (editor: HTMLDivElement, node: Node, saved?: Range) => {
    const range = selectionAtEditorEnd(editor, saved);
    range.deleteContents();
    range.insertNode(node);
    if (node instanceof HTMLImageElement) {
      const caret = document.createTextNode('');
      node.after(caret);
      range.setStart(caret, 0);
    } else {
      range.setStartAfter(node);
    }
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return syncDraft(editor);
  };

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    if (!isAdmin || !area.current) return;
    const editor = area.current;
    const image = Array.from(event.clipboardData.items).find((item) => item.kind === 'file' && /^image\/(png|jpeg|gif|webp)$/.test(item.type));
    if (image) {
      event.preventDefault();
      const file = image.getAsFile();
      if (!file) return;
      if (file.size > MAX_PASTED_IMAGE_BYTES) { setError('Pasted image must be 900 KB or smaller.'); return; }
      const current = serializeEditor(editor, true);
      const reader = new FileReader();
      const savedRange = window.getSelection()?.rangeCount ? window.getSelection()?.getRangeAt(0).cloneRange() : undefined;
      reader.onload = () => {
        if (typeof reader.result !== 'string') { setError('Could not read pasted image.'); return; }
        if (current.length + reader.result.length + 22 > MAX_NOTE_LENGTH) { setError('Note has reached its maximum size.'); return; }
        const img = document.createElement('img');
        img.dataset.noteImage = 'true';
        img.src = reader.result;
        img.alt = 'Pasted note attachment';
        img.title = 'Select and press Backspace to remove';
        img.className = 'note-attachment';
        img.contentEditable = 'false';
        insertAtRange(editor, img, savedRange);
        setError('');
      };
      reader.onerror = () => setError('Could not read pasted image.');
      reader.readAsDataURL(file);
      return;
    }

    const text = event.clipboardData.getData('text/plain');
    if (text || event.clipboardData.types.includes('text/html')) {
      event.preventDefault();
      if (text) insertAtRange(editor, document.createTextNode(text));
    }
  };

  const renderNote = (value: string) => noteParts(value).map((part, index) =>
    'image' in part
      ? <img key={index} src={part.image} alt="Pasted note attachment" className="note-attachment" />
      : <span key={index}>{part.text}</span>);
  const clearPreviewTimer = () => {
    if (previewTimer.current !== undefined) window.clearTimeout(previewTimer.current);
  };
  const close = () => {
    clearPreviewTimer();
    setOpen(false);
    setPreview(false);
    setError('');
    window.requestAnimationFrame(() => button.current?.focus());
  };

  const save = async () => {
    if (!isAdmin || saving) return;
    const savedNote = area.current ? syncDraft(area.current) : draft;
    if (savedNote.length > MAX_NOTE_LENGTH) { setError('Note has reached its maximum size.'); return; }
    setSaving(true); setError('');
    try { await dataStore.setNote(ca, chain, savedNote); onSaved(savedNote); setOpen(false); window.requestAnimationFrame(() => button.current?.focus()); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save note. Please try again.'); }
    finally { setSaving(false); }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
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
          <img src={caNoteIcon} width={21.6} height={21.6} alt="" />
        </span>
      ) : <NotePencil size={26} weight="regular" aria-hidden="true" />}
    </button>
    {preview && !open && createPortal(<section ref={popup} id={`note-preview-${chain}-${ca}`} role="tooltip" aria-label={`Saved note${symbol ? ` for ${symbol}` : ''}`} onMouseEnter={clearPreviewTimer} onMouseLeave={() => { previewTimer.current = window.setTimeout(() => setPreview(false), 140); }} onFocus={clearPreviewTimer} className={`note-pop note-tip ${point.side}`} style={popStyle}>
      <div className="note-pop-content note-tip-content">
        <div className="note-tip-head"><b>{symbol ? `$${symbol.toUpperCase()}` : ca.slice(0, 10)}</b> · Saved note</div>
        <div className="note-tip-body">{renderNote(note)}</div>
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
          <div
            ref={area}
            role="textbox"
            aria-multiline="true"
            aria-label="Token note"
            aria-readonly={!isAdmin}
            data-placeholder={isAdmin ? 'Add context for this token… Paste an image to attach it.' : 'No note yet'}
            contentEditable={isAdmin}
            suppressContentEditableWarning
            spellCheck
            onInput={(event) => {
              trailingBreakPlaceholder.current = (event.nativeEvent as InputEvent).inputType === 'insertLineBreak';
              const value = syncDraft(event.currentTarget);
              if (value.length <= MAX_NOTE_LENGTH) setError('');
            }}
            onPaste={onPaste}
            onKeyDown={onKeyDown}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={() => { composing.current = false; }}
            className="note-editor-textarea"
          />
          {error && <p role="alert" className="note-ed-error">{error}</p>}
          <div className="note-ed-foot">
            {isAdmin
              ? <><span className="note-ed-hint" title="Shift+Enter adds a new line">Enter saves</span><span className="note-ed-count">{draft.length}/{MAX_NOTE_LENGTH}</span><button type="button" onClick={close} className="note-btn ghost">Cancel</button><button type="button" disabled={saving} onClick={() => void save()} className="note-btn primary">{saving ? 'Saving…' : 'Save'}</button></>
              : <span className="note-ed-hint">Read only · Only admins can edit</span>}
          </div>
        </div>
      </section>
    </>, document.body)}
  </>;
}
