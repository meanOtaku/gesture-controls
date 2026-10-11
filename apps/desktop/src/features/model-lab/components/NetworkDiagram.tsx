import { ACTIVATIONS, POOLINGS, type NetworkSettings } from "../network";
import type { TrainMethod } from "../training";

interface Column {
  title: string;
  detail: string;
  kind: "neurons" | "block";
  /** How many neurons the column really has (drawn: at most `SHOWN`). */
  size: number;
}

const SHOWN = 7;
const W = 640;
const H = 210;
const activationLabel = (value: string) => ACTIVATIONS.find((a) => a.value === value)?.label ?? value;

/** The columns of the network, left to right, for drawing and for describing it in words. */
export function networkColumns(settings: NetworkSettings, inputs: number, method: TrainMethod, steps: number): Column[] {
  const columns: Column[] = [];
  if (method === "cnn1d") {
    columns.push({ title: "Window", detail: `${inputs} channel${inputs === 1 ? "" : "s"} × ${steps} steps`, kind: "block", size: inputs });
    for (const layer of settings.conv) columns.push({ title: `Conv ${layer.filters} × ${layer.kernel}`, detail: activationLabel(layer.activation), kind: "block", size: layer.filters });
    const pooled = settings.conv[settings.conv.length - 1]?.filters ?? inputs;
    columns.push({ title: "Pooling", detail: POOLINGS.find((p) => p.value === settings.pooling)?.label ?? settings.pooling, kind: "block", size: pooled * (settings.pooling === "mean_max" ? 2 : 1) });
  } else {
    columns.push({ title: "Inputs", detail: `${inputs}`, kind: "neurons", size: inputs });
  }
  for (const layer of settings.hidden) columns.push({ title: `${layer.units}`, detail: activationLabel(layer.activation), kind: "neurons", size: layer.units });
  columns.push({ title: "Output", detail: "2 probabilities", kind: "neurons", size: 2 });
  return columns;
}

/** A picture of the network: neurons as dots, convolution and pooling as blocks. Drawn from the settings alone. */
export function NetworkDiagram({ settings, inputs, method, steps }: { settings: NetworkSettings; inputs: number; method: TrainMethod; steps: number }) {
  const columns = networkColumns(settings, inputs, method, steps);
  const x = (index: number) => 50 + (index * (W - 100)) / Math.max(columns.length - 1, 1);
  const dots = (column: Column, index: number) => {
    const shown = Math.min(column.size, SHOWN);
    return Array.from({ length: shown }, (_, k) => ({ x: x(index), y: 30 + (H - 90) / 2 + (k - (shown - 1) / 2) * 20 }));
  };
  const description = columns.map((c) => `${c.title} (${c.detail})`).join(", then ");
  return (
    <svg role="img" aria-label={`The network, left to right: ${description}.`} viewBox={`0 0 ${W} ${H}`} className="h-auto w-full max-w-3xl">
      {columns.slice(0, -1).map((column, index) => {
        const next = columns[index + 1];
        if (column.kind !== "neurons" || next.kind !== "neurons") {
          // A block joins its neighbour with a single arrow.
          return <line key={`a${index}`} x1={x(index) + 24} x2={x(index + 1) - 24} y1={(H - 60) / 2 + 30} y2={(H - 60) / 2 + 30} stroke="currentColor" strokeOpacity={0.5} markerEnd="" />;
        }
        return dots(column, index).flatMap((from, i) => dots(next, index + 1).map((to, j) => (
          <line key={`l${index}-${i}-${j}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="currentColor" strokeOpacity={0.12} />
        )));
      })}
      {columns.map((column, index) => (
        <g key={`c${index}`}>
          {column.kind === "block" ? (
            <rect x={x(index) - 24} y={(H - 60) / 2 + 6} width={48} height={48} rx={6} fill="#ffd23f" stroke="currentColor" />
          ) : (
            dots(column, index).map((point, k) => <circle key={k} cx={point.x} cy={point.y} r={7} fill={index === columns.length - 1 ? "#ff6f91" : "#ffd23f"} stroke="currentColor" />)
          )}
          {column.kind === "neurons" && column.size > SHOWN && <text x={x(index)} y={30 + (H - 90) / 2 + (SHOWN / 2) * 20 + 6} textAnchor="middle" fontSize={10} fill="currentColor">⋮ {column.size}</text>}
          <text x={x(index)} y={H - 26} textAnchor="middle" fontSize={11} fontWeight={600} fill="currentColor">{column.title}</text>
          <text x={x(index)} y={H - 12} textAnchor="middle" fontSize={10} fill="currentColor">{column.detail}</text>
        </g>
      ))}
    </svg>
  );
}
