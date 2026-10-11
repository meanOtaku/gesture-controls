import { describeInput } from "./featureInfo";
import type { Inspection } from "./inspection";

/** A change to a trained model, as the trainer knows it (see `edits.py`). */
export type Edit =
  | { kind: "disableInput"; input: string }
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
    case "setWeight": {
      const from = edit.layer === 0 && inspection.network.kind !== "conv" ? label(names[edit.row] ?? `input ${edit.row + 1}`) : `neuron ${edit.row + 1}`;
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
      case "silenceNeuron": return `s${edit.conv ? "c" : "d"}${edit.layer}:${edit.neuron}`;
    }
  };
  return [...edits.filter((edit) => target(edit) !== target(next)), next];
}
