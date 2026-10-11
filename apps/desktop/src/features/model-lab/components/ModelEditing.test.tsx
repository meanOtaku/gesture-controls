import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import conv from "../fixtures/inspection-conv.json";
import dense from "../fixtures/inspection-dense.json";
import edited from "../fixtures/inspection-edited.json";
import linear from "../fixtures/inspection-linear.json";
import type { Inspection, ModelInspectionView } from "../inspection";
import { ModelInspector } from "./ModelInspector";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

beforeEach(() => invokeMock.mockReset());
afterEach(cleanup);

const view = (inspection: unknown, over: Partial<ModelInspectionView> = {}): ModelInspectionView => ({
  id: "snap-abc", label: "snap", origin: "trained", manifest: {}, inspection: inspection as Inspection, ...over,
});
async function open(v: ModelInspectionView) {
  invokeMock.mockImplementation(async (command: string) => (command === "inspect_label_model" ? v : undefined));
  render(<ModelInspector id={v.id} onClose={() => undefined} />);
  await screen.findByRole("status", { name: "Model summary" });
}
const edit = () => fireEvent.click(screen.getByRole("button", { name: "Edit this model" }));
const calls = (command: string) => invokeMock.mock.calls.filter(([name]) => name === command);

describe("editing a dense network", () => {
  it("offers editing for a model trained here, and not for an imported one or one without an inspection", async () => {
    await open(view(dense));
    expect(screen.getByRole("button", { name: "Edit this model" })).toBeInTheDocument();
    cleanup();
    invokeMock.mockResolvedValue(view(dense, { origin: "imported" }));
    render(<ModelInspector id="snap-abc" onClose={() => undefined} />);
    await screen.findByRole("status", { name: "Model summary" });
    expect(screen.queryByRole("button", { name: "Edit this model" })).not.toBeInTheDocument();
  });

  it("lets a weight be chosen, changed, undone and several changes collected, then saved as a new model", async () => {
    await open(view(dense));
    expect(screen.queryByRole("region", { name: "Edit this model" })).not.toBeInTheDocument();
    edit();
    const panel = screen.getByRole("region", { name: "Edit this model" });
    expect(panel).toHaveTextContent("No weight chosen yet");
    expect(screen.getByRole("button", { name: "Save as a new model" })).toBeDisabled();

    // Press a cell of layer 1: the panel says where it is and what it is now.
    fireEvent.click(screen.getByRole("button", { name: /^Accel X spread, 3: / }));
    const chosen = within(panel).getByRole("group", { name: "The chosen weight" });
    expect(chosen).toHaveTextContent("Dense layer 1: from spread of X to neuron 3");
    fireEvent.change(within(chosen).getByLabelText("New value"), { target: { value: "0.5" } });
    fireEvent.click(within(chosen).getByRole("button", { name: "Set the weight" }));
    fireEvent.click(within(chosen).getByRole("button", { name: "Silence neuron 3" }));
    // Another cell: the first layer's input row, then the output layer (which has no neuron to silence).
    fireEvent.click(screen.getByRole("button", { name: /^neuron 1, gesture: / }));
    expect(within(panel).queryByRole("button", { name: /Silence neuron/ })).not.toBeInTheDocument();
    fireEvent.change(within(panel).getByLabelText("New value"), { target: { value: "0.1" } });
    fireEvent.click(within(panel).getByRole("button", { name: /Set the bias of neuron 2/ }));

    const list = within(panel).getByRole("list", { name: "Changes waiting" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(list).toHaveTextContent("Set the weight from X spread to neuron 3 in dense layer 1 to 0.5");
    expect(list).toHaveTextContent("Silence neuron 3 of dense layer 1");
    expect(list).toHaveTextContent("Set the bias of neuron 2 in the output layer to 0.1");
    fireEvent.click(within(panel).getByRole("button", { name: "Undo change 2" }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);

    fireEvent.click(within(panel).getByRole("button", { name: "Save as a new model" }));
    await waitFor(() => expect(calls("start_label_edit")).toHaveLength(1));
    expect(calls("start_label_edit")[0][1]).toEqual({
      id: "snap-abc",
      edits: [{ kind: "setWeight", layer: 0, row: 0, column: 2, value: 0.5 }, { kind: "setBias", layer: 2, neuron: 1, value: 0.1 }],
    });
    expect(await screen.findByText(/The edited model is being scored and will appear as a new draft/)).toBeInTheDocument();
    expect(within(panel).getByText("None yet.")).toBeInTheDocument(); // the list is cleared once it is saved
  });

  it("switches inputs off from the table, and a second tick undoes it", async () => {
    await open(view(dense));
    edit();
    const box = screen.getByRole("checkbox", { name: "Switch off Acceleration X spread" });
    fireEvent.click(box);
    expect(screen.getByRole("list", { name: "Changes waiting" })).toHaveTextContent("Switch off X spread: the model stops using it");
    expect(box).toBeChecked();
    fireEvent.click(box);
    expect(screen.queryByRole("list", { name: "Changes waiting" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop editing" }));
    expect(screen.queryByRole("checkbox", { name: /Switch off/ })).not.toBeInTheDocument();
  });

  it("refuses a value that is not a number and shows the reason when saving fails", async () => {
    await open(view(dense));
    edit();
    fireEvent.click(screen.getByRole("button", { name: /^Accel X spread, 1: / }));
    fireEvent.change(screen.getByLabelText("New value"), { target: { value: "99999" } });
    expect(screen.getByRole("button", { name: "Set the weight" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/not a number the model can take/);
    fireEvent.change(screen.getByLabelText("New value"), { target: { value: "0.2" } });
    fireEvent.click(screen.getByRole("button", { name: "Set the weight" }));
    invokeMock.mockImplementation(async (command: string) => { if (command === "start_label_edit") throw "this model was trained before editing was possible: train it again to edit it"; return undefined; });
    fireEvent.click(screen.getByRole("button", { name: "Save as a new model" }));
    expect(await screen.findByText(/trained before editing was possible/)).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Changes waiting" })).toBeInTheDocument(); // a failure keeps the changes
  });
});

describe("editing other kinds of model", () => {
  it("edits a convolutional model's filters and silences a filter", async () => {
    await open(view(conv));
    edit();
    fireEvent.click(screen.getByRole("button", { name: /^Accel X signal, column 2: / }));
    const chosen = screen.getByRole("group", { name: "The chosen weight" });
    expect(chosen).toHaveTextContent(/Convolution layer 1, filter 1, X signal, step 2/);
    fireEvent.change(within(chosen).getByLabelText("New value"), { target: { value: "-0.3" } });
    fireEvent.click(within(chosen).getByRole("button", { name: "Set this step" }));
    fireEvent.click(within(chosen).getByRole("button", { name: "Silence filter 1" }));
    const list = screen.getByRole("list", { name: "Changes waiting" });
    expect(list).toHaveTextContent("Set step 2 of filter 1 on X signal (convolution layer 1) to -0.3");
    expect(list).toHaveTextContent("Silence filter 1 of convolution layer 1");
    fireEvent.click(screen.getByRole("button", { name: "Save as a new model" }));
    await waitFor(() => expect(calls("start_label_edit")).toHaveLength(1));
    expect(calls("start_label_edit")[0][1].edits).toEqual([
      { kind: "setFilterWeight", layer: 0, filter: 0, channel: 0, tap: 1, value: -0.3 },
      { kind: "silenceNeuron", layer: 0, neuron: 0, conv: true },
    ]);
  });

  it("edits a logistic regression's weights", async () => {
    await open(view(linear));
    edit();
    fireEvent.click(screen.getAllByRole("button", { name: /^Accel .*weight: / })[0]);
    fireEvent.change(screen.getByLabelText("New value"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Set the weight" }));
    expect(screen.getByRole("list", { name: "Changes waiting" })).toHaveTextContent("in the output layer to 0");
  });
});

describe("a model made by editing another", () => {
  it("says what was changed and shows the score before and after on the same windows", async () => {
    await open(view(edited, { id: "snap-edit" }));
    const section = screen.getByRole("region", { name: "Edited from another model" });
    expect(section).toHaveTextContent("Edited from snap-v1");
    expect(within(section).getByRole("list", { name: "What was changed" })).toHaveTextContent("switched off accel_x_mean");
    const table = within(section).getByRole("table", { name: "Before and after the changes" });
    expect(within(table).getByRole("row", { name: /Before/ })).toHaveTextContent(/\d\.\d{3}/);
    expect(within(table).getByRole("row", { name: /After/ })).toHaveTextContent(/\d\.\d{3}/);
  });
});
