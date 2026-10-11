import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import conv from "../fixtures/inspection-conv.json";
import dense from "../fixtures/inspection-dense.json";
import linear from "../fixtures/inspection-linear.json";
import type { Inspection, ModelInspectionView } from "../inspection";
import { ModelInspector } from "./ModelInspector";

const invokeMock = vi.fn();
// A refusal is produced outside the mock function: vitest reports a rejecting mock's own promise as an unhandled error.
let refuseWith: string | null = null;
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => (refuseWith !== null ? Promise.reject(refuseWith) : invokeMock(...args)) }));

beforeEach(() => { invokeMock.mockReset(); refuseWith = null; });
afterEach(cleanup);

const view = (inspection: unknown, over: Partial<ModelInspectionView> = {}): ModelInspectionView => ({
  id: "snap-abc", label: "snap", origin: "trained", manifest: { input: { features: (inspection as Inspection | null)?.inputs.map((i) => i.name) ?? ["accel_x_std"] }, provenance: {} }, inspection: inspection as Inspection | null, ...over,
});
const open = async (v: ModelInspectionView) => {
  invokeMock.mockResolvedValue(v);
  const onClose = vi.fn();
  render(<ModelInspector id={v.id} onClose={onClose} />);
  await screen.findByRole("status", { name: "Model summary" });
  return onClose;
};

describe("ModelInspector: logistic regression", () => {
  it("shows the summary, every input with what it takes and how much it matters, and the weights", async () => {
    await open(view(linear));
    expect(invokeMock).toHaveBeenCalledWith("inspect_label_model", { id: "snap-abc" });
    const summary = screen.getByRole("status", { name: "Model summary" });
    expect(summary).toHaveTextContent("Logistic regression");
    expect(summary).toHaveTextContent("4 inputs");
    expect(summary).toHaveTextContent(/Held-out ROC AUC 1\.00|Held-out ROC AUC 0\.\d\d/);
    const table = screen.getByRole("table", { name: "Inputs of the model" });
    expect(within(table).getAllByRole("row")).toHaveLength(5); // header + 4
    expect(within(table).getAllByText(/standard deviation/, { selector: "td" }).length).toBeGreaterThan(0);
    expect(within(table).getAllByText(/Acceleration · X/).length).toBeGreaterThan(0);
    expect(within(table).getByRole("columnheader", { name: "Weight" })).toBeInTheDocument(); // a linear model has one weight per input
    expect(screen.getByRole("img", { name: /The weight on each of 4 inputs/ })).toBeInTheDocument();
  });

  it("sorts by importance (the one the gesture changes first) and back to the model's own order", async () => {
    await open(view(linear));
    const first = () => within(screen.getByRole("table", { name: "Inputs of the model" })).getAllByRole("row")[1];
    expect(first()).toHaveTextContent("spread"); // a spread, not the plain average, is what tells snap from idle
    fireEvent.click(screen.getByRole("button", { name: "Show in the model's own order" }));
    expect(first()).toHaveTextContent("Acceleration · X · mean"); // the trainer lists inputs in its canonical order, the average first
    fireEvent.click(screen.getByRole("button", { name: "Sort by importance" }));
    expect(screen.getByRole("button", { name: "Show in the model's own order" })).toBeInTheDocument();
  });
});

describe("ModelInspector: how well it works and comparing models", () => {
  const model = (id: string, label = "snap", state = "approved") => ({ id, label, state, deployable: true, imported: false, modelSha256: "x", createdAt: "", active: false }) as never;

  it("shows how well it works, and offers only other models of the same label to compare with", async () => {
    invokeMock.mockImplementation(async (_: string, args: { id: string }) => (args.id === "snap-abc" ? view(linear) : view(dense, { id: args.id })));
    render(<ModelInspector id="snap-abc" onClose={() => undefined} models={[model("snap-abc"), model("snap-2"), model("fist-1", "fist")]} />);
    expect(await screen.findByRole("region", { name: "How well it works" })).toBeInTheDocument();
    const choose = screen.getByLabelText("Compare with another model") as HTMLSelectElement;
    expect(Array.from(choose.options).map((o) => o.textContent)).toEqual(["No other model", "snap-2 (approved)"]);
    expect(screen.queryByRole("table", { name: "Comparison with another model" })).not.toBeInTheDocument();
    fireEvent.change(choose, { target: { value: "snap-2" } });
    expect(await screen.findByRole("table", { name: "Comparison with another model" })).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("inspect_label_model", { id: "snap-2" });
    fireEvent.change(choose, { target: { value: "" } });
    await waitFor(() => expect(screen.queryByRole("table", { name: "Comparison with another model" })).not.toBeInTheDocument());
  });

  it("says when the other model has no saved inspection", async () => {
    invokeMock.mockImplementation(async (_: string, args: { id: string }) => (args.id === "snap-abc" ? view(linear) : view(null, { id: args.id, origin: "imported" })));
    render(<ModelInspector id="snap-abc" onClose={() => undefined} models={[model("snap-abc"), model("snap-2")]} />);
    fireEvent.change(await screen.findByLabelText("Compare with another model"), { target: { value: "snap-2" } });
    expect(await screen.findByText(/snap-2 has no saved inspection/)).toBeInTheDocument();
  });

  it("offers nothing to compare with when it is the only model of its label", async () => {
    invokeMock.mockResolvedValue(view(linear));
    render(<ModelInspector id="snap-abc" onClose={() => undefined} models={[model("snap-abc")]} />);
    await screen.findByRole("region", { name: "How well it works" });
    expect(screen.queryByLabelText("Compare with another model")).not.toBeInTheDocument();
  });
});

