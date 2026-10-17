import { useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { fmtInt, formatTimestamp, pct, usd } from '../lib/format';
import { aggregateHistoryPoints, MAX_CHART_POINTS, type HistoryPoint } from '../lib/chartHistory';
import { CHART_POINT_HIT_RADIUS, findNearestChartPointIndex, type ChartPointPosition } from '../lib/chartPointHitTest';

type Point = HistoryPoint;
type Position = { top: number; left: number };
type ChartTooltipPosition = { top: number; left: number };
type InteractivePoint = ChartPointPosition & {
  t: number;
  value: number;
  peakBalance?: number;
  troughBalance?: number;
  sampleCount: number;
  historyIndex: number;
  series: 'primary' | 'secondary';
};

interface Props {
  ca: string;
  symbol?: string;
  label: string;
  value?: number;
  positive?: boolean;
  unit: 'percent' | 'usd' | 'multiple' | 'count';
  pointRadius?: number;
  activePointRadius?: number;
  history?: readonly Point[];
  secondaryHistory?: readonly Point[];
  secondaryLabel?: string;
  secondaryColor?: string;
  secondaryDasharray?: string;
  secondaryMaxPoints?: number;
  maxPoints?: number;
  expanded?: boolean;
  popupWidthScale?: number;
  showDecrease?: boolean;
  updatedAt?: number;
  emptyMessage: string;
  pointDetailClassName?: string;
  valueClassName?: string;
  ariaLabel: string;
}

const PLOT_LEFT = 82;
const PLOT_RIGHT = 502;
const PLOT_TOP = 22;
const PLOT_HEIGHT = 136;
const balanceFormatter = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 0 });

function formatValue(value: number, unit: Props['unit']): string {
  if (unit === 'multiple') return value.toFixed(2);
  if (unit === 'count') return fmtInt(value);
  return unit === 'percent' ? pct(value) : usd(value);
}

function formatAxis(value: number, unit: Props['unit']): string {
  if (unit === 'multiple') return value.toFixed(1);
  if (unit === 'count') return fmtInt(value);
  return unit === 'percent' ? `${value.toFixed(1)}%` : usd(value);
}

