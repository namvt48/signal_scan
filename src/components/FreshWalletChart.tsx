import { MAX_MARKET_CAP_OVERLAY_POINTS } from '../lib/chartHistory';
import { useAllFactors } from '../services/debugFlags';
import { MetricHistoryChart } from './MetricHistoryChart';

type Point = { t: number; value: number };

interface Props {
  ca: string;
  symbol?: string;
  fresh?: number;
  pass: boolean;
  freshCurrent: boolean;
  hasFreshTimestamp: boolean;
  history?: Point[];
  marketCapHistory?: Point[];
  updatedAt?: number;
}

export function FreshWalletChart({ ca, symbol, fresh, pass, freshCurrent, hasFreshTimestamp, history = [], marketCapHistory = [], updatedAt }: Props) {
  const allFactors = useAllFactors();
  const staleLabel = freshCurrent ? undefined : hasFreshTimestamp ? 'Stale' : 'Time unknown';
  return <div className="flex flex-col items-center">
    <MetricHistoryChart
      ca={ca}
      symbol={symbol}
      label="Fresh wallets"
      value={fresh}
      positive={freshCurrent && pass}
      unit="percent"
      history={history}
      secondaryHistory={marketCapHistory}
      secondaryColor="#8b929a"
      secondaryDasharray="1 6"
      secondaryLabel="Market cap"
      secondaryMaxPoints={MAX_MARKET_CAP_OVERLAY_POINTS}
      pointRadius={1.5}
      activePointRadius={3}
      expanded
      popupWidthScale={0.85}
      pointDetailClassName="text-lg"
      updatedAt={updatedAt}
      showRefreshStatus={allFactors}
      emptyMessage="No successful fresh-wallet history is available yet."
      ariaLabel={`Fresh wallet metric ${freshCurrent ? pass ? 'passes' : 'does not pass' : 'stale'}`}
    />
    {allFactors && staleLabel && <span className="text-[9px] font-medium text-muted">{staleLabel}</span>}
  </div>;
}
