import { MetricHistoryChart } from './MetricHistoryChart';

type Point = { t: number; value: number; peakBalance?: number; troughBalance?: number };

interface Props {
  ca: string;
  symbol?: string;
  multiple?: number;
  pass: boolean;
  history?: readonly Point[];
  updatedAt?: number;
}

export function T100Chart({ ca, symbol, multiple, pass, history = [], updatedAt }: Props) {
  return <MetricHistoryChart
    ca={ca}
    symbol={symbol}
    label="T100 max drawdown"
    value={multiple}
    positive={pass}
    unit="multiple"
    history={history}
    pointRadius={1.5}
    activePointRadius={3}
    expanded
    maxPoints={256}
    showDecrease
    pointDetailClassName="text-lg"
    updatedAt={updatedAt}
    emptyMessage="No successful T100 history is available yet."
    ariaLabel={`T100 max-drawdown multiple ${pass ? 'passes' : 'does not pass'}`}
  />;
}
