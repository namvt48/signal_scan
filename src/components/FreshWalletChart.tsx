import { MAX_MARKET_CAP_OVERLAY_POINTS } from '../lib/chartHistory';
import { MetricHistoryChart } from './MetricHistoryChart';

type Point = { t: number; value: number };

interface Props {
  ca: string;
  symbol?: string;
  fresh?: number;
  pass: boolean;
  history?: Point[];
  marketCapHistory?: Point[];
  updatedAt?: number;
}

export function FreshWalletChart({ ca, symbol, fresh, pass, history = [], marketCapHistory = [], updatedAt }: Props) {
  return <MetricHistoryChart
    ca={ca}
    symbol={symbol}
    label="Fresh wallets"
    value={fresh}
    positive={pass}
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
    emptyMessage="No successful fresh-wallet history is available yet."
    ariaLabel={`Fresh wallet metric ${pass ? 'passes' : 'does not pass'}`}
  />;
}
