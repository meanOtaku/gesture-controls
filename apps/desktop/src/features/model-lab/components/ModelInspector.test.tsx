import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import trees from "../fixtures/inspection-trees.json";
import type { Inspection, ModelInspectionView } from "../inspection";
import { ModelInspector } from "./ModelInspector";

const invokeMock = vi.fn();
// A refusal is produced outside the mock function: vitest reports a rejecting mock's own promise as an unhandled error.
let refuseWith: string | null = null;
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => (refuseWith !== null ? Promise.reject(refuseWith) : invokeMock(...args)) }));

beforeEach(() => { invokeMock.mockReset(); refuseWith = null; });
afterEach(cleanup);

const FEATURES = ["ppg_z1000ms_d1_green_n8_q10", "ppg_z4000ms_d3_ir_n32_std"];
const view = (inspection: unknown, over: Partial<ModelInspectionView> = {}): ModelInspectionView => ({
  id: "pinch-abc", label: "pinch", origin: "trained", manifest: { input: { features: FEATURES }, provenance: {} }, inspection: inspection as Inspection | null, ...over,
});
const model = (id: string, label = "pinch", over: Record<string, unknown> = {}) => ({ id, label, state: "approved", deployable: true, imported: false, modelSha256: "x", createdAt: "", active: false, ...over }) as never;
const open = async (v: ModelInspectionView, models: never[] = []) => {
  invokeMock.mockResolvedValue(v);
  render(<ModelInspector id={v.id} onClose={() => undefined} models={models} />);
  await screen.findByRole("status", { name: "Model summary" });
};

