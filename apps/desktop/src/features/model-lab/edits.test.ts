import { describe, expect, it } from "vitest";
import dense from "./fixtures/inspection-dense.json";
import conv from "./fixtures/inspection-conv.json";
import { addEdit, describeEdit, type Edit } from "./edits";
import type { Inspection } from "./inspection";

const denseModel = dense as unknown as Inspection;
const convModel = conv as unknown as Inspection;

describe("describeEdit", () => {
  it("says each kind of edit in words", () => {
    expect(describeEdit({ kind: "disableInput", input: "accel_x_std" }, denseModel)).toBe("Switch off X spread: the model stops using it");
    expect(describeEdit({ kind: "setWeight", layer: 0, row: 1, column: 2, value: 0.5 }, denseModel)).toBe("Set the weight from Y spread to neuron 3 in dense layer 1 to 0.5");
    expect(describeEdit({ kind: "setWeight", layer: 1, row: 0, column: 3, value: -1 }, denseModel)).toBe("Set the weight from neuron 1 to neuron 4 in dense layer 2 to -1");
    expect(describeEdit({ kind: "setWeight", layer: 2, row: 0, column: 1, value: 2 }, denseModel)).toContain("in the output layer");
    expect(describeEdit({ kind: "setBias", layer: 0, neuron: 4, value: 0.1 }, denseModel)).toBe("Set the bias of neuron 5 in dense layer 1 to 0.1");
    expect(describeEdit({ kind: "silenceNeuron", layer: 0, neuron: 2 }, denseModel)).toBe("Silence neuron 3 of dense layer 1: nothing after it listens to it");
    expect(describeEdit({ kind: "setFilterWeight", layer: 0, filter: 1, channel: 2, tap: 0, value: 0.75 }, convModel)).toBe("Set step 1 of filter 2 on X signal (convolution layer 1) to 0.75");
    expect(describeEdit({ kind: "silenceNeuron", layer: 1, neuron: 0, conv: true }, convModel)).toBe("Silence filter 1 of convolution layer 2: nothing after it listens to it");
  });
});

describe("addEdit", () => {
  it("replaces an earlier edit of the same weight, and does not repeat an edit", () => {
    const first: Edit = { kind: "setWeight", layer: 0, row: 1, column: 2, value: 0.5 };
    let edits = addEdit([], first);
    edits = addEdit(edits, { kind: "setBias", layer: 0, neuron: 2, value: 1 });
    edits = addEdit(edits, { kind: "setWeight", layer: 0, row: 1, column: 2, value: 0.9 });
    expect(edits).toEqual([{ kind: "setBias", layer: 0, neuron: 2, value: 1 }, { kind: "setWeight", layer: 0, row: 1, column: 2, value: 0.9 }]);
    edits = addEdit(edits, { kind: "disableInput", input: "a" });
    expect(addEdit(edits, { kind: "disableInput", input: "a" })).toHaveLength(3);
    expect(addEdit(edits, { kind: "silenceNeuron", layer: 0, neuron: 2 })).toHaveLength(4); // a different thing
  });
});
