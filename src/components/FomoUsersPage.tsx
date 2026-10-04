import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Download, PencilSimple, Plus, Trash, Upload } from '@phosphor-icons/react';
import type { FomoUser } from '../types';
import { dataStore, parseFomoUsersCsv, type FomoImportRow, type ParsedFomoImportRow } from '../services/dataStore';
import { Button, ConfirmDialog, CopyButton, EmptyState, ErrorState, IconButton, Modal, SkeletonRows, TableShell, Td, TextField, Th, walletNameClass } from './ui';
import { useAuth } from '../auth/use-auth';

interface Draft {
  handle: string;
  name: string;
  clan: string;
  userId: string;
  walletSolana: string;
  walletEvm: string;
}

const EMPTY_DRAFT: Draft = { handle: '', name: '', clan: '', userId: '', walletSolana: '', walletEvm: '' };

/** Export header, in column order — kept in sync with the row cells below. */
const CSV_HEADER = 'handle,name,tags,clan,userId,walletSolana,walletEvm';

function toMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function toDraft(u: FomoUser): Draft {
  return { handle: u.handle, name: u.name, clan: u.clan ?? '', userId: u.userId ?? '', walletSolana: u.walletSolana ?? '', walletEvm: u.walletEvm ?? '' };
}

/** Non-empty optionals only: most watch-list rows are handle-only. Tags are
 *  edited inline (mirrors wallets), never from this modal. */
function toPayload(d: Draft): Omit<FomoUser, 'id' | 'tags'> {
  const trim = (v: string) => v.trim();
  return {
    handle: trim(d.handle),
    name: trim(d.name),
    ...(trim(d.clan) ? { clan: trim(d.clan) } : {}),
    ...(trim(d.userId) ? { userId: trim(d.userId) } : {}),
    ...(trim(d.walletSolana) ? { walletSolana: trim(d.walletSolana) } : {}),
    ...(trim(d.walletEvm) ? { walletEvm: trim(d.walletEvm) } : {}),
  };
}

function downloadCsv(users: FomoUser[]): void {
  const esc = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  const lines = [
    CSV_HEADER,
    ...users.map((u) => [u.handle, u.name, u.tags.join(';'), u.clan ?? '', u.userId ?? '', u.walletSolana ?? '', u.walletEvm ?? ''].map(esc).join(',')),
  ];
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'signal_scan_fomo_users.csv';
  a.click();
  URL.revokeObjectURL(url);
}

/** A handle-only row: no learned/seeded userId, so alerts match on handle alone. */
function UnresolvedTag() {
  return (
    <span title="No FOMO userId — matched by handle only" className="inline-flex items-center rounded border border-warn/40 bg-watch-ink px-1.5 py-0.5 text-[11px] text-warn">
      unresolved (no userId)
    </span>
  );
}

function WalletsCell({ u }: { u: FomoUser }) {
  const items = [u.walletSolana, u.walletEvm].filter((x): x is string => Boolean(x));
  if (items.length === 0) return <span className="text-muted">-</span>;
  return (
    <div className="flex flex-col gap-0.5">
      {items.map((a) => (
        <CopyButton key={a} value={a} label={a.length > 16 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a} />
      ))}
    </div>
  );
}

