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

  it("leaves another model's edits alone when an earlier save finishes after switching to it", async () => {
    let finishSave: () => void = () => undefined;
    const a = view(dense);
    const b = view(dense, { id: "snap-def" });
    invokeMock.mockImplementation(async (command: string, args: { id: string }) => {
      if (command === "inspect_label_model") return args.id === b.id ? b : a;
      if (command === "start_label_edit") return new Promise<void>((resolve) => { finishSave = resolve; });
      return undefined;
    });
    const page = render(<ModelInspector id={a.id} onClose={() => undefined} />);
    await screen.findByRole("status", { name: "Model summary" });
    edit();
    fireEvent.click(screen.getByRole("checkbox", { name: "Switch off Acceleration X spread" }));
    fireEvent.click(screen.getByRole("button", { name: "Save as a new model" }));
    await waitFor(() => expect(calls("start_label_edit")).toHaveLength(1));
    // Model B is opened and edited while A's save is still going.
    page.rerender(<ModelInspector id={b.id} onClose={() => undefined} />);
    await screen.findByRole("status", { name: "Model summary" });
    edit();
    fireEvent.click(screen.getByRole("checkbox", { name: "Switch off Acceleration X spread" }));
    const list = within(screen.getByRole("region", { name: "Edit this model" })).getByRole("list", { name: "Changes waiting" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Save as a new model" })).not.toBeDisabled();
    finishSave();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByText(/being scored and will appear as a new draft/)).not.toBeInTheDocument();
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

  it("emphasises an input from the table, replaces an earlier emphasis, lets go of it at 1×, and sends it with the edit", async () => {
    await open(view(dense));
    edit();
    const emphasis = () => screen.getByRole("combobox", { name: "Emphasis of Acceleration X spread" });
    fireEvent.change(emphasis(), { target: { value: "3" } });
    expect(screen.getByRole("list", { name: "Changes waiting" })).toHaveTextContent("Emphasise X spread: what it feeds the first layer is multiplied by 3");
    fireEvent.change(emphasis(), { target: { value: "5" } });
    const list = screen.getByRole("list", { name: "Changes waiting" });
    expect(list).toHaveTextContent("multiplied by 5");
    expect(list).not.toHaveTextContent("multiplied by 3"); // replaced, not added
    fireEvent.change(emphasis(), { target: { value: "0.5" } });
    expect(screen.getByRole("list", { name: "Changes waiting" })).toHaveTextContent("Play down X spread");
    fireEvent.click(screen.getByRole("checkbox", { name: "Switch off Acceleration X spread" }));
    expect(emphasis()).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Switch off Acceleration X spread" }));
    fireEvent.change(emphasis(), { target: { value: "1" } });
    expect(screen.queryByText(/Play down X spread/)).not.toBeInTheDocument();
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

describe("a model that reads the dataset's own columns", () => {
  it("shows columns and neurons: the inputs per column, a first layer with a row for each neuron, and values per column", async () => {
    const columns = (await import("../fixtures/inspection-columns.json")).default;
    await open(view(columns));
    const summary = screen.getByRole("status", { name: "Model summary" });
    expect(summary).toHaveTextContent("3 columns × 2 readings = 6 input neurons");
    const table = screen.getByRole("table", { name: "Inputs of the model" });
    expect(within(table).getByRole("columnheader", { name: "Neurons" })).toBeInTheDocument();
    expect(within(table).getAllByRole("row")).toHaveLength(4); // header + three columns
    expect(table).toHaveTextContent("2 input neurons, one for each");
    // The first layer has a row for each column at each reading.
    expect(screen.getByRole("img", { name: /^Layer 1 weights: 6 by 5/ })).toBeInTheDocument();
    const windowTable = screen.getByRole("table", { name: "Inputs for this window" });
    expect(within(windowTable).getAllByRole("row")).toHaveLength(4);
    expect(windowTable).toHaveTextContent("Its value (average of its readings)");
  });

  it("edits one neuron of a column, and switches a whole column off", async () => {
    const columns = (await import("../fixtures/inspection-columns.json")).default;
    await open(view(columns));
    edit();
    fireEvent.click(screen.getByRole("button", { name: /^Accel Y signal @2, 3: / })); // the second reading of the second column
    const chosen = screen.getByRole("group", { name: "The chosen weight" });
    expect(chosen).toHaveTextContent("Dense layer 1: from Y signal, reading 2 to neuron 3");
    fireEvent.change(within(chosen).getByLabelText("New value"), { target: { value: "0.25" } });
    fireEvent.click(within(chosen).getByRole("button", { name: "Set the weight" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Switch off Acceleration X signal" }));
    const list = screen.getByRole("list", { name: "Changes waiting" });
    expect(list).toHaveTextContent("Set the weight from Y signal reading 2 to neuron 3 in dense layer 1 to 0.25");
    expect(list).toHaveTextContent("Switch off X signal");
    fireEvent.click(screen.getByRole("button", { name: "Save as a new model" }));
    await waitFor(() => expect(calls("start_label_edit")).toHaveLength(1));
    expect(calls("start_label_edit")[0][1].edits).toEqual([
      { kind: "setWeight", layer: 0, row: 3, column: 2, value: 0.25 },
      { kind: "disableInput", input: "accel_x" },
    ]);
  });
});

describe("fine-tuning", () => {
  it("carries on training a PyTorch model on its own, with a layer frozen, and sends the settings", async () => {
    await open(view(dense));
    edit();
    const box = screen.getByRole("checkbox", { name: "Fine-tune after these changes" });
    expect(screen.getByRole("button", { name: "Save as a new model" })).toBeDisabled(); // nothing to save yet
    fireEvent.click(box);
    expect(screen.getByRole("button", { name: "Fine-tune as a new model" })).toBeEnabled(); // fine-tuning is a change on its own
    fireEvent.change(screen.getByLabelText("Fine-tuning rounds"), { target: { value: "12" } });
    fireEvent.change(screen.getByLabelText("Fine-tuning learning rate"), { target: { value: "0.002" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Freeze dense layer 1" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Freeze dense layer 3" })); // the output layer of a network with two hidden layers
    fireEvent.click(screen.getByRole("button", { name: "Fine-tune as a new model" }));
    await waitFor(() => expect(calls("start_label_edit")).toHaveLength(1));
    expect(calls("start_label_edit")[0][1]).toEqual({
      id: "snap-abc", edits: [], fineTune: { epochs: 12, learningRate: 0.002, freezeConv: [], freezeDense: [0, 2] },
    });
    expect(await screen.findByText(/The fine-tuned model is being scored/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Fine-tuning rounds")).not.toBeInTheDocument(); // sent: the choice is cleared
  });

  it("fine-tunes after hand edits, and warns when every layer is frozen", async () => {
    await open(view(dense));
    edit();
    fireEvent.click(screen.getByRole("checkbox", { name: "Switch off Acceleration X spread" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Fine-tune after these changes" }));
    for (const layer of [1, 2, 3]) fireEvent.click(screen.getByRole("checkbox", { name: `Freeze dense layer ${layer}` }));
    expect(screen.getByRole("alert")).toHaveTextContent("Every layer is frozen");
    fireEvent.click(screen.getByRole("checkbox", { name: "Freeze dense layer 2" })); // unfreeze one
    fireEvent.click(screen.getByRole("button", { name: "Save as a new model" }));
    await waitFor(() => expect(calls("start_label_edit")).toHaveLength(1));
    expect(calls("start_label_edit")[0][1]).toMatchObject({ edits: [{ kind: "disableInput", input: "accel_x_std" }], fineTune: { freezeDense: [0, 2] } });
  });

  it("freezes convolution layers for a convolutional model, and is not offered for a scikit-learn one", async () => {
    await open(view(conv));
    edit();
    fireEvent.click(screen.getByRole("checkbox", { name: "Fine-tune after these changes" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Freeze convolution layer 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Fine-tune as a new model" }));
    await waitFor(() => expect(calls("start_label_edit")).toHaveLength(1));
    expect(calls("start_label_edit")[0][1].fineTune).toMatchObject({ learningRate: 0.001, freezeConv: [0], freezeDense: [] });
    cleanup();
    invokeMock.mockReset();
    await open(view(linear));
    edit();
    expect(screen.getByRole("checkbox", { name: "Fine-tune after these changes" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText(/Needs one of the PyTorch methods/)).toBeInTheDocument();
  });
});
