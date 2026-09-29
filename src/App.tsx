import { useState } from 'react';
import { ArrowCounterClockwise, GearSix, SignOut } from '@phosphor-icons/react';
import SignalTable from './components/SignalTable';
// Token detail page DISABLED (2026-09-16) — re-enable import + state + branch below.
// import TokenDetailPage from './components/TokenDetailPage';
import WalletsPage from './components/WalletsPage';
import FomoUsersPage from './components/FomoUsersPage';
import SettingsPanel from './components/SettingsPanel';
import { Button, IconButton } from './components/ui';
import { AuthProvider } from './auth/auth-context';
import { useAuth } from './auth/use-auth';
import { SHOW_FOMO } from './config';

type Tab = 'dashboard' | 'wallets' | 'rated';

const TABS: { id: Tab; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'rated', label: 'Rated' },
  { id: 'wallets', label: 'Wallets' },
];

/** Brand lockup shared by the header and the full-page auth screens. */
function BrandMark() {
  return (
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
  );
}

/** Full-page wait while Firebase restores the session — same skeleton pulse as the tables. */
function BootScreen() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-canvas px-4">
      <div className="flex flex-col items-center gap-5">
        <BrandMark />
        <div className="h-3 w-44 animate-pulse rounded bg-surface2" />
      </div>
    </div>
  );
}

function SignInScreen() {
  const { signIn, signInError, clearSignInError } = useAuth();
  const [busy, setBusy] = useState(false);

  async function handleSignIn() {
    setBusy(true);
    clearSignInError();
    try {
      await signIn();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm rounded-3xl bg-surface p-8 text-center shadow-md">
        <div className="flex justify-center">
          <BrandMark />
        </div>
        <h1 className="mt-6 text-base font-extrabold text-ink">Sign in to continue</h1>
        <p className="mt-1 text-xs text-ink2">This dashboard is restricted to authorized accounts.</p>
        <Button onClick={() => void handleSignIn()} disabled={busy} className="mt-6 h-9 w-full justify-center text-[13px]">
          {busy ? 'Signing in…' : 'Sign in with Google'}
        </Button>
        {signInError && <p className="mt-3 text-xs text-neg">{signInError}</p>}
      </div>
    </div>
  );
}

function NotAuthorizedScreen() {
  const { signOut } = useAuth();
  const [busy, setBusy] = useState(false);

  async function handleSignOut() {
    setBusy(true);
    try {
      await signOut();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm rounded-3xl bg-surface p-8 text-center shadow-md">
        <div className="flex justify-center">
          <BrandMark />
        </div>
        <h1 className="mt-6 text-base font-extrabold text-ink">Not authorized</h1>
        <p className="mt-1 text-xs text-ink2">Your account isn&apos;t authorized for this dashboard.</p>
        <Button onClick={() => void handleSignOut()} disabled={busy} className="mt-6 h-9 w-full justify-center text-[13px]">
          {busy ? 'Signing out…' : 'Sign out and switch account'}
        </Button>
      </div>
    </div>
  );
}

function DashboardShell() {
  const { user, signOut, role } = useAuth();
  // Token detail page DISABLED — state kept out so no detail query can be triggered.
  // const [selectedToken, setSelectedToken] = useState<{ chain: string; ca: string } | null>(null);
  const [tab, setTab] = useState<Tab>('dashboard');
  // Dashboard/Rated tables stay MOUNTED once visited (inactive one is display:none),
  // so switching tabs does not remount and refetch (~3s /api/signals).
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set<Tab>(['dashboard']));
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
          <BrandMark />
          <nav aria-label="Main" className="flex items-center self-stretch">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  setTab(t.id);
                  setVisited((prev) => (prev.has(t.id) ? prev : new Set(prev).add(t.id)));
                }}
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
            {(tab === 'dashboard' || tab === 'rated') && (
              <IconButton
                onClick={() => setViewVersion((v) => v + 1)}
                aria-label="Reset view"
                title="Reset view"
              >
                <ArrowCounterClockwise size={16} />
              </IconButton>
            )}
            {/* Settings writes server thresholds — admin only; the server also enforces this. */}
            {role === 'admin' && (
              <IconButton onClick={() => setSettingsOpen(true)} aria-label="Threshold settings">
                <GearSix size={16} />
              </IconButton>
            )}
            {/* Email is hidden on narrow screens to keep the tab bar from overflowing. */}
            {user?.email && (
              <span className="hidden max-w-[180px] truncate font-mono text-[11px] text-muted sm:inline" title={user.email}>
                {user.email}
              </span>
            )}
            <IconButton onClick={() => void signOut()} aria-label="Sign out" title="Sign out">
              <SignOut size={16} />
            </IconButton>
          </div>
        </div>
      </header>
      <main className="w-full px-4 py-6 sm:px-6">
        {visited.has('dashboard') && (
          <div className={tab === 'dashboard' ? undefined : 'hidden'}>
            <SignalTable
              key={viewVersion}
              refreshKey={settingsVersion}
              onTierChange={() => setSettingsVersion((v) => v + 1)}
            />
          </div>
        )}
        {visited.has('rated') && (
          <div className={tab === 'rated' ? undefined : 'hidden'}>
            <SignalTable
              key={`rated-${viewVersion}`}
              mode="rated"
              refreshKey={settingsVersion}
              onTierChange={() => setSettingsVersion((v) => v + 1)}
            />
          </div>
        )}
        {tab === 'wallets' && (
          <>
            <WalletsPage />
            {/* FOMO watch list is instance-b only: a sibling surface in the same tab,
                behind SHOW_FOMO. Flag off → nothing renders (no tab, no heading, no button). */}
            {SHOW_FOMO && (
              <div className="mt-10">
                <FomoUsersPage />
              </div>
            )}
          </>
        )}
      </main>
      {settingsOpen && (
        <SettingsPanel onClose={() => setSettingsOpen(false)} onSaved={() => setSettingsVersion((v) => v + 1)} />
      )}
    </div>
  );
}

function AppContent() {
  const { user, loading, notAuthorized } = useAuth();
  if (loading) return <BootScreen />;
  if (notAuthorized) return <NotAuthorizedScreen />;
  if (!user) return <SignInScreen />;
  return <DashboardShell />;
}

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}
