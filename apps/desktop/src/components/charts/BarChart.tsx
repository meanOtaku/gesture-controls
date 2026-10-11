import { useId, useRef } from "react";
import { niceTicks } from "./LineChart";
import { SaveSvgButton } from "./saveSvg";

const W = 420;
const H = 220;
const PAD = { left: 46, right: 12, top: 12, bottom: 34 };

/** Bars side by side for each bin: one per series. Draws exactly the counts it is given. */
export function BarChart({
  title, bins, series, xLabel, yLabel, summary, exportName,
}: {
  title: string;
  /** The label under each group of bars (the start of a slice, say). */
  bins: string[];
  series: { name: string; color: string; values: number[] }[];
  xLabel: string;
  yLabel: string;
  summary: string;
  exportName?: string;
}) {
  const titleId = useId();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const top = Math.max(1, ...series.flatMap((s) => s.values));
  const ticks = niceTicks(0, top, 5);
  const high = Math.max(top, ticks[ticks.length - 1] ?? top);
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const group = plotW / bins.length;
  const bar = Math.max(1, (group * 0.8) / series.length);
  const sy = (v: number) => PAD.top + (1 - v / high) * plotH;
  return (
    <figure className="m-0 flex flex-col gap-1">
      <svg ref={svgRef} role="img" aria-labelledby={titleId} viewBox={`0 0 ${W} ${H}`} className="h-auto w-full max-w-xl">
        <title id={titleId}>{`${title}. ${summary}`}</title>
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={PAD.left} x2={W - PAD.right} y1={sy(tick)} y2={sy(tick)} stroke="currentColor" strokeOpacity={0.12} />
            <text x={PAD.left - 6} y={sy(tick) + 3} textAnchor="end" fontSize={10} fill="currentColor">{tick}</text>
          </g>
        ))}
        {bins.map((label, i) => (
          <g key={label}>
            {series.map((line, k) => (
              <rect key={line.name} x={PAD.left + i * group + group * 0.1 + k * bar} y={sy(line.values[i])} width={bar} height={H - PAD.bottom - sy(line.values[i])} fill={line.color} stroke="currentColor" strokeWidth={0.4}>
                <title>{`${line.name}, ${label}: ${line.values[i]}`}</title>
              </rect>
            ))}
            {(bins.length <= 12 || i % 2 === 0) && <text x={PAD.left + i * group + group / 2} y={H - PAD.bottom + 14} textAnchor="middle" fontSize={9} fill="currentColor">{label}</text>}
          </g>
        ))}
        <line x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={H - PAD.bottom} stroke="currentColor" />
        <line x1={PAD.left} x2={W - PAD.right} y1={H - PAD.bottom} y2={H - PAD.bottom} stroke="currentColor" />
        <text x={(PAD.left + W - PAD.right) / 2} y={H - 4} textAnchor="middle" fontSize={11} fill="currentColor">{xLabel}</text>
        <text transform={`translate(11 ${(PAD.top + H - PAD.bottom) / 2}) rotate(-90)`} textAnchor="middle" fontSize={11} fill="currentColor">{yLabel}</text>
      </svg>
      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        {series.map((line) => (
          <span key={line.name} className="inline-flex items-center gap-1"><span aria-hidden="true" style={{ background: line.color }} className="inline-block h-2 w-3" />{line.name}</span>
        ))}
        {exportName && <SaveSvgButton target={svgRef} name={exportName} />}
      </figcaption>
    </figure>
  );
}
