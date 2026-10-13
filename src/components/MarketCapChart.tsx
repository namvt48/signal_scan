import { MetricHistoryChart } from './MetricHistoryChart';

type Point = { t: number; value: number };

interface Props {
  ca: string;
  symbol?: string;
  marketCap?: number;
  history?: Point[];
}

export function MarketCapChart({ ca, symbol, marketCap, history = [] }: Props) {
  return <MetricHistoryChart
    ca={ca}
    symbol={symbol}
    label="Market cap"
    value={marketCap}
    unit="usd"
    history={history}
    updatedAt={history[history.length - 1]?.t}
    emptyMessage="No earlier market-cap history is stored. New points accumulate from normal market updates."
    ariaLabel="Market cap history"
  />;
}
