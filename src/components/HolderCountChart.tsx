import { MetricHistoryChart } from './MetricHistoryChart';

type Point = { t: number; value: number };

interface Props {
  ca: string;
  symbol?: string;
  holders: number;
  history?: readonly Point[];
  updatedAt?: number;
  valueClassName?: string;
}

export function HolderCountChart({ ca, symbol, holders, history = [], updatedAt, valueClassName }: Props) {
  return <MetricHistoryChart
    ca={ca}
    symbol={symbol}
    label="Holders"
    value={holders}
    unit="count"
    history={history}
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
