import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Download, PencilSimple, Plus, Trash, Upload } from '@phosphor-icons/react';
import { CHAINS, type Chain, type Wallet } from '../types';
import { dataStore, parseWalletsCsv, type ImportRow, type ParsedImportRow } from '../services/dataStore';
import { SHOW_CLAN } from '../config';
import { Button, ConfirmDialog, CopyButton, EmptyState, ErrorState, IconButton, Modal, Select, SkeletonRows, TableShell, Td, TextField, Th, walletNameClass } from './ui';

interface Draft {
  address: string;
  name: string;
  chain: Chain;
  source: string;
  clan: string;
}

const EMPTY_DRAFT: Draft = { address: '', name: '', chain: CHAINS[0], source: '', clan: '' };

function toMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function downloadCsv(wallets: Wallet[]): void {
  const esc = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  const lines = [
    SHOW_CLAN ? 'address,name,tags,chain,source,clan' : 'address,name,tags,chain,source',
    ...wallets.map((w) =>
      [w.address, w.name, w.tags.join(';'), w.chain, w.source, ...(SHOW_CLAN ? [w.clan ?? ''] : [])]
        .map(esc)
        .join(','),
    ),
  ];
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'signal_scan_wallets.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function WalletModal({ initial, onClose, onSave }: { initial: Wallet | null; onClose: () => void; onSave: (draft: Draft) => Promise<void> }) {
  const [draft, setDraft] = useState<Draft>(
    initial ? { address: initial.address, name: initial.name, chain: initial.chain, source: initial.source, clan: initial.clan ?? '' } : EMPTY_DRAFT,
  );
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!draft.address.trim()) {
      setErr('Address is required');
      return;
    }
    if (!draft.name.trim()) {
      setErr('Name is required');
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
    <Modal title={initial ? 'Edit wallet' : 'Add wallet'} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">Address</span>
          <TextField value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} placeholder="base58 address" className="font-mono" autoFocus />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">Name</span>
          <TextField value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="CT01" className="font-mono" />
        </label>
        {SHOW_CLAN && (
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">Clan (optional)</span>
            <TextField value={draft.clan} onChange={(e) => setDraft({ ...draft, clan: e.target.value })} placeholder="a, b, ..." className="font-mono" />
          </label>
        )}
        <div className="flex gap-3">
          <label className="block w-28">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">Chain</span>
            <Select value={draft.chain} onChange={(e) => setDraft({ ...draft, chain: e.target.value as Chain })} className="w-full font-mono uppercase">
              {CHAINS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </label>
          <label className="block flex-1">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">Source (optional)</span>
            <TextField value={draft.source} onChange={(e) => setDraft({ ...draft, source: e.target.value })} placeholder="gmgn, nansen, manual..." />
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

export default function WalletsPage() {
  const [wallets, setWallets] = useState<Wallet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<'new' | Wallet | null>(null);
  const [confirm, setConfirm] = useState<Wallet | null>(null);
  const [preview, setPreview] = useState<ParsedImportRow[] | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [tagDrafts, setTagDrafts] = useState<Record<string, string>>({});
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    dataStore
      .listWallets()
      .then((ws) => {
        if (alive) setWallets(ws);
      })
      .catch((e: unknown) => {
        if (alive) setError(toMsg(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  async function saveWallet(draft: Draft) {
    const payload = { ...draft, address: draft.address.trim(), name: draft.name.trim(), source: draft.source.trim() };
    if (modal === 'new') {
      const added = await dataStore.addWallet({ ...payload, tags: [] });
      setWallets((ws) => (ws ? [...ws, added].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })) : [added]));
    } else if (modal) {
      const updated = await dataStore.updateWallet(modal.id, payload);
      setWallets((ws) => ws?.map((w) => (w.id === updated.id ? updated : w)) ?? null);
    }
    setModal(null);
  }

  async function removeWallet(id: string) {
    await dataStore.deleteWallet(id);
    setWallets((ws) => ws?.filter((w) => w.id !== id) ?? null);
  }

  async function patchWallet(id: string, patch: Partial<Omit<Wallet, 'id'>>) {
    const updated = await dataStore.updateWallet(id, patch);
    setWallets((ws) => ws?.map((w) => (w.id === updated.id ? updated : w)) ?? null);
  }

  async function addTag(w: Wallet) {
    const tag = (tagDrafts[w.id] ?? '').trim();
    if (!tag || w.tags.includes(tag)) return;
    const next = { ...tagDrafts };
    delete next[w.id];
    setTagDrafts(next);
    await patchWallet(w.id, { tags: [...w.tags, tag] });
  }

  async function onImportFile(file: File) {
    setImportError(null);
    try {
      setPreview(parseWalletsCsv(await file.text()));
    } catch (e) {
      setImportError(toMsg(e));
    }
  }

  async function commitImport() {
    const rows: ImportRow[] = (preview ?? []).map((r) => r.data).filter((d): d is ImportRow => d !== undefined);
    if (rows.length === 0) return;
    await dataStore.importWallets(rows);
    setPreview(null);
    setWallets(await dataStore.listWallets());
  }

  if (error) return <ErrorState message={error} onRetry={() => window.location.reload()} />;

  if (!wallets) {
    return (
      <TableShell>
        <table className="w-full min-w-[860px] border-collapse text-left">
          <thead>
            <tr>
              <Th className="w-10">STT</Th>
              <Th className="w-[1%]">Address</Th>
              <Th className="w-full">Name</Th>
              {SHOW_CLAN && <Th className="w-16">Clan</Th>}
              <Th className="min-w-[220px]">Tags</Th>
              <Th className="w-16">Chain</Th>
              <Th className="w-20">Source</Th>
              <Th className="w-16 text-right">Actions</Th>
            </tr>
          </thead>
          <SkeletonRows rows={6} cols={SHOW_CLAN ? 8 : 7} />
        </table>
      </TableShell>
    );
  }

  const validCount = preview?.filter((r) => r.data).length ?? 0;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-base font-semibold text-ink">
          Tracked wallets <span className="ml-1 font-mono text-xs font-normal text-muted">{wallets.length}</span>
        </h1>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => downloadCsv(wallets)}>
            <Download size={14} /> Export CSV
          </Button>
          <Button variant="ghost" onClick={() => fileRef.current?.click()}>
            <Upload size={14} /> Import CSV
          </Button>
          <Button onClick={() => setModal('new')}>
            <Plus size={14} /> Add wallet
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
        </div>
      </div>

      {preview && (
        <div className="mb-4 rounded-lg border border-line bg-surface p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-ink">Import preview</h2>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setPreview(null)}>
                Cancel
              </Button>
              <Button onClick={() => void commitImport()} disabled={validCount === 0}>
                Import {validCount} wallet{validCount === 1 ? '' : 's'}
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
                  <Th>Address</Th>
                  <Th>Name</Th>
                  {SHOW_CLAN && <Th>Clan</Th>}
                  <Th>Tags</Th>
                  <Th>Chain</Th>
                  <Th>Source</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {preview.map((r) => (
                  <tr key={r.row} className="border-b border-line/60 last:border-0">
                    <Td className="font-mono">{r.row}</Td>
                    <Td className="font-mono break-all">{r.data ? r.data.address : '-'}</Td>
                    <Td className="font-mono"><span className={walletNameClass(r.data?.tags)}>{r.data?.name || '-'}</span></Td>
                    {SHOW_CLAN && <Td className="font-mono">{r.data?.clan || '-'}</Td>}
                    <Td className="font-mono">{r.data?.tags.join('; ') || '-'}</Td>
                    <Td className="font-mono uppercase">{r.data?.chain ?? '-'}</Td>
                    <Td className="font-mono">{r.data?.source || '-'}</Td>
                    <Td>{r.data ? <span className="text-pos">ready</span> : <span className="text-neg">{r.reason}</span>}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {wallets.length === 0 ? (
        <EmptyState
          title="No tracked wallets"
          hint="Add a wallet manually or import a CSV file to start correlating signals."
          action={
            <Button onClick={() => setModal('new')}>
              <Plus size={14} /> Add wallet
            </Button>
          }
        />
      ) : (
        <TableShell>
          <table className="w-full min-w-[860px] border-collapse text-left">
            <thead>
              <tr>
                <Th className="w-10">STT</Th>
                <Th className="w-[1%]">Address</Th>
                <Th className="w-full">Name</Th>
                {SHOW_CLAN && <Th className="w-16">Clan</Th>}
                <Th className="min-w-[220px]">Tags</Th>
                <Th className="w-16">Chain</Th>
                <Th className="w-20">Source</Th>
                <Th className="w-16 text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {wallets.map((w, idx) => (
                <tr key={w.id} className="transition-colors hover:bg-surface2/50">
                  <Td className="text-muted">{idx + 1}</Td>
                  <Td className="whitespace-nowrap">
                    <CopyButton value={w.address} label={w.address} />
                  </Td>
                  <Td className="font-mono text-ink"><span className={walletNameClass(w.tags)}>{w.name}</span></Td>
                  {SHOW_CLAN && <Td className="font-mono">{w.clan || '-'}</Td>}
                  <Td>
                    <div className="flex flex-wrap items-center gap-1">
                      {w.tags.map((t) => (
                        <span key={t} className="inline-flex items-center gap-1 rounded border border-line bg-surface2 px-1.5 py-0.5 font-mono text-[11px] text-ink2">
                          {t}
                          <button type="button" aria-label={`Remove tag ${t}`} onClick={() => void patchWallet(w.id, { tags: w.tags.filter((x) => x !== t) })} className="text-muted transition-colors hover:text-neg">
                            ×
                          </button>
                        </span>
                      ))}
                      <input
                        value={tagDrafts[w.id] ?? ''}
                        aria-label={`Add tag for ${w.name}`}
                        onChange={(e) => setTagDrafts({ ...tagDrafts, [w.id]: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void addTag(w);
                          }
                        }}
                        placeholder="add tag"
                        className="w-16 bg-transparent text-[11px] text-ink placeholder:text-muted focus:outline-none"
                      />
                      <button type="button" aria-label={`Submit tag for ${w.name}`} onClick={() => void addTag(w)} className="text-muted transition-colors hover:text-pos">
                        <Plus size={11} />
                      </button>
                    </div>
                  </Td>
                  <Td className="font-mono uppercase">{w.chain}</Td>
                  <Td className="font-mono">{w.source || '-'}</Td>
                  <Td className="text-right">
                    <span className="inline-flex justify-end gap-1">
                      <IconButton aria-label={`Edit ${w.name}`} onClick={() => setModal(w)}>
                        <PencilSimple size={14} />
                      </IconButton>
                      <IconButton aria-label={`Delete ${w.name}`} className="hover:text-neg" onClick={() => setConfirm(w)}>
                        <Trash size={14} />
                      </IconButton>
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableShell>
      )}

      {modal && <WalletModal initial={modal === 'new' ? null : modal} onClose={() => setModal(null)} onSave={saveWallet} />}
      {confirm && (
        <ConfirmDialog
          title="Delete wallet"
          message={`Remove ${confirm.name} (${confirm.address}) from tracked wallets? This cannot be undone.`}
          onConfirm={() => void removeWallet(confirm.id)}
          onClose={() => setConfirm(null)}
        />
      )}
    </>
  );
}
