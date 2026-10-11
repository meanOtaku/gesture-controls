import { describeInput } from "./featureInfo";
import { neuronOf, type Inspection } from "./inspection";

/** A change to a trained model, as the trainer knows it (see `edits.py`). */
export type Edit =
  | { kind: "disableInput"; input: string }
  | { kind: "scaleInput"; input: string; factor: number }
  | { kind: "setWeight"; layer: number; row: number; column: number; value: number }
  | { kind: "setBias"; layer: number; neuron: number; value: number }
  | { kind: "setFilterWeight"; layer: number; filter: number; channel: number; tap: number; value: number }
  | { kind: "silenceNeuron"; layer: number; neuron: number; conv?: boolean };

/** What the person has selected in a weights picture: a cell of a dense layer, or a weight of a convolution filter. */
export type Selection =
  | { kind: "dense"; layer: number; row: number; column: number }
  | { kind: "filter"; layer: number; filter: number; channel: number; tap: number };

const label = (name: string) => {
  const info = describeInput(name);
  return `${info.group} ${info.short}`;
};

/** An edit in words, for the list of changes waiting to be saved. */
export function describeEdit(edit: Edit, inspection: Inspection): string {
  const names = inspection.inputs.map((input) => input.name);
  const layers = inspection.network.dense.length + 1;
  const layerName = (layer: number) => (layer === layers - 1 ? "the output layer" : `dense layer ${layer + 1}`);
  switch (edit.kind) {
    case "disableInput":
      return `Switch off ${label(edit.input)}: the model stops using it`;
    case "scaleInput":
      return `${edit.factor > 1 ? "Emphasise" : "Play down"} ${label(edit.input)}: what it feeds the first layer is multiplied by ${edit.factor}`;
    case "setWeight": {
      const steps = inspection.gridSteps ?? 1;
      const reading = inspection.inputKind === "columns" ? neuronOf(edit.row, steps) : null;
      const from = edit.layer === 0 && reading
        ? `${label(names[reading.column] ?? `column ${reading.column + 1}`)}${steps > 1 ? ` reading ${reading.step + 1}` : ""}`
        : edit.layer === 0 && inspection.network.kind !== "conv" ? label(names[edit.row] ?? `input ${edit.row + 1}`) : `neuron ${edit.row + 1}`;
      return `Set the weight from ${from} to neuron ${edit.column + 1} in ${layerName(edit.layer)} to ${edit.value}`;
    }
    case "setBias":
      return `Set the bias of neuron ${edit.neuron + 1} in ${layerName(edit.layer)} to ${edit.value}`;
    case "setFilterWeight":
      return `Set step ${edit.tap + 1} of filter ${edit.filter + 1} on ${label(names[edit.channel] ?? `channel ${edit.channel + 1}`)} (convolution layer ${edit.layer + 1}) to ${edit.value}`;
    case "silenceNeuron":
      return edit.conv ? `Silence filter ${edit.neuron + 1} of convolution layer ${edit.layer + 1}: nothing after it listens to it` : `Silence neuron ${edit.neuron + 1} of dense layer ${edit.layer + 1}: nothing after it listens to it`;
  }
}

/** The same edit, so two of one thing are listed once. */
export const sameEdit = (a: Edit, b: Edit): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Adds an edit; a later edit of the same weight (or bias) replaces the earlier one, and an edit already there is not repeated. */
export function addEdit(edits: Edit[], next: Edit): Edit[] {
  const target = (edit: Edit): string => {
    switch (edit.kind) {
      case "setWeight": return `w${edit.layer}:${edit.row}:${edit.column}`;
      case "setBias": return `b${edit.layer}:${edit.neuron}`;
      case "setFilterWeight": return `f${edit.layer}:${edit.filter}:${edit.channel}:${edit.tap}`;
      case "disableInput": return `d${edit.input}`;
      case "scaleInput": return `e${edit.input}`;
      case "silenceNeuron": return `s${edit.conv ? "c" : "d"}${edit.layer}:${edit.neuron}`;
    }
  };
  return [...edits.filter((edit) => target(edit) !== target(next)), next];
}

/** How to carry on training an edited model: for how long, how fast, and which layers stay as they are. */
export interface FineTune {
  epochs: number;
  learningRate: number;
  freezeConv: number[];
  freezeDense: number[];
}

/** Only the PyTorch methods can carry on training from changed weights. */
export const canFineTune = (backend: string): boolean => backend === "torch-mlp" || backend === "cnn1d";

/** A gentle start: a few rounds at a smaller step than the model was trained with. */
export const defaultFineTune = (backend: string): FineTune => ({ epochs: 30, learningRate: backend === "cnn1d" ? 0.001 : 0.003, freezeConv: [], freezeDense: [] });

/** The strengths an input can be emphasised or played down to (1 is as the model has it). */
export const EMPHASIS_FACTORS = [0.25, 0.5, 1, 2, 3, 5, 10] as const;
