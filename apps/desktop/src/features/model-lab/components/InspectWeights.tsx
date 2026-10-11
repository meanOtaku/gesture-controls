import { inputLabel } from "../featureInfo";
import type { Selection } from "../edits";
import { divergingColor, type Inspection } from "../inspection";
import { Heatmap } from "./Heatmap";

const WIDTH = 520;
const ROW = 16;

/** A weight for each input, as bars to the right (positive) or left (negative) of a centre line. */
function WeightBars({ names, weights }: { names: string[]; weights: number[] }) {
  const limit = Math.max(0.0001, ...weights.map(Math.abs));
  const middle = 260 + 90;
  const order = weights.map((w, i) => i).sort((a, b) => Math.abs(weights[b]) - Math.abs(weights[a]));
  const height = order.length * ROW + 8;
  return (
    <svg role="img" aria-label={`The weight on each of ${names.length} inputs, biggest first; red pushes toward the gesture, blue away from it.`} width={WIDTH + 180} height={height} viewBox={`0 0 ${WIDTH + 180} ${height}`} className="block max-w-full">
      <line x1={middle} x2={middle} y1={0} y2={height} stroke="currentColor" strokeOpacity={0.4} />
      {order.map((index, row) => {
        const weight = weights[index];
        const span = (Math.abs(weight) / limit) * 250;
        return (
          <g key={names[index]}>
            <text x={middle - 262} y={row * ROW + 12} fontSize={10} textAnchor="start" fill="currentColor">{inputLabel(names[index])}</text>
            <rect x={weight >= 0 ? middle : middle - span} y={row * ROW + 3} width={Math.max(span, 1)} height={ROW - 5} fill={divergingColor(weight, limit)} stroke="rgba(0,0,0,0.3)" strokeWidth={0.5}>
              <title>{`${names[index]}: ${weight.toFixed(3)}`}</title>
            </rect>
          </g>
        );
      })}
    </svg>
  );
}

const ordinal = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1}`);

/** The weights of the network: what each layer multiplies its inputs by. */
export function InspectWeights({ inspection, editing = false, selection = null, onSelect }: { inspection: Inspection; /** Makes the cells pressable, to choose a weight to change. */ editing?: boolean; selection?: Selection | null; onSelect?: (selection: Selection) => void }) {
  const { network, inputs } = inspection;
  const names = inputs.map((input) => input.name);
  const shortNames = names.map(inputLabel);

  if (network.kind === "linear") {
    return (
      <section aria-label="Weights" className="flex flex-col gap-2">
        <h3 className="text-base font-semibold">Weights</h3>
        <p className="field-hint">Logistic regression adds up each scaled input times its weight, plus {network.output.bias[0]?.toFixed(3)}, and turns the total into a probability. A red bar pushes the answer toward the gesture, a blue one away from it.</p>
        <WeightBars names={names} weights={network.output.weights.map((row) => row[0])} />
        {editing && (
          <Heatmap
            title="Weights to change" matrix={network.output.weights} rowLabels={shortNames} colLabels={["weight"]} cell={18}
            caption="Press a weight to change it"
            onCellClick={(row, column) => onSelect?.({ kind: "dense", layer: 0, row, column })}
            selected={selection?.kind === "dense" && selection.layer === 0 ? { row: selection.row, column: selection.column } : null}
          />
        )}
      </section>
    );
  }

  if (network.kind === "dense") {
    const layers = [...network.dense.map((layer) => layer.weights), network.output.weights];
    return (
      <section aria-label="Weights" className="flex flex-col gap-3">
        <h3 className="text-base font-semibold">Weights</h3>
        <p className="field-hint">Each picture is one layer: a row for each of its inputs, a column for each of its neurons. A red cell means the neuron adds that input; blue means it subtracts it. A column that is almost all white is a neuron doing very little.</p>
        {layers.map((weights, index) => {
          const last = index === layers.length - 1;
          const layer = network.dense[index];
          return (
            <Heatmap
              key={index}
              title={last ? "Output layer weights" : `Layer ${index + 1} weights`}
              matrix={weights}
              rowLabels={index === 0 ? shortNames : ordinal(weights.length).map((n) => `neuron ${n}`)}
              colLabels={last ? Array.from({ length: weights[0].length }, (_, k) => (weights[0].length === 1 ? "the gesture" : k === 1 ? "gesture" : "not")) : ordinal(weights[0].length)}
              caption={last ? "Output layer: how the last neurons add up to the answer" : `Layer ${index + 1}: ${weights.length} inputs → ${layer.units} neurons (${layer.activation ?? "no"} activation)`}
              onCellClick={editing ? (row, column) => onSelect?.({ kind: "dense", layer: index, row, column }) : undefined}
              selected={selection?.kind === "dense" && selection.layer === index ? { row: selection.row, column: selection.column } : null}
            />
          );
        })}
      </section>
    );
  }

  // Convolutional.
  const first = network.conv[0];
  return (
    <section aria-label="Weights" className="flex flex-col gap-3">
      <h3 className="text-base font-semibold">Filters</h3>
      <p className="field-hint">
        Each small picture is one filter of the first convolution layer: a row for each channel, a column for each step it looks across. It slides along the window and fires where the signal looks like its pattern (red cells are what it wants high, blue what it wants low).
      </p>
      <div className="flex flex-wrap gap-4">
        {first?.weights.map((filter, index) => (
          <Heatmap
            key={index} title={`Filter ${index + 1}`} matrix={filter} rowLabels={index === 0 ? shortNames : undefined} cell={12} caption={`Filter ${index + 1}`}
            onCellClick={editing ? (row, column) => onSelect?.({ kind: "filter", layer: 0, filter: index, channel: row, tap: column }) : undefined}
            selected={selection?.kind === "filter" && selection.layer === 0 && selection.filter === index ? { row: selection.channel, column: selection.tap } : null}
          />
        ))}
      </div>
      {network.conv.slice(1).map((layer, index) => (
        <Heatmap
          key={index}
          title={`Convolution layer ${index + 2} strength`}
          matrix={layer.weights.map((filter) => filter.map((taps) => Math.sqrt(taps.reduce((sum, v) => sum + v * v, 0))))}
          rowLabels={ordinal(layer.weights.length).map((n) => `filter ${n}`)}
          colLabels={ordinal(layer.weights[0].length)}
          scale="sequential"
          caption={`Layer ${index + 2}: how strongly each of its ${layer.filters} filters listens to each filter of the layer before`}
          cell={14}
        />
      ))}
      {network.dense.map((layer, index) => (
        <Heatmap
          key={`d${index}`} title={`Dense layer ${index + 1} weights`} matrix={layer.weights} caption={`Dense layer ${index + 1}: ${layer.weights.length} pooled values → ${layer.units} neurons`} cell={14}
          onCellClick={editing ? (row, column) => onSelect?.({ kind: "dense", layer: index, row, column }) : undefined}
          selected={selection?.kind === "dense" && selection.layer === index ? { row: selection.row, column: selection.column } : null}
        />
      ))}
      <Heatmap
        title="Output layer weights" matrix={network.output.weights} caption={`Output layer, after the ${network.pooling === "mean_max" ? "average and maximum" : network.pooling} pooling over time`} cell={14}
        onCellClick={editing ? (row, column) => onSelect?.({ kind: "dense", layer: network.dense.length, row, column }) : undefined}
        selected={selection?.kind === "dense" && selection.layer === network.dense.length ? { row: selection.row, column: selection.column } : null}
      />
    </section>
  );
}
