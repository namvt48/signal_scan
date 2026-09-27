import { useState } from 'react';
import { ArrowCounterClockwise, GearSix } from '@phosphor-icons/react';
import SignalTable from './components/SignalTable';
// Token detail page DISABLED (2026-09-16) — re-enable import + state + branch below.
// import TokenDetailPage from './components/TokenDetailPage';
import WalletsPage from './components/WalletsPage';
import SettingsPanel from './components/SettingsPanel';
import { IconButton } from './components/ui';

type Tab = 'dashboard' | 'wallets';

const TABS: { id: Tab; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'wallets', label: 'Wallets' },
];

export default function App() {
  // Token detail page DISABLED — state kept out so no detail query can be triggered.
  // const [selectedToken, setSelectedToken] = useState<{ chain: string; ca: string } | null>(null);
  const [tab, setTab] = useState<Tab>('dashboard');
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Bumped on every threshold save so SignalTable refetches immediately instead
  // of waiting out its 30s poll — the server re-scores on the next /api/signals.
  const [settingsVersion, setSettingsVersion] = useState(0);
  // Remount key: "Reset view" bumps it so the table's own view state (sort, popups) returns to default without a full reload.
  const [viewVersion, setViewVersion] = useState(0);

  return (
    <div className="min-h-[100dvh] bg-canvas text-ink">
      <header className="sticky top-0 z-40 border-b border-line bg-canvas/90 backdrop-blur">
        <div className="flex h-14 w-full items-center justify-between gap-4 px-4 sm:px-6">
          <span className="flex items-center gap-3.5">
            <span
              aria-hidden
              className="flex h-[34px] w-[34px] items-center justify-center rounded-lg bg-ink font-mono text-[15px] font-extrabold leading-none text-lime"
            >
              ⌁
            </span>
            <span className="text-[15.5px] font-extrabold tracking-[-0.01em] text-ink">
              signal<span className="font-mono text-[15.5px] font-medium text-muted">_scan</span>
            </span>
          </span>
          <nav aria-label="Main" className="flex items-center self-stretch">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                aria-current={tab === t.id ? 'page' : undefined}
                className={`h-full border-b-2 px-3 text-[13px] font-semibold transition-colors ${
                  tab === t.id ? 'border-accent font-bold text-ink' : 'border-transparent text-ink2 hover:text-ink'
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div className="flex items-center gap-1">
            {tab === 'dashboard' && (
              <IconButton
                onClick={() => setViewVersion((v) => v + 1)}
                aria-label="Reset view"
                title="Reset view"
              >
                <ArrowCounterClockwise size={16} />
              </IconButton>
            )}
            <IconButton onClick={() => setSettingsOpen(true)} aria-label="Threshold settings">
              <GearSix size={16} />
            </IconButton>
          </div>
        </div>
      </header>
      <main className="w-full px-4 py-6 sm:px-6">
        {tab === 'dashboard' && <SignalTable key={viewVersion} refreshKey={settingsVersion} />}
        {tab === 'wallets' && <WalletsPage />}
      </main>
      {settingsOpen && (
        <SettingsPanel onClose={() => setSettingsOpen(false)} onSaved={() => setSettingsVersion((v) => v + 1)} />
      )}
    </div>
  );
}