export function MetricHistoryChart({
  ca,
  symbol,
  label,
  value,
  positive,
  unit,
  pointRadius = 3,
  activePointRadius = 5,
  history = [],
  secondaryHistory = [],
  secondaryLabel,
  secondaryColor = '#168bf2',
  secondaryDasharray,
  updatedAt,
  emptyMessage,
  secondaryMaxPoints = MAX_CHART_POINTS,
  maxPoints = MAX_CHART_POINTS,
  expanded = false,
  popupWidthScale = 1,
  showDecrease = false,
  pointDetailClassName = 'text-xs',
  valueClassName,
  ariaLabel,
}: Props) {
  const [open, setOpen] = useState(false);
  const [activePoint, setActivePoint] = useState<number | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const [pointTooltipPosition, setPointTooltipPosition] = useState<ChartTooltipPosition | null>(null);
  const chartPlot = useRef<HTMLDivElement>(null);
  const pointTooltip = useRef<HTMLDivElement>(null);
  const openRef = useRef(false);
  const clickPinned = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const popupId = useId();
  const popup = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number>();
  const show = () => { clearTimeout(closeTimer.current); openRef.current = true; setOpen(true); };
  const close = () => {
    openRef.current = false;
    clickPinned.current = false;
    setOpen(false);
    setActivePoint(null);
    setPosition(null);
    setPointTooltipPosition(null);
  };
  const toggleClick = () => {
    setActivePoint(null);
    if (openRef.current && !clickPinned.current) {
      clickPinned.current = true;
      return;
    }
    if (openRef.current) {
      close();
      return;
    }
    clickPinned.current = true;
    show();
  };
  const hideSoon = () => {
    clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      if (trigger.current === document.activeElement || popup.current?.contains(document.activeElement)) return;
      close();
    }, 150);
  };
  useEffect(() => () => clearTimeout(closeTimer.current), []);

  const usable = aggregateHistoryPoints(history, maxPoints);
  const secondaryUsable = aggregateHistoryPoints(secondaryHistory, secondaryMaxPoints);
  const hasSecondary = Boolean(secondaryLabel && secondaryUsable.length);
  const plotRight = hasSecondary ? 420 : PLOT_RIGHT;
  const plotWidth = plotRight - PLOT_LEFT;
  const timestamps = hasSecondary ? [...usable, ...secondaryUsable].map((point) => point.t) : usable.map((point) => point.t);
  const minT = timestamps.length ? Math.min(...timestamps) : 0;
  const maxT = timestamps.length ? Math.max(...timestamps) : minT + 1;
  const minV = usable.length ? Math.min(...usable.map((point) => point.value)) : 0;
  const maxV = usable.length ? Math.max(...usable.map((point) => point.value)) : 0;
  const pad = Math.max((maxV - minV) * 0.12, Math.abs(maxV) * 0.03, unit === 'multiple' ? 0.01 : 1);
  const low = Math.max(unit === 'multiple' ? 1 : 0, minV - pad);
  const high = unit === 'percent' ? Math.min(100, maxV + pad) : maxV + pad;
  const span = Math.max(unit === 'multiple' ? 0.01 : 1, high - low);
  const coords = usable.map((point) => ({
    ...point,
    x: !hasSecondary && usable.length === 1
      ? (PLOT_LEFT + plotRight) / 2
      : PLOT_LEFT + ((point.t - minT) / Math.max(1, maxT - minT)) * plotWidth,
    y: PLOT_TOP + (1 - (point.value - low) / span) * PLOT_HEIGHT,
  }));
  const path = coords.map((point, index) => `${index ? 'L' : 'M'}${point.x},${point.y}`).join(' ');
  const secondaryMin = secondaryUsable.length ? Math.min(...secondaryUsable.map((point) => point.value)) : 0;
  const secondaryMax = secondaryUsable.length ? Math.max(...secondaryUsable.map((point) => point.value)) : 0;
  const secondaryPad = Math.max((secondaryMax - secondaryMin) * 0.12, Math.abs(secondaryMax) * 0.03, 1);
  const secondaryLow = Math.max(0, secondaryMin - secondaryPad);
  const secondaryHigh = secondaryMax + secondaryPad;
  const secondarySpan = Math.max(1, secondaryHigh - secondaryLow);
  const secondaryCoords = secondaryUsable.map((point) => ({
    ...point,
    x: PLOT_LEFT + ((point.t - minT) / Math.max(1, maxT - minT)) * plotWidth,
    y: PLOT_TOP + (1 - (point.value - secondaryLow) / secondarySpan) * PLOT_HEIGHT,
  }));
  const secondaryPath = secondaryCoords.map((point, index) => `${index ? 'L' : 'M'}${point.x},${point.y}`).join(' ');
  const interactionPoints: InteractivePoint[] = [
    ...coords.map((point, historyIndex) => ({ ...point, historyIndex, series: 'primary' as const })),
    ...secondaryCoords.map((point, historyIndex) => ({ ...point, historyIndex, series: 'secondary' as const })),
  ].sort((left, right) => left.t - right.t || (left.series === right.series ? 0 : left.series === 'primary' ? -1 : 1));
  const activePointData = activePoint === null ? undefined : interactionPoints[activePoint];
  const activePointLabel = activePointData?.series === 'secondary' ? secondaryLabel : label;
  const activePointUnit: Props['unit'] = activePointData?.series === 'secondary' ? 'usd' : unit;
  const activePointColor = activePointData?.series === 'secondary' ? secondaryColor : 'var(--c-pos)';
  const previousPrimaryPoint = showDecrease && activePointData?.series === 'primary' && activePointData.historyIndex > 0
    ? coords[activePointData.historyIndex - 1]
    : undefined;
  const decreaseDetail = previousPrimaryPoint && activePointData?.value !== undefined && activePointData.value < previousPrimaryPoint.value
    ? `Decrease: ${formatValue(previousPrimaryPoint.value, unit)} → ${formatValue(activePointData.value, unit)}`
    : '';
  const balanceDetail = activePointData?.series === 'primary'
    && activePointData.peakBalance != null
    && Number.isFinite(activePointData.peakBalance)
    && activePointData.troughBalance != null
    && Number.isFinite(activePointData.troughBalance)
    && activePointData.peakBalance > activePointData.troughBalance
    ? `T100 balance: ${balanceFormatter.format(activePointData.peakBalance)} → ${balanceFormatter.format(activePointData.troughBalance)}`
    : '';
  const focusPoint = (index: number) => popup.current?.querySelectorAll<SVGCircleElement>('[data-chart-point]')[index]?.focus();
  const updateActivePointFromPointer = (event: ReactPointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const index = findNearestChartPointIndex(
      interactionPoints,
      (event.clientX - bounds.left) * 520 / bounds.width,
      (event.clientY - bounds.top) * 190 / bounds.height,
    );
    if (index !== null) {
      setActivePoint(index);
    } else if (!popup.current?.querySelector('[data-chart-point]:focus')) {
      setActivePoint(null);
    }
  };

  useLayoutEffect(() => {
    const plot = chartPlot.current;
    const tooltip = pointTooltip.current;
    if (!open || !activePointData || !plot || !tooltip) {
      setPointTooltipPosition(null);
      return;
    }
    const place = () => {
      const plotBounds = plot.getBoundingClientRect();
      const tooltipBounds = tooltip.getBoundingClientRect();
      const x = (activePointData.x / 520) * plotBounds.width;
      const y = (activePointData.y / 190) * plotBounds.height;
      const maxLeft = Math.max(8, plotBounds.width - tooltipBounds.width - 8);
      const left = Math.max(8, Math.min(x - tooltipBounds.width / 2, maxLeft));
      const preferredTop = y >= tooltipBounds.height + 16 ? y - tooltipBounds.height - 8 : y + 8;
      const maxTop = Math.max(8, plotBounds.height - tooltipBounds.height - 8);
      const top = Math.max(8, Math.min(preferredTop, maxTop));
      setPointTooltipPosition((current) =>
        current?.left === left && current.top === top ? current : { left, top },
      );
    };
    place();
    const resizeObserver = new ResizeObserver(place);
    resizeObserver.observe(plot);
    resizeObserver.observe(tooltip);
    window.addEventListener('resize', place);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [open, activePointData?.x, activePointData?.y]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      const popupRect = popup.current?.getBoundingClientRect();
      if (!rect || !popupRect) return;
      const below = rect.bottom + 8;
      const above = rect.top - popupRect.height - 8;
      const maxTop = window.innerHeight - popupRect.height - 12;
      const top = below <= maxTop ? below : above >= 12 ? above : Math.max(12, Math.min(below, maxTop));
      setPosition({
        top,
        left: Math.max(12, Math.min(rect.left, window.innerWidth - popupRect.width - 12)),
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    const popupElement = popup.current;
    const resizeObserver = popupElement ? new ResizeObserver(place) : undefined;
    if (popupElement) resizeObserver?.observe(popupElement);
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !popup.current?.contains(event.target) && !trigger.current?.contains(event.target)) close();
    };
    document.addEventListener('pointerdown', outside);
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { clearTimeout(closeTimer.current); close(); }
    };
    document.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      resizeObserver?.disconnect();
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', key);
    };
  }, [expanded, open]);

  const popupWidth = expanded && popupWidthScale !== 1
    ? `min(${1500 * popupWidthScale}px, calc(${100 * popupWidthScale}vw - ${24 * popupWidthScale}px))`
    : undefined;
  const currentLabel = value != null && Number.isFinite(value) ? formatValue(value, unit) : '—';
  const colorClass = positive ? 'font-semibold text-pos' : 'font-normal text-ink2';
  return <>
    <button
      ref={trigger}
      type="button"
      onClick={toggleClick}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' && interactionPoints.length >= 2) {
          event.preventDefault();
          show();
          window.requestAnimationFrame(() => focusPoint(0));
        }
      }}
      onMouseEnter={show}
      onMouseLeave={hideSoon}
      onFocus={show}
      onBlur={hideSoon}
      aria-describedby={open ? popupId : undefined}
      aria-label={`${ariaLabel} for ${symbol || ca}: ${currentLabel}`}
      aria-expanded={open}
      className={`w-full rounded px-1 py-0.5 font-mono text-[13px] tabular-nums underline decoration-dotted underline-offset-2 focus-visible:outline-2 focus-visible:outline-accent ${colorClass} ${valueClassName ?? ''}`}
    >{currentLabel}</button>
    {open && createPortal(
      <div
        ref={popup}
        id={popupId}
        role="tooltip"
        className={`fixed z-[1000] ${expanded ? 'max-h-[min(960px,calc(100vh-24px))] w-[min(1500px,calc(100vw-24px))]' : 'max-h-[min(320px,calc(100vh-24px))] w-[min(500px,calc(100vw-24px))]'} overflow-auto rounded-lg border border-line bg-surface p-3 text-ink shadow-md`}
        style={{
          top: position?.top ?? 12,
          left: position?.left ?? 12,
          width: popupWidth,
          visibility: position ? 'visible' : 'hidden',
        }}
        onMouseEnter={show}
        onMouseLeave={hideSoon}
        onBlur={hideSoon}
      >
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <strong className="text-sm">{label}{symbol ? ` · ${symbol}` : ''}</strong>
          <span className={`text-sm ${colorClass}`}>{currentLabel}</span>
        </div>
        <p id={`${popupId}-point-detail`} role="status" aria-live="polite" className={`sr-only ${pointDetailClassName}`}>
          {activePointData && activePointLabel && <>
            <time dateTime={new Date(activePointData.t).toISOString()}>{formatTimestamp(activePointData.t)}</time>
            <span>{activePointLabel}: {formatValue(activePointData.value, activePointUnit)}{activePointData.sampleCount > 1 ? ` · average of ${activePointData.sampleCount} readings` : ''}{decreaseDetail ? ` · ${decreaseDetail}` : ''}{balanceDetail ? ` · ${balanceDetail}` : ''}</span>
          </>}
        </p>
        {usable.length >= 2 || (hasSecondary && secondaryUsable.length > 0) ? <div ref={chartPlot} className="relative w-full">
          <svg
            viewBox="0 0 520 190"
            role="img"
            aria-label={`${label}${hasSecondary ? ` and ${secondaryLabel}` : ''} history over time`}
            className="block h-auto w-full"
            onPointerMove={updateActivePointFromPointer}
            onPointerDown={updateActivePointFromPointer}
            onPointerLeave={() => {
              if (!popup.current?.querySelector('[data-chart-point]:focus')) setActivePoint(null);
            }}
          >
            <rect x="0" y="0" width="520" height="190" fill="transparent" pointerEvents="all" aria-hidden="true" />
            {[0, 0.5, 1].map((fraction) => {
              const y = PLOT_TOP + fraction * PLOT_HEIGHT;
              const axisValue = high - fraction * (high - low);
              return <g key={fraction}>
                <line x1={PLOT_LEFT} x2={plotRight} y1={y} y2={y} stroke="var(--c-line)" strokeDasharray="3 4" />
                <text x={PLOT_LEFT - 5} y={y + 4} textAnchor="end" fill={hasSecondary ? 'var(--c-pos)' : 'var(--c-muted)'} fontSize="10">{formatAxis(axisValue, unit)}</text>
                {hasSecondary && <text x={plotRight + 10} y={y + 4} textAnchor="start" fill={secondaryColor} fontSize="10">{usd(secondaryHigh - fraction * (secondaryHigh - secondaryLow))}</text>}
              </g>;
            })}
            <path d={path} fill="none" stroke="var(--c-pos)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            {hasSecondary && <path d={secondaryPath} fill="none" stroke={secondaryColor} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" strokeDasharray={secondaryDasharray} vectorEffect="non-scaling-stroke" />}
            {hasSecondary && <g aria-hidden="true">
              <line x1={PLOT_LEFT} x2={PLOT_LEFT + 14} y1="12" y2="12" stroke="var(--c-pos)" strokeWidth="2.5" />
              <text x={PLOT_LEFT + 18} y="15" fill="var(--c-pos)" fontSize="10">{label}</text>
              <line x1="397" x2="411" y1="12" y2="12" stroke={secondaryColor} strokeWidth="2.5" strokeDasharray={secondaryDasharray} strokeLinecap="round" />
              <text x="415" y="15" fill={secondaryColor} fontSize="10">{secondaryLabel}</text>
            </g>}
            {interactionPoints.map((point, index) => {
              const active = activePoint === index;
              const pointLabelText = point.series === 'secondary' ? secondaryLabel : label;
              const pointUnit = point.series === 'secondary' ? 'usd' : unit;
              const pointColor = point.series === 'secondary' ? secondaryColor : 'var(--c-pos)';
              const pointLabel = `${formatTimestamp(point.t)}; ${pointLabelText} ${formatValue(point.value, pointUnit)}${point.sampleCount > 1 ? `; average of ${point.sampleCount} readings` : ''}`;
              return <g key={`${point.series}-${point.t}-${index}`}>
                <circle
                  data-chart-point={index}
                  cx={point.x}
                  cy={point.y}
                  r={CHART_POINT_HIT_RADIUS}
                  fill="transparent"
                  pointerEvents="none"
                  role="button"
                  tabIndex={index === (activePoint ?? 0) ? 0 : -1}
                  aria-label={pointLabel}
                  aria-describedby={active ? `${popupId}-point-detail` : undefined}
                  className="focus:outline-none"
                  onFocus={() => setActivePoint(index)}
                  onBlur={() => setActivePoint((current) => current === index ? null : current)}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); focusPoint((index + 1) % interactionPoints.length); }
                    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); focusPoint((index - 1 + interactionPoints.length) % interactionPoints.length); }
                    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setActivePoint(index); }
                  }}
                ><title>{pointLabel}</title></circle>
                <circle cx={point.x} cy={point.y} r={active ? activePointRadius : pointRadius} fill={pointColor} stroke={active ? 'var(--c-ink)' : 'none'} strokeWidth="1.25" pointerEvents="none" />
              </g>;
            })}
            <text x={PLOT_LEFT} y="179" fill="var(--c-muted)" fontSize="10">{formatTimestamp(minT)}</text>
            <text x={plotRight} y="179" textAnchor="end" fill="var(--c-muted)" fontSize="10">{formatTimestamp(maxT)}</text>
          </svg>
          {activePointData && activePointLabel && <div
            ref={pointTooltip}
            role="tooltip"
            aria-hidden="true"
            className="pointer-events-none absolute z-10 flex flex-col rounded-lg border border-line bg-surface px-3 py-2 text-center font-mono text-[13.8px] text-ink shadow-md"
            style={{
              left: pointTooltipPosition?.left ?? 0,
              top: pointTooltipPosition?.top ?? 0,
              maxWidth: 'calc(100% - 16px)',
              visibility: pointTooltipPosition ? 'visible' : 'hidden',
            }}
          >
            <strong style={{ color: activePointColor }}>
              {activePointLabel}: {formatValue(activePointData.value, activePointUnit)}
            </strong>
            <time className="whitespace-nowrap text-[12.65px] text-muted">{formatTimestamp(activePointData.t)}</time>
            {decreaseDetail && <span className="max-w-full text-[13.8px] leading-tight">{decreaseDetail}</span>}
            {balanceDetail && <span className="max-w-full text-[13.8px] leading-tight">{balanceDetail}</span>}
            </div>}
        </div> : interactionPoints.length === 1 ? <div className="rounded bg-surface2 px-3 py-3 text-sm text-ink2">
          <p>Only one successful reading is available.</p>
          <p className="mt-1 font-mono">{formatTimestamp(interactionPoints[0]!.t)} · {interactionPoints[0]!.series === 'secondary' && secondaryLabel ? `${secondaryLabel}: ` : ''}{formatValue(interactionPoints[0]!.value, interactionPoints[0]!.series === 'secondary' ? 'usd' : unit)}</p>
          {interactionPoints[0]!.series === 'primary'
            && interactionPoints[0]!.peakBalance != null
            && Number.isFinite(interactionPoints[0]!.peakBalance)
            && interactionPoints[0]!.troughBalance != null
            && Number.isFinite(interactionPoints[0]!.troughBalance)
            && interactionPoints[0]!.peakBalance > interactionPoints[0]!.troughBalance
            && <p className="mt-1 font-mono">T100 balance: {balanceFormatter.format(interactionPoints[0]!.peakBalance)} → {balanceFormatter.format(interactionPoints[0]!.troughBalance)}</p>}
        </div> : <p className="rounded bg-surface2 px-3 py-3 text-sm text-ink2">{emptyMessage}</p>}
        <p className="mt-2 text-xs text-muted">{updatedAt != null && Number.isFinite(updatedAt) ? `Metric refreshed ${formatTimestamp(updatedAt)}.` : 'Refresh time unavailable.'}</p>
        <p className="mt-1 text-xs text-muted">Snapshots use existing metric updates; opening this chart makes no upstream requests.</p>
      </div>,
      document.body,
    )}
  </>;
}
