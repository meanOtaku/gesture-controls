import { useRef } from "react";
import { SaveSvgButton } from "../../../components/charts/saveSvg";
import { divergingColor, maxAbs, minMax, sequentialColor } from "../inspection";

const LABEL_WIDTH = 150;
const LEGEND = 9;

const number = (value: number): string => (Math.abs(value) >= 100 ? value.toFixed(0) : Math.abs(value) >= 1 ? value.toFixed(2) : value.toPrecision(2));

/**
 * A matrix as coloured cells: `diverging` (blue below zero, red above, white at zero) for weights and changes, `sequential`
 * (white to teal) for activations. Hover or focus a cell for its row, column and value. A caption says the range.
 */
export function Heatmap({
  title, matrix, rowLabels, colLabels, scale = "diverging", cell: cellProp, caption, exportName,
}: {
  title: string;
  matrix: number[][];
  rowLabels?: string[];
  colLabels?: string[];
  scale?: "diverging" | "sequential";
  /** Side of one cell, in pixels. By default it fits: bigger for a small matrix, smaller for a wide one. */
  cell?: number;
  caption?: string;
  /** With a name, a button saves the picture as an SVG file. */
  exportName?: string;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  if (matrix.length === 0 || matrix[0].length === 0) return <p className="hint" role="status">{title}: nothing to show.</p>;
  const rows = matrix.length;
  const cols = matrix[0].length;
  const cell = cellProp ?? Math.max(10, Math.min(30, Math.floor(420 / cols)));
  const [low, high] = minMax(matrix);
  const limit = maxAbs(matrix);
  const colour = (value: number) => (scale === "diverging" ? divergingColor(value, limit) : sequentialColor(value, Math.min(low, 0), high));
  const left = rowLabels ? LABEL_WIDTH : 0;
  const top = colLabels && cols <= 40 ? 44 : 0;
  const width = left + cols * cell;
  const height = top + rows * cell;
  const range = scale === "diverging" ? `from ${number(-limit)} to ${number(limit)} (blue is negative, red positive)` : `from ${number(Math.min(low, 0))} to ${number(high)} (darker is more)`;
  return (
    <figure className="m-0 flex flex-col gap-1">
      <div className="max-w-full overflow-auto">
        <svg ref={svgRef} role="img" aria-label={`${title}: ${rows} by ${cols}, ${range}.`} width={width} height={height + LEGEND + 4} viewBox={`0 0 ${width} ${height + LEGEND + 4}`} className="block">
          {colLabels && top > 0 && matrix[0].map((_, c) => (
            <text key={`c${c}`} transform={`translate(${left + c * cell + cell / 2} ${top - 4}) rotate(-60)`} fontSize={9} fill="currentColor">{colLabels[c]}</text>
          ))}
          {rowLabels && matrix.map((_, r) => (
            <text key={`r${r}`} x={left - 4} y={top + r * cell + cell / 2 + 3} textAnchor="end" fontSize={Math.min(10, cell - 2)} fill="currentColor">{rowLabels[r]?.slice(0, 26)}</text>
          ))}
          {matrix.map((row, r) => row.map((value, c) => (
            <rect key={`${r}-${c}`} x={left + c * cell} y={top + r * cell} width={cell} height={cell} fill={colour(value)} stroke="rgba(0,0,0,0.08)" strokeWidth={0.5}>
              <title>{`${rowLabels?.[r] ?? `row ${r + 1}`}, ${colLabels?.[c] ?? `column ${c + 1}`}: ${number(value)}`}</title>
            </rect>
          )))}
        </svg>
      </div>
      <figcaption className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">{caption ?? title} · {rows} × {cols} · {range}{exportName && <SaveSvgButton target={svgRef} name={exportName} />}</figcaption>
    </figure>
  );
}