describe("ModelInspector", () => {
  it("shows what the pulse model reads, how well it works and what it leans on, from the trainer's real inspection", async () => {
    await open(view(trees));
    expect(invokeMock).toHaveBeenCalledWith("inspect_label_model", { id: "pinch-abc" });
    const summary = screen.getByRole("status", { name: "Model summary" });
    expect(summary).toHaveTextContent("PPG pinch-start model");
    expect(summary).toHaveTextContent("1,701 pulse inputs · 300 trees");
    expect(summary).toHaveTextContent(/Held-out ROC AUC 0\.\d\d/);
    expect(screen.getByRole("region", { name: "How well it works" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Research checks" })).toBeInTheDocument();
    const inputs = screen.getByRole("table", { name: "Most important inputs" });
    expect(within(inputs).getAllByRole("row")).toHaveLength(1 + (trees as unknown as Inspection).importance.length);
    expect(inputs).toHaveTextContent(/against the last [124] s/);
  });

  const cnn = { ...(trees as object), kind: "cnn", trees: 0, inputCount: 450, sources: ["watchPpg", "watchOrientation"], trigger: "peak", importance: [], research: null };
  const kindIs = (kind: string) => ({ manifest: { preprocessing: { kind } } });

  it("shows a CNN's pipeline, results and channels, with no list of inputs it does not have", async () => {
    await open(view(cnn, kindIs("ppg_imu_cnn_median")));
    const summary = screen.getByRole("status", { name: "Model summary" });
    expect(summary).toHaveTextContent("CNN pinch-start model");
    expect(summary).toHaveTextContent("450 pulse and motion inputs · 3 networks · fires on the peak");
    expect(summary).not.toHaveTextContent("trees");
    expect(screen.getByRole("region", { name: "How well it works" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "How this model works" })).getByRole("list", { name: "Pipeline stages" })).toHaveTextContent("median and spread");
    expect(screen.getByRole("table", { name: "Channels the model reads" })).toHaveTextContent("Gyroscope");
    expect(screen.queryByRole("table", { name: "Most important inputs" })).not.toBeInTheDocument();
    expect(screen.queryByText(/inspection could not be made/)).not.toBeInTheDocument();
  });

  it("describes each kind of model by what its manifest says, not by what it was given to compare", async () => {
    await open(view(cnn, kindIs("ppg_imu_cnn")));
    expect(screen.getByRole("status", { name: "Model summary" })).toHaveTextContent("rolling scaling");
    expect(screen.getByRole("region", { name: "How this model works" })).toHaveTextContent("z-scored against the 10 s");
    cleanup();
    await open(view({ ...(trees as object), sources: ["watchPpg", "watchOrientation"] }, kindIs("ppg_imu_onset")));
    expect(screen.getByRole("region", { name: "How this model works" })).toHaveTextContent("ExtraTrees");
    expect(screen.getByRole("region", { name: "How this model works" })).toHaveTextContent("Peak trigger");
    cleanup();
    await open(view(trees, kindIs("ppg_multiscale_onset")));
    const earlier = screen.getByRole("region", { name: "How this model works" });
    expect(earlier).toHaveTextContent("Edge trigger");
    expect(earlier).not.toHaveTextContent("Accelerometer");
  });

  it("shows an imported CNN's pipeline, settings and stated results", async () => {
    invokeMock.mockResolvedValue(view(null, { origin: "imported", manifest: {
      preprocessing: { kind: "ppg_imu_cnn_median" },
      input: { features: ["cnn_accel_x_t00", "cnn_ppg_ir_t49"] },
      thresholds: { activation: 0.97, release: 0.82, cooldownMs: 1500, decisionDelayMs: 500 },
      provenance: { evaluationGestureRecall: 0.8305, evaluationFalseActivationsPerHour: 0, evaluationRocAuc: 0.9954, trainRecordings: ["a", "b"], evaluationRecordings: ["c"] },
    } }));
    render(<ModelInspector id="pinch-abc" onClose={() => undefined} />);
    expect(await screen.findByRole("region", { name: "How this model works" })).toHaveTextContent("Scaled to its recent level");
    const facts = screen.getByRole("region", { name: "Declared settings and results" });
    for (const text of ["0.97", "0.82", "500 ms", "83%", "0.0 / hour", "0.995"]) expect(facts).toHaveTextContent(text);
    expect(screen.getByRole("region", { name: "Declared inputs" })).toHaveTextContent("acceleration x, 0.98 s before the decision");
  });

  it("marks a model that may only run in Monitor", async () => {
    await open(view(trees), [model("pinch-abc", "pinch", { deployable: false, monitorOnly: true })]);
    expect(screen.getByRole("status", { name: "Model summary" })).toHaveTextContent("Monitor only");
  });

  it("offers only other models of the same label to compare with, and says when one has no inspection", async () => {
    invokeMock.mockImplementation(async (_: string, args: { id: string }) => (args.id === "pinch-abc" ? view(trees) : args.id === "pinch-2" ? view(trees, { id: "pinch-2" }) : view(null, { id: args.id, origin: "imported" })));
    render(<ModelInspector id="pinch-abc" onClose={() => undefined} models={[model("pinch-abc"), model("pinch-2"), model("pinch-3"), model("fist-1", "fist")]} />);
    const choose = (await screen.findByLabelText("Compare with another model")) as HTMLSelectElement;
    expect(Array.from(choose.options).map((o) => o.textContent)).toEqual(["No other model", "pinch-2 (approved)", "pinch-3 (approved)"]);
    fireEvent.change(choose, { target: { value: "pinch-2" } });
    expect(await screen.findByRole("table", { name: "Comparison with another model" })).toBeInTheDocument();
    fireEvent.change(choose, { target: { value: "pinch-3" } });
    expect(await screen.findByText(/pinch-3 has no saved inspection/)).toBeInTheDocument();
  });

  it("offers nothing to compare with when it is the only model of its label", async () => {
    await open(view(trees), [model("pinch-abc")]);
    expect(screen.queryByLabelText("Compare with another model")).not.toBeInTheDocument();
  });

  it("says what it can show for an imported model: the inputs it declares", async () => {
    invokeMock.mockResolvedValue(view(null, { origin: "imported" }));
    render(<ModelInspector id="pinch-abc" onClose={() => undefined} />);
    expect(await screen.findByText(/This model was imported, so the app has only what it declares/)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Declared inputs" })).toHaveTextContent("Inputs (2)");
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