describe("ModelInspector: dense network", () => {
  it("draws one weights picture per layer, the learning curve, and lets a window be tried", async () => {
    await open(view(dense));
    expect(screen.getByRole("img", { name: /^Layer 1 weights: 5 by 6/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /^Layer 2 weights: 6 by 4/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /^Output layer weights: 4 by 2/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "How it learned" })).toBeInTheDocument();
    const windows = screen.getByRole("list", { name: "Windows to look at" });
    const buttons = within(windows).getAllByRole("button");
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    expect(buttons[0]).toHaveAttribute("aria-pressed", "true");
    const table = screen.getByRole("table", { name: "Inputs for this window" });
    expect(within(table).getAllByRole("row")).toHaveLength(6); // header + 5 inputs
    expect(screen.getByRole("img", { name: /^Layer 1 neurons: 1 by 6/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /^Layer 2 neurons: 1 by 4/ })).toBeInTheDocument();
    const status = screen.getByRole("status", { name: "The window chosen" });
    expect(status).toHaveTextContent(/Score \d+% [≥<] cut-off \d+%/);
    // Choosing a miss or a false alarm (when there is one) says what it is.
    const other = buttons[buttons.length - 1];
    fireEvent.click(other);
    expect(other).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("status", { name: "The window chosen" })).toHaveTextContent(/It came from recording/);
  });
});

describe("ModelInspector: convolutional network", () => {
  it("shows the first layer's filters, the deeper layers' strength, the window, the feature maps and what mattered", async () => {
    await open(view(conv));
    expect(screen.getAllByRole("img", { name: /^Filter \d+: 3 by 3/ })).toHaveLength(4);
    expect(screen.getByRole("img", { name: /^Convolution layer 2 strength: 3 by 4/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /^The window: 3 by 8/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /^Convolution layer 1 output: 4 by 8/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /^Convolution layer 2 output: 3 by 8/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /^What mattered: 3 by 2/ })).toBeInTheDocument(); // 3 channels x 2 blocks of 4 steps
    expect(screen.getByRole("status", { name: "Model summary" })).toHaveTextContent("3 channels");
  });
});

describe("ModelInspector: without an inspection, and failing", () => {
  it("says what it can and cannot show for an imported model, and lists the inputs it declares", async () => {
    invokeMock.mockResolvedValue(view(null, { origin: "imported", manifest: { input: { features: ["accel_x_std", "ppg_green_spike_z"] }, preprocessing: { kind: "spike_extraction", method: "morphological_top_hat" } } }));
    render(<ModelInspector id="snap-abc" onClose={() => undefined} />);
    expect(await screen.findByText(/This model was imported, so the app has only what it declares/)).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Inputs of the model" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(list).toHaveTextContent("Morphological top-hat"); // the spike input names the method that makes it
    expect(screen.queryByRole("region", { name: "Weights" })).not.toBeInTheDocument();
  });

  it("explains a model trained before inspections were saved", async () => {
    invokeMock.mockResolvedValue(view(null));
    render(<ModelInspector id="snap-abc" onClose={() => undefined} />);
    expect(await screen.findByText(/trained before inspections were saved/)).toBeInTheDocument();
  });

  it("shows the reason when it cannot be loaded, and closes", async () => {
    refuseWith = "there is no such model";
    const onClose = vi.fn();
    render(<ModelInspector id="gone" onClose={onClose} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("there is no such model");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