function FomoUserModal({ initial, onClose, onSave }: { initial: FomoUser | null; onClose: () => void; onSave: (draft: Draft) => Promise<void> }) {
  const [draft, setDraft] = useState<Draft>(initial ? toDraft(initial) : EMPTY_DRAFT);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!draft.handle.trim()) {
      setErr('Handle is required');
      return;
    }
    setSaving(true);
    try {
      await onSave(draft);
    } catch (e2) {
      setErr(toMsg(e2));
      setSaving(false);
    }
  }

  return (
    // ponytail: zoom scales the whole popup+text 1.3×; swap to explicit sizes if a non-Chromium target appears.
    <Modal title={initial ? 'Edit FOMO user' : 'Add FOMO user'} onClose={onClose} className="[zoom:1.3]">
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">Handle</span>
          <TextField value={draft.handle} onChange={(e) => setDraft({ ...draft, handle: e.target.value })} placeholder="@handle (the alert identity)" className="font-mono" autoFocus />
        </label>
        <div className="flex gap-3">
          <label className="block flex-1">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">Name (optional)</span>
            <TextField value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="display name" className="font-mono" />
          </label>
          <label className="block w-24">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">Clan</span>
            <TextField value={draft.clan} onChange={(e) => setDraft({ ...draft, clan: e.target.value })} placeholder="a, b…" className="font-mono" />
          </label>
        </div>
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">User ID (optional)</span>
          <TextField value={draft.userId} onChange={(e) => setDraft({ ...draft, userId: e.target.value })} placeholder="FOMO userId — leave empty to match by handle only" className="font-mono" />
        </label>
        <div className="flex gap-3">
          <label className="block flex-1">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">Wallet Solana</span>
            <TextField value={draft.walletSolana} onChange={(e) => setDraft({ ...draft, walletSolana: e.target.value })} placeholder="optional" className="font-mono" />
          </label>
          <label className="block flex-1">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">Wallet EVM</span>
            <TextField value={draft.walletEvm} onChange={(e) => setDraft({ ...draft, walletEvm: e.target.value })} placeholder="optional" className="font-mono" />
          </label>
        </div>
        {err && <p className="text-xs text-neg">{err}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default function FomoUsersPage() {
  const [users, setUsers] = useState<FomoUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<'new' | FomoUser | null>(null);
  const [confirm, setConfirm] = useState<FomoUser | null>(null);
  const [preview, setPreview] = useState<ParsedFomoImportRow[] | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [tagDrafts, setTagDrafts] = useState<Record<string, string>>({});
  // FOMO watch-list writes are admin-only; the server also enforces this. Export stays open to all.
  const { role } = useAuth();
  const isAdmin = role === 'admin';

  useEffect(() => {
    let alive = true;
    dataStore
      .listFomoUsers()
      .then((us) => {
        if (alive) setUsers(us);
      })
      .catch((e: unknown) => {
        if (alive) setError(toMsg(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  async function saveFomoUser(draft: Draft) {
    if (modal === 'new') {
      const added = await dataStore.addFomoUser({ ...toPayload(draft), tags: [] });
      setUsers((us) => (us ? [...us, added].sort((a, b) => a.handle.localeCompare(b.handle, undefined, { numeric: true })) : [added]));
    } else if (modal) {
      const updated = await dataStore.updateFomoUser(modal.id, toPayload(draft));
      setUsers((us) => us?.map((u) => (u.id === updated.id ? updated : u)) ?? null);
    }
    setModal(null);
  }

  async function removeFomoUser(id: string) {
    await dataStore.deleteFomoUser(id);
    setUsers((us) => us?.filter((u) => u.id !== id) ?? null);
  }

  async function patchFomoUser(id: string, patch: Partial<Omit<FomoUser, 'id'>>) {
    const updated = await dataStore.updateFomoUser(id, patch);
    setUsers((us) => us?.map((u) => (u.id === updated.id ? updated : u)) ?? null);
  }

  async function addTag(u: FomoUser) {
    const tag = (tagDrafts[u.id] ?? '').trim();
    if (!tag || u.tags.includes(tag)) return;
    const next = { ...tagDrafts };
    delete next[u.id];
    setTagDrafts(next);
    await patchFomoUser(u.id, { tags: [...u.tags, tag] });
  }

  async function onImportFile(file: File) {
    setImportError(null);
    try {
      setPreview(parseFomoUsersCsv(await file.text()));
    } catch (e) {
      setImportError(toMsg(e));
    }
  }

  async function commitImport() {
    const rows: FomoImportRow[] = (preview ?? []).map((r) => r.data).filter((d): d is FomoImportRow => d !== undefined);
    if (rows.length === 0) return;
    await dataStore.importFomoUsers(rows);
    setPreview(null);
    setUsers(await dataStore.listFomoUsers());
  }

  if (error) return <ErrorState message={error} onRetry={() => window.location.reload()} />;

  if (!users) {
    return (
      <TableShell>
        <table className="w-full min-w-[960px] border-collapse text-left">
          <thead>
            <tr>
              <Th className="w-10">STT</Th>
              <Th className="w-[1%]">Handle</Th>
              <Th className="w-full">Name</Th>
              <Th className="min-w-[160px]">Tags</Th>
              <Th className="w-16">Clan</Th>
              <Th className="min-w-[200px]">User ID</Th>
              <Th className="min-w-[240px]">Wallets</Th>
              <Th className="w-24">Source</Th>
              <Th className="w-16 text-right">Actions</Th>
            </tr>
          </thead>
          <SkeletonRows rows={6} cols={9} />
        </table>
      </TableShell>
    );
  }

  const unresolvedCount = users.filter((u) => !u.userId).length;
  const validCount = preview?.filter((r) => r.data).length ?? 0;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-base font-semibold text-ink">
          FOMO watch list <span className="ml-1 font-mono text-xs font-normal text-muted">{users.length}</span>
          {unresolvedCount > 0 && <span className="ml-2 font-mono text-xs font-normal text-warn">· {unresolvedCount} unresolved (no userId)</span>}
        </h1>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => downloadCsv(users)}>
            <Download size={14} /> Export CSV
          </Button>
          {isAdmin && (
            <>
              <Button variant="ghost" onClick={() => fileRef.current?.click()}>
                <Upload size={14} /> Import CSV
              </Button>
              <Button onClick={() => setModal('new')}>
                <Plus size={14} /> Add FOMO user
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onImportFile(f);
                  e.target.value = '';
                }}
              />
            </>
          )}
        </div>
      </div>

      {isAdmin && preview && (
        <div className="mb-4 rounded-lg border border-line bg-surface p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-ink">Import preview</h2>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setPreview(null)}>
                Cancel
              </Button>
              <Button onClick={() => void commitImport()} disabled={validCount === 0}>
                Import {validCount} user{validCount === 1 ? '' : 's'}
              </Button>
            </div>
          </div>
          {importError && <p className="mb-2 text-xs text-neg">{importError}</p>}
          <p className="mb-3 text-xs text-ink2">
            {validCount} valid · {preview.length - validCount} will be skipped
          </p>
          <div className="max-h-60 overflow-auto rounded-md border border-line">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr>
                  <Th className="w-12">Row</Th>
                  <Th>Handle</Th>
                  <Th>Name</Th>
                  <Th>Tags</Th>
                  <Th>Clan</Th>
                  <Th>User ID</Th>
                  <Th>Wallets</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {preview.map((r) => (
                  <tr key={r.row} className="border-b border-line/60 last:border-0">
                    <Td className="font-mono">{r.row}</Td>
                    <Td className="font-mono">{r.data?.handle || '-'}</Td>
                    <Td className="font-mono">{r.data?.name || '-'}</Td>
                    <Td className="font-mono">{r.data?.tags.join('; ') || '-'}</Td>
                    <Td className="font-mono">{r.data?.clan || '-'}</Td>
                    <Td className="font-mono">{r.data?.userId || (r.data ? <UnresolvedTag /> : '-')}</Td>
                    <Td className="font-mono">{[r.data?.walletSolana, r.data?.walletEvm].filter(Boolean).join(', ') || '-'}</Td>
                    <Td>{r.data ? <span className="text-pos">ready</span> : <span className="text-neg">{r.reason}</span>}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {users.length === 0 ? (
        <EmptyState
          title="No FOMO users"
          hint="Add a FOMO trader manually or import a CSV file to start matching the alert stream."
          action={
            isAdmin ? (
              <Button onClick={() => setModal('new')}>
                <Plus size={14} /> Add FOMO user
              </Button>
            ) : undefined
          }
        />
      ) : (
        <TableShell>
          <table className="w-full min-w-[960px] border-collapse text-left">
            <thead>
              <tr>
                <Th className="w-10">STT</Th>
                <Th className="w-[1%]">Handle</Th>
                <Th className="w-full">Name</Th>
                <Th className="min-w-[160px]">Tags</Th>
                <Th className="w-16">Clan</Th>
                <Th className="min-w-[200px]">User ID</Th>
                <Th className="min-w-[240px]">Wallets</Th>
                <Th className="w-24">Source</Th>
                <Th className="w-16 text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {users.map((u, idx) => (
                <tr key={u.id} className="transition-colors hover:bg-surface2/50">
                  <Td className="text-muted">{idx + 1}</Td>
                  <Td className="whitespace-nowrap">
                    <CopyButton value={u.handle} label={u.handle} />
                  </Td>
                  <Td className="font-mono text-ink"><span className={walletNameClass(u.tags)}>{u.name || '-'}</span></Td>
                  <Td>
                    <div className="flex flex-wrap items-center gap-1">
                      {u.tags.map((t) => (
                        <span key={t} className="inline-flex items-center gap-1 rounded border border-line bg-surface2 px-1.5 py-0.5 font-mono text-[11px] text-ink2">
                          {t}
                          {isAdmin && (
                            <button type="button" aria-label={`Remove tag ${t}`} onClick={() => void patchFomoUser(u.id, { tags: u.tags.filter((x) => x !== t) })} className="text-muted transition-colors hover:text-neg">
                              ×
                            </button>
                          )}
                        </span>
                      ))}
                      {isAdmin && (
                        <>
                          <input
                            value={tagDrafts[u.id] ?? ''}
                            aria-label={`Add tag for ${u.name || u.handle}`}
                            onChange={(e) => setTagDrafts({ ...tagDrafts, [u.id]: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                void addTag(u);
                              }
                            }}
                            placeholder="add tag"
                            className="w-16 bg-transparent text-[11px] text-ink placeholder:text-muted focus:outline-none"
                          />
                          <button type="button" aria-label={`Submit tag for ${u.name || u.handle}`} onClick={() => void addTag(u)} className="text-muted transition-colors hover:text-pos">
                            <Plus size={11} />
                          </button>
                        </>
                      )}
                    </div>
                  </Td>
                  <Td className="font-mono">{u.clan || '-'}</Td>
                  <Td className="font-mono">{u.userId ? <span className="text-ink2">{u.userId}</span> : <UnresolvedTag />}</Td>
                  <Td>
                    <WalletsCell u={u} />
                  </Td>
                  <Td className="font-mono">{u.source || '-'}</Td>
                  <Td className="text-right">
                    {isAdmin && (
                      <span className="inline-flex justify-end gap-1">
                        <IconButton aria-label={`Edit ${u.handle}`} onClick={() => setModal(u)}>
                          <PencilSimple size={14} />
                        </IconButton>
                        <IconButton aria-label={`Delete ${u.handle}`} className="hover:text-neg" onClick={() => setConfirm(u)}>
                          <Trash size={14} />
                        </IconButton>
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableShell>
      )}

      {modal && <FomoUserModal initial={modal === 'new' ? null : modal} onClose={() => setModal(null)} onSave={saveFomoUser} />}
      {confirm && (
        <ConfirmDialog
          title="Delete FOMO user"
          message={`Remove ${confirm.handle} from the FOMO watch list? This cannot be undone.`}
          onConfirm={() => void removeFomoUser(confirm.id)}
          onClose={() => setConfirm(null)}
        />
      )}
    </>
  );
}
