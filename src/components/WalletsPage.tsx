import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Download, PencilSimple, Plus, Trash, Upload } from '@phosphor-icons/react';
import { CHAINS, type Wallet, type WalletScope } from '../types';
import { dataStore, parseWalletsCsv, type ImportRow, type ParsedImportRow, type WalletWritePatch } from '../services/dataStore';
import { SHOW_CLAN, SHOW_FOMO } from '../config';
import { Button, ConfirmDialog, CopyButton, EmptyState, ErrorState, IconButton, Modal, Select, SkeletonRows, TableShell, Td, TextField, Th, walletNameClass } from './ui';
import { useAuth } from '../auth/use-auth';
import { normalizeClan } from '../lib/clan';

interface Draft {
  address: string;
  name: string;
  chain: WalletScope;
  source: string;
  clan: string;
}

type DisplayWallet = Omit<Wallet, 'chain'> & { chain: WalletScope };

function displayWallets(rows: Wallet[]): DisplayWallet[] {
  if (!SHOW_FOMO) return rows;
  const evmGroups = new Map<string, Wallet[]>();
  const solWallets: DisplayWallet[] = [];
  for (const wallet of rows) {
    if (wallet.chain === 'sol') {
      solWallets.push(wallet);
      continue;
    }
    const key = wallet.address.toLowerCase();
    evmGroups.set(key, [...(evmGroups.get(key) ?? []), wallet]);
  }
  const evm = [...evmGroups.values()].map((members) => {
    const preferred = members.find((wallet) => wallet.chain === 'base')
      ?? members.find((wallet) => wallet.chain === 'bsc')
      ?? members[0];
    if (!preferred) throw new Error('cannot display an empty EVM wallet group');
    return { ...preferred, chain: 'evm' as const };
  });
  return [...solWallets, ...evm].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

const EMPTY_DRAFT: Draft = { address: '', name: '', chain: 'sol', source: '', clan: '' };

function toMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function downloadCsv(wallets: DisplayWallet[]): void {
  const esc = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  const lines = [
    SHOW_CLAN ? 'address,name,tags,chain,source,clan' : 'address,name,tags,chain,source',
    ...wallets.map((w) =>
      [w.address, w.name, w.tags.join(';'), w.chain, w.source, ...(SHOW_CLAN ? [normalizeClan(w.clan)] : [])]
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

interface WalletModalProps {
  initial: DisplayWallet | null;
  defaultChain: WalletScope;
  onClose: () => void;
  onSave: (draft: Draft) => Promise<void>;
}

function WalletModal({ initial, defaultChain, onClose, onSave }: WalletModalProps) {
  const [draft, setDraft] = useState<Draft>(
    initial ? { address: initial.address, name: initial.name, chain: initial.chain, source: initial.source, clan: normalizeClan(initial.clan) } : { ...EMPTY_DRAFT, chain: defaultChain },
  );
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!draft.address.trim()) {
      setErr('Address is required');
      return;
    }
    if (draft.chain === 'evm' && !/^0x[0-9a-fA-F]{40}$/.test(draft.address.trim())) {
      setErr('Enter a valid EVM address (0x + 40 hex characters)');
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
          <TextField value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} placeholder="address (sol / 0x…)" className="font-mono" autoFocus />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">Name</span>
          <TextField value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="CT01" className="font-mono" />
        </label>
        {SHOW_CLAN && (
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">Clan (optional)</span>
            <TextField value={draft.clan} onChange={(e) => setDraft({ ...draft, clan: e.target.value })} placeholder="clan" className="font-mono" />
          </label>
        )}
        <div className="flex gap-3">
          <label className="block w-40">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">Network</span>
            <Select value={draft.chain} onChange={(e) => setDraft({ ...draft, chain: e.target.value as WalletScope })} className="w-full font-mono uppercase">
              {(initial
                ? [initial.chain]
                : SHOW_FOMO
                  ? [...CHAINS, 'evm'] as WalletScope[]
                  : CHAINS
              ).map((chain) => (
                <option key={chain} value={chain}>
                  {chain === 'evm' ? 'EVM (Base · BSC · Robinhood · Ethereum)' : chain}
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

interface WalletsPageProps {
  scope?: 'sol' | 'evm';
}

export default function WalletsPage({ scope }: WalletsPageProps) {
  const [wallets, setWallets] = useState<DisplayWallet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<'new' | DisplayWallet | null>(null);
  const [confirm, setConfirm] = useState<DisplayWallet | null>(null);
  const [preview, setPreview] = useState<ParsedImportRow[] | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [tagDrafts, setTagDrafts] = useState<Record<string, string>>({});
  const fileRef = useRef<HTMLInputElement>(null);
  // Wallet writes are admin-only; the server also enforces this. Export stays open to all.
  const { role } = useAuth();
  const isAdmin = role === 'admin';

  useEffect(() => {
    let alive = true;
    dataStore
      .listWallets()
      .then((ws) => {
        if (alive) setWallets(displayWallets(ws));
      })
      .catch((e: unknown) => {
        if (alive) setError(toMsg(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  async function saveWallet(draft: Draft) {
    const payload = { ...draft, address: draft.address.trim(), name: draft.name.trim(), source: draft.source.trim(), clan: normalizeClan(draft.clan) };
    if (modal === 'new') {
      await dataStore.addWallet({ ...payload, tags: [] });
    } else if (modal) {
      await dataStore.updateWallet(modal.id, payload);
    }
    setWallets(displayWallets(await dataStore.listWallets()));
    setModal(null);
  }

  async function removeWallet(id: string) {
    await dataStore.deleteWallet(id);
    setWallets(displayWallets(await dataStore.listWallets()));
  }

  async function patchWallet(id: string, patch: WalletWritePatch) {
    await dataStore.updateWallet(id, patch);
    setWallets(displayWallets(await dataStore.listWallets()));
  }


  async function addTag(w: DisplayWallet) {
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
    const rows: ImportRow[] = (preview ?? [])
      .map((r) => r.data)
      .filter((d): d is ImportRow => d !== undefined)
      .map((row) => ({ ...row, clan: normalizeClan(row.clan) }));
    if (rows.length === 0) return;
    await dataStore.importWallets(rows);
    setPreview(null);
    setWallets(displayWallets(await dataStore.listWallets()));
  }

  if (error) return <ErrorState message={error} onRetry={() => window.location.reload()} />;

  if (!wallets) {
    return (
      <TableShell>
        <table className="w-full min-w-[1120px] border-collapse text-left">
          <thead>
            <tr>
              <Th className="w-10">STT</Th>
              <Th className="w-[1%]">Address</Th>
              <Th className="w-full">Name</Th>
              <Th className="w-16 text-center">Rank</Th>
              <Th className="min-w-[140px]">Group</Th>
              {SHOW_CLAN && <Th className="w-16">Clan</Th>}
              <Th className="min-w-[220px]">Tags</Th>
              <Th className="w-16">Chain</Th>
              <Th className="w-20">Source</Th>
              <Th className="w-16 text-right">Actions</Th>
            </tr>
          </thead>
          <SkeletonRows rows={6} cols={SHOW_CLAN ? 10 : 9} />
        </table>
      </TableShell>
    );
  }

  const validCount = preview?.filter((r) => r.data).length ?? 0;
  const visibleWallets = scope === undefined ? wallets : wallets.filter((wallet) => scope === 'sol' ? wallet.chain === 'sol' : wallet.chain !== 'sol');
  const title = scope === 'sol' ? 'Solana wallet' : scope === 'evm' ? 'EVM wallet' : 'Tracked wallets';

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-base font-semibold text-ink">
          {title} <span className="ml-1 font-mono text-xs font-normal text-muted">{visibleWallets.length}</span>
        </h1>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => downloadCsv(visibleWallets)}>
            <Download size={14} /> Export CSV
          </Button>
          {isAdmin && (
            <>
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
                    {SHOW_CLAN && <Td className="font-mono">{normalizeClan(r.data?.clan) || '-'}</Td>}
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

      {visibleWallets.length === 0 ? (
        <EmptyState
          title={scope === undefined ? 'No tracked wallets' : `No ${scope === 'sol' ? 'Solana' : 'EVM'} wallets`}
          hint="Add a wallet manually or import a CSV file to start correlating signals."
          action={
            isAdmin ? (
              <Button onClick={() => setModal('new')}>
                <Plus size={14} /> Add wallet
              </Button>
            ) : undefined
          }
        />
      ) : (
        <TableShell>
          <table className="w-full min-w-[1120px] border-collapse text-left">
            <thead>
              <tr>
                <Th className="w-10">STT</Th>
                <Th className="w-[1%]">Address</Th>
                <Th className="w-full">Name</Th>
                <Th className="w-16 text-center">Rank</Th>
                <Th className="min-w-[140px]">Group</Th>
                {SHOW_CLAN && <Th className="w-16">Clan</Th>}
                <Th className="min-w-[220px]">Tags</Th>
                <Th className="w-16">Chain</Th>
                <Th className="w-20">Source</Th>
                <Th className="w-16 text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {visibleWallets.map((w, idx) => (
                <tr key={w.id} className="transition-colors hover:bg-surface2/50">
                  <Td className="text-muted">{idx + 1}</Td>
                  <Td className="whitespace-nowrap">
                    <CopyButton value={w.address} label={w.address} />
                  </Td>
                  <Td className="font-mono text-ink"><span className={walletNameClass(w.tags)}>{w.name}</span></Td>
                  <Td className="text-center font-mono">
                    {w.rank ? <span className="cohort-rank" data-rank={w.rank}>{w.rank}</span> : <span className="text-muted">—</span>}
                  </Td>
                  <Td>
                    {w.groups?.length ? (
                      <div className="flex max-w-[190px] flex-wrap gap-1">
                        {w.groups.map((group) => (
                          <span key={group} className="cohort-group" title={group} aria-label={group}>
                            {group.split('_', 1)[0]}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </Td>
                  {SHOW_CLAN && <Td className="font-mono">{normalizeClan(w.clan) || '-'}</Td>}
                  <Td>
                    <div className="flex flex-wrap items-center gap-1">
                      {w.tags.map((t) => (
                        <span key={t} className="inline-flex items-center gap-1 rounded border border-line bg-surface2 px-1.5 py-0.5 font-mono text-[11px] text-ink2">
                          {t}
                          {isAdmin && (
                            <button type="button" aria-label={`Remove tag ${t}`} onClick={() => void patchWallet(w.id, { tags: w.tags.filter((x) => x !== t) })} className="text-muted transition-colors hover:text-neg">
                              ×
                            </button>
                          )}
                        </span>
                      ))}
                      {isAdmin && (
                        <>
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
                        </>
                      )}
                    </div>
                  </Td>
                  <Td className="font-mono uppercase">{w.chain}</Td>
                  <Td className="font-mono">{w.source || '-'}</Td>
                  <Td className="text-right">
                    {isAdmin && (
                      <span className="inline-flex justify-end gap-1">
                        <IconButton aria-label={`Edit ${w.name}`} onClick={() => setModal(w)}>
                          <PencilSimple size={14} />
                        </IconButton>
                        <IconButton aria-label={`Delete ${w.name}`} className="hover:text-neg" onClick={() => setConfirm(w)}>
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

      {modal && <WalletModal initial={modal === 'new' ? null : modal} defaultChain={scope ?? 'sol'} onClose={() => setModal(null)} onSave={saveWallet} />}
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
