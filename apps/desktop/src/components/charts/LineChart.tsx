import { useId, useRef } from "react";
import { SaveSvgButton } from "./saveSvg";

export interface ChartPoint {
  x: number;
  y: number;
}
export interface ChartSeries {
  name: string;
  /** A CSS colour. */
  color: string;
  points: ChartPoint[];
  dashed?: boolean;
}

const W = 420;
const H = 220;
const PAD = { left: 46, right: 12, top: 12, bottom: 34 };

/** "Nice" tick values between `low` and `high`: about `count` of them, on 1, 2 or 5 times a power of ten. */
export function niceTicks(low: number, high: number, count = 5): number[] {
  if (!(high > low)) return [low];
  const rough = (high - low) / Math.max(count - 1, 1);
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * power).find((candidate) => candidate >= rough) ?? 10 * power;
  const first = Math.ceil(low / step) * step;
  const ticks: number[] = [];
  for (let value = first; value <= high + step * 1e-9; value += step) ticks.push(Number(value.toPrecision(12)));
  return ticks;
}

const format = (value: number): string => (Math.abs(value) >= 100 || Number.isInteger(value) ? String(Math.round(value)) : Math.abs(value) >= 1 ? value.toFixed(1) : value.toPrecision(2));

/**
 * A plain line chart in SVG: axes with ticks, a legend, and a text summary for anyone who cannot see it. It draws what it is
 * given and nothing else, so what a chart says is what the numbers say.
 */
export function LineChart({
  title, series, xLabel, yLabel, yRange, xRange, summary, markers, verticalLine, exportName,
}: {
  title: string;
  series: ChartSeries[];
  xLabel: string;
  yLabel: string;
  /** Fixed vertical range (for example 0 to 1); otherwise it fits the data. */
  yRange?: [number, number];
  /** Fixed horizontal range; otherwise it fits the data. */
  xRange?: [number, number];
  /** Labelled points to pick out (for example the model's own operating point on a curve). */
  markers?: { x: number; y: number; label: string; color: string }[];
  /** A vertical line at an x value (for example the cut-off), with a label. */
  verticalLine?: { x: number; label: string };
  /** A name for the picture; with it, a button saves the chart as an SVG file. */
  exportName?: string;
  /** What the chart says, in words, for screen readers and for the caption. */
  summary: string;
}) {
  const titleId = useId();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const all = series.flatMap((s) => s.points);
  if (all.length === 0) return <p className="hint" role="status">{title}: nothing to show yet.</p>;
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  const xLow = xRange ? xRange[0] : Math.min(...xs);
  const xHigh = xRange ? xRange[1] : Math.max(...xs);
  let yLow = yRange ? yRange[0] : Math.min(0, ...ys);
  let yHigh = yRange ? yRange[1] : Math.max(...ys);
  if (!(yHigh > yLow)) yHigh = yLow + 1;
  if (!yRange) yHigh += (yHigh - yLow) * 0.05;
  const sx = (x: number) => PAD.left + (xHigh > xLow ? ((x - xLow) / (xHigh - xLow)) * (W - PAD.left - PAD.right) : 0);
  const sy = (y: number) => PAD.top + (1 - (y - yLow) / (yHigh - yLow)) * (H - PAD.top - PAD.bottom);
  const xTicks = niceTicks(xLow, xHigh, 5);
  const yTicks = niceTicks(yLow, yHigh, 5);
  return (
    <figure className="m-0 flex flex-col gap-1">
      <svg ref={svgRef} role="img" aria-labelledby={titleId} viewBox={`0 0 ${W} ${H}`} className="h-auto w-full max-w-xl">
        <title id={titleId}>{`${title}. ${summary}`}</title>
        {yTicks.map((tick) => (
          <g key={`y${tick}`}>
            <line x1={PAD.left} x2={W - PAD.right} y1={sy(tick)} y2={sy(tick)} stroke="currentColor" strokeOpacity={0.12} />
            <text x={PAD.left - 6} y={sy(tick) + 3} textAnchor="end" fontSize={10} fill="currentColor">{format(tick)}</text>
          </g>
        ))}
        {xTicks.map((tick) => (
          <text key={`x${tick}`} x={sx(tick)} y={H - PAD.bottom + 14} textAnchor="middle" fontSize={10} fill="currentColor">{format(tick)}</text>
        ))}
        <line x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={H - PAD.bottom} stroke="currentColor" />
        <line x1={PAD.left} x2={W - PAD.right} y1={H - PAD.bottom} y2={H - PAD.bottom} stroke="currentColor" />
        <text x={(PAD.left + W - PAD.right) / 2} y={H - 4} textAnchor="middle" fontSize={11} fill="currentColor">{xLabel}</text>
        <text transform={`translate(11 ${(PAD.top + H - PAD.bottom) / 2}) rotate(-90)`} textAnchor="middle" fontSize={11} fill="currentColor">{yLabel}</text>
        {verticalLine && verticalLine.x >= xLow && verticalLine.x <= xHigh && (
          <g>
            <line x1={sx(verticalLine.x)} x2={sx(verticalLine.x)} y1={PAD.top} y2={H - PAD.bottom} stroke="currentColor" strokeDasharray="2 3" strokeOpacity={0.7} />
            <text x={sx(verticalLine.x) + 3} y={PAD.top + 9} fontSize={9} fill="currentColor">{verticalLine.label}</text>
          </g>
        )}
        {series.map((line) => (
          <g key={line.name}>
            <polyline
              fill="none" stroke={line.color} strokeWidth={2} strokeDasharray={line.dashed ? "5 3" : undefined}
              points={line.points.map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ")}
            />
            {line.points.length === 1 && <circle cx={sx(line.points[0].x)} cy={sy(line.points[0].y)} r={3} fill={line.color} />}
          </g>
        ))}
        {markers?.map((marker) => (
          <g key={marker.label}>
            <circle cx={sx(marker.x)} cy={sy(marker.y)} r={4.5} fill={marker.color} stroke="currentColor" />
            <title>{marker.label}</title>
          </g>
        ))}
      </svg>
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {series.filter((line) => line.points.length > 0).map((line) => (
          <span key={line.name} className="inline-flex items-center gap-1">
            <span aria-hidden="true" style={{ background: line.color }} className="inline-block h-0.5 w-4" />
            {line.name}
          </span>
        ))}
        {markers?.map((marker) => <span key={marker.label} className="inline-flex items-center gap-1"><span aria-hidden="true" style={{ background: marker.color }} className="inline-block size-2 rounded-full border border-foreground" />{marker.label}</span>)}
        {exportName && <SaveSvgButton target={svgRef} name={exportName} />}
      </figcaption>
    </figure>
  );
}
