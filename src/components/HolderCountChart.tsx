import { MAX_MARKET_CAP_OVERLAY_POINTS } from '../lib/chartHistory';
import { MetricHistoryChart } from './MetricHistoryChart';

type Point = { t: number; value: number };

interface Props {
  ca: string;
  symbol?: string;
  holders: number;
  history?: readonly Point[];
  marketCapHistory?: readonly Point[];
  updatedAt?: number;
  valueClassName?: string;
}

export function HolderCountChart({
  ca,
  symbol,
  holders,
  history = [],
  marketCapHistory = [],
  updatedAt,
  valueClassName,
}: Props) {
  return <MetricHistoryChart
    ca={ca}
    symbol={symbol}
    label="Holders"
    value={holders}
    unit="count"
    history={history}
    secondaryHistory={marketCapHistory}
    secondaryColor="#8b929a"
    secondaryDasharray="1 6"
    secondaryLabel="Market cap"
    secondaryMaxPoints={MAX_MARKET_CAP_OVERLAY_POINTS}
    pointRadius={1.5}
    activePointRadius={3}
    expanded
    pointDetailClassName="text-lg"
    valueClassName={valueClassName}
    updatedAt={updatedAt}
    emptyMessage="No successful holder-count history is available yet."
    ariaLabel="Holder count history"
  />;
}
