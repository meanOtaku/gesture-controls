import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrainPlan, TrainerEnvironment, TrainingStatus } from "../training";
import type { DatasetLabel, DatasetSummary } from "../types";
import { TrainPanel } from "./TrainPanel";

const invokeMock = vi.fn();
const handlers = new Map<string, (event: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, fn: (event: { payload: unknown }) => void) => {
    handlers.set(name, fn);
    return Promise.resolve(() => undefined);
  },
}));

const label = (id: string, displayName: string, archivedAt: string | null = null): DatasetLabel => ({ id, displayName, description: "", color: "#65e6ff", role: "positiveGesture", archivedAt });
const dataset = (id: string, labels: string[]): DatasetSummary => ({ id, originalFilename: `${id}.csv`, importedAt: "", label: labels.join(", "), labels, rowCount: 10 });
const labels = [label("snap", "Snap"), label("idle", "Idle"), label("old", "Old", "2026-01-01")];
const datasets = [dataset("s1", ["snap"]), dataset("s2", ["snap"]), dataset("i1", ["idle", "walking"]), dataset("i2", ["idle"])];

const MOTION = ["accel_x_mean", "accel_x_std", "accel_y_mean", "accel_y_std", "gyro_x_mean", "gyro_x_std"];
const okPlan: TrainPlan = { train: ["s1", "i1"], evaluation: ["s2", "i2"], problem: null, available: MOTION, features: MOTION };

function setup(over: { plan?: TrainPlan; environment?: TrainerEnvironment; status?: TrainingStatus } = {}) {
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "check_label_trainer") return over.environment ?? { available: true, detail: "uv 0.12" };
    if (command === "get_label_training_status") return over.status ?? { running: null, last: null };
    if (command === "plan_label_training") return over.plan ?? okPlan;
    if (command === "start_label_training") return "run-1";
    return undefined;
  });
  render(<TrainPanel desktopAvailable labels={labels} datasets={datasets} />);
}

const calls = (command: string) => invokeMock.mock.calls.filter(([name]) => name === command);
const choose = (id: string) => fireEvent.change(screen.getByLabelText("Label to teach"), { target: { value: id } });

beforeEach(() => { invokeMock.mockReset(); handlers.clear(); });
afterEach(cleanup);

describe("TrainPanel", () => {
  it("offers only labels that are not archived, and nothing else until one is chosen", async () => {
    setup();
    const select = screen.getByLabelText("Label to teach");
    expect(within(select).getByRole("option", { name: "Snap" })).toBeInTheDocument();
    expect(within(select).queryByRole("option", { name: "Old" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Train model" })).not.toBeInTheDocument();
  });

  it("starts from every recording, asks what each other label means, and shows the split before training", async () => {
    setup();
    choose("snap");
    for (const file of ["s1", "s2", "i1", "i2"]) expect(screen.getByRole("checkbox", { name: `Use ${file}.csv` })).toBeChecked();
    expect(screen.getByLabelText("Role of idle")).toHaveValue("negative");
    expect(screen.getByLabelText("Role of walking")).toBeInTheDocument();
    expect(await screen.findByText(/train on 2 recordings \(s1.csv, i1.csv\) and test on 2/)).toBeInTheDocument();
    expect(calls("plan_label_training").at(-1)?.[1]).toEqual({
      request: { label: "snap", datasetIds: ["s1", "s2", "i1", "i2"], negatives: ["idle", "walking"], excludes: [], backend: "logreg", sources: ["watchAcceleration", "watchGyroscope"], movementOnly: false, spikeMethod: "none", ppgChannels: ["green", "red", "ir"], windowMs: 500 },
    });
  });

  it("sends exactly the choices made: roles, method, streams and recordings", async () => {
    setup();
    choose("snap");
    await screen.findByText(/It will train on/);
    fireEvent.change(screen.getByLabelText("Role of walking"), { target: { value: "exclude" } });
    fireEvent.change(screen.getByLabelText("Method"), { target: { value: "mlp" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Only how things change" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Orientation" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Gyroscope" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Use i2.csv" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Train model" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Train model" }));
    await waitFor(() => expect(calls("start_label_training")).toHaveLength(1));
    expect(calls("start_label_training")[0][1]).toEqual({
      request: { label: "snap", datasetIds: ["s1", "s2", "i1"], negatives: ["idle"], excludes: ["walking"], backend: "mlp", sources: ["watchAcceleration", "watchOrientation"], movementOnly: true, spikeMethod: "none", ppgChannels: ["green", "red", "ir"], windowMs: 500 },
    });
  });

  it("offers a spike extraction method before the training method, and sends it only with the pulse sensor", async () => {
    setup();
    choose("snap");
    await screen.findByText(/It will train on/);
    const spikes = screen.getByLabelText("Spike extraction") as HTMLSelectElement;
    const method = screen.getByLabelText("Method");
    expect(spikes.compareDocumentPosition(method) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // before Method
    expect(spikes.value).toBe("none");
    expect(Array.from(spikes.options).map((option) => option.textContent)).toEqual(expect.arrayContaining(["None (statistics only)", "Rolling median residual", "Butterworth high-pass", "Haar wavelet detail"]));
    fireEvent.change(spikes, { target: { value: "rolling_median_residual" } });
    expect(screen.getByText(/Needs the pulse sensor/)).toBeInTheDocument(); // not one of the streams yet
    fireEvent.click(screen.getByRole("button", { name: "Train model" }));
    await waitFor(() => expect(calls("start_label_training")).toHaveLength(1));
    expect(calls("start_label_training")[0][1]).toMatchObject({ request: { spikeMethod: "none", ppgChannels: ["green", "red", "ir"], windowMs: 500 } }); // nothing for it to read
  });

  it("sends the chosen spike extraction method once the pulse sensor is a stream", async () => {
    setup();
    choose("snap");
    await screen.findByText(/It will train on/);
    fireEvent.click(screen.getByRole("checkbox", { name: /Pulse sensor \(PPG\)/ }));
    fireEvent.change(screen.getByLabelText("Spike extraction"), { target: { value: "morphological_top_hat" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Train model" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Train model" }));
    await waitFor(() => expect(calls("start_label_training")).toHaveLength(1));
    expect(calls("start_label_training")[0][1]).toMatchObject({ request: { sources: ["watchAcceleration", "watchGyroscope", "watchPpg"], spikeMethod: "morphological_top_hat" } });
  });

  it("lets you choose which pulse sensor channels to read, never fewer than one, and sends them", async () => {
    setup();
    choose("snap");
    await screen.findByText(/It will train on/);
    expect(screen.queryByRole("checkbox", { name: "Pulse channel: Green" })).not.toBeInTheDocument(); // the pulse sensor is not a stream yet
    fireEvent.click(screen.getByRole("checkbox", { name: /Pulse sensor \(PPG\)/ }));
    for (const name of ["Green", "Red", "Infrared"]) expect(screen.getByRole("checkbox", { name: `Pulse channel: ${name}` })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "Pulse channel: Red" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Pulse channel: Green" }));
    expect(screen.getByRole("checkbox", { name: "Pulse channel: Infrared" })).toHaveAttribute("aria-disabled", "true"); // the last one stays
    fireEvent.click(screen.getByRole("checkbox", { name: "Pulse channel: Red" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Train model" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Train model" }));
    await waitFor(() => expect(calls("start_label_training")).toHaveLength(1));
    expect(calls("start_label_training")[0][1]).toMatchObject({ request: { ppgChannels: ["red", "ir"] } });
  });

  it("offers the convolutional method and a window length, and sends both", async () => {
    setup();
    choose("snap");
    await screen.findByText(/It will train on/);
    const methodSelect = screen.getByLabelText("Method") as HTMLSelectElement;
    expect(Array.from(methodSelect.options).map((o) => o.textContent)).toContain("1D convolutional network (PyTorch)");
    const length = screen.getByLabelText("Window length") as HTMLSelectElement;
    expect(length.value).toBe("500");
    expect(Array.from(length.options).map((o) => o.textContent)).toEqual(["0.5 s (default)", "0.75 s", "1 s", "1.5 s", "2 s"]);
    fireEvent.change(methodSelect, { target: { value: "cnn1d" } });
    expect(screen.getByText(/1 to 1.5 s usually works better/)).toBeInTheDocument();
    fireEvent.change(length, { target: { value: "1000" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Train model" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Train model" }));
    await waitFor(() => expect(calls("start_label_training")).toHaveLength(1));
    expect(calls("start_label_training")[0][1]).toMatchObject({ request: { backend: "cnn1d", windowMs: 1000 } });
  });

  it("will not train when the plan says it cannot, and says why", async () => {
    setup({ plan: { train: [], evaluation: [], problem: "there must be at least two recordings with 'snap'", available: [], features: [] } });
    choose("snap");
    expect(await screen.findByText(/at least two recordings with 'snap'/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Train model" })).toBeDisabled();
  });

  it("will not train with nothing to read, or without the trainer", async () => {
    setup();
    choose("snap");
    await screen.findByText(/It will train on/);
    fireEvent.click(screen.getByRole("checkbox", { name: "Acceleration" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Gyroscope" }));
    expect(screen.getByRole("button", { name: "Train model" })).toBeDisabled();
    expect(screen.getByText("Choose at least one thing for the model to read.")).toBeInTheDocument();
    cleanup();
    setup({ environment: { available: false, detail: "Training needs uv on the PATH." } });
    expect(await screen.findByText("Training is not available here")).toBeInTheDocument();
    choose("snap");
    await screen.findByText(/It will train on/);
    expect(screen.getByRole("button", { name: "Train model" })).toBeDisabled();
  });

  it("shows progress, can be cancelled, and reports a model that was added as a draft", async () => {
    setup();
    choose("snap");
    await screen.findByText(/It will train on/);
    fireEvent.click(screen.getByRole("button", { name: "Train model" }));
    await vi.waitFor(() => expect(handlers.has("label-training-event")).toBe(true));
    const send = (payload: unknown) => act(() => handlers.get("label-training-event")?.({ payload }));
    send({ kind: "started", runId: "run-1", label: "snap", backend: "logreg" });
    send({ kind: "log", runId: "run-1", message: "downloading scikit-learn" });
    expect(await screen.findByLabelText("Training log")).toHaveTextContent("downloading scikit-learn");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(calls("cancel_label_training")).toHaveLength(1));
    send({ kind: "finished", runId: "run-1", label: "snap", outcome: "deployable", message: "", versionId: "snap-abc", metrics: { windows: 50, positiveWindows: 20, negativeWindows: 30, precision: 0.9, recall: 0.8, f1: 0.85, falseActivationRate: 0.04, rocAuc: 0.95, activationThreshold: 0.6 } });
    const result = await screen.findByRole("status", { name: "Training result" });
    expect(result).toHaveTextContent("A model for snap was added as a draft");
    expect(result).toHaveTextContent("80% of the 20 windows");
    expect(result).toHaveTextContent("chosen using those same test recordings");
    expect(result).toHaveTextContent("Review it under Label models");
    expect(screen.getByRole("button", { name: "Train model" })).toBeInTheDocument();
  });

  it("lets a neural network be designed, shows its size, and sends the design only when it differs from the default", async () => {
    setup();
    choose("snap");
    await screen.findByText(/It will train on/);
    expect(screen.queryByText(/Design the network/)).not.toBeInTheDocument(); // logistic regression has no layers
    fireEvent.change(screen.getByLabelText("Method"), { target: { value: "torch-mlp" } });
    expect(await screen.findByText(/Design the network/)).toHaveTextContent("6 inputs → 32 → 16 → 2 · 786 parameters");
    fireEvent.click(screen.getByRole("button", { name: "Train model" }));
    await waitFor(() => expect(calls("start_label_training")).toHaveLength(1));
    expect(calls("start_label_training")[0][1].request).not.toHaveProperty("network"); // still the default
    handlers.get("label-training-event")?.({ payload: { kind: "finished", runId: "r", label: "snap", outcome: "failed", message: "x" } });
    fireEvent.change(await screen.findByLabelText("Neurons in layer 1"), { target: { value: "8" } });
    fireEvent.change(screen.getByLabelText("Activation of layer 1"), { target: { value: "tanh" } });
    expect(screen.getByText(/Design the network/)).toHaveTextContent("6 inputs → 8 → 16 → 2");
    await waitFor(() => expect(screen.getByRole("button", { name: "Train model" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Train model" }));
    await waitFor(() => expect(calls("start_label_training")).toHaveLength(2));
    expect(calls("start_label_training")[1][1].request.network).toMatchObject({ hidden: [{ units: 8, activation: "tanh" }, { units: 16, activation: "relu" }], epochs: 200, learningRate: 0.01 });
    // Each method keeps its own design: the convolutional one starts from its own default.
    fireEvent.change(screen.getByLabelText("Method"), { target: { value: "cnn1d" } });
    expect(await screen.findByLabelText("Filters in convolution layer 1")).toHaveValue(16);
  });

  it("lets individual inputs be ticked off and sends only the ones still ticked", async () => {
    setup();
    choose("snap");
    await screen.findByText(/It will train on/);
    const picker = await screen.findByText(/Choose individual inputs/);
    expect(picker).toHaveTextContent("6 of 6 used");
    fireEvent.click(screen.getByRole("checkbox", { name: "Acceleration X mean" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Gyroscope X mean" }));
    expect(picker).toHaveTextContent("4 of 6 used");
    fireEvent.click(screen.getByRole("button", { name: "Train model" }));
    await waitFor(() => expect(calls("start_label_training")).toHaveLength(1));
    expect(calls("start_label_training")[0][1].request.features).toEqual(["accel_x_std", "accel_y_mean", "accel_y_std", "gyro_x_std"]);
  });

  it("asks for research checks only when ticked", async () => {
    setup();
    choose("snap");
    await screen.findByText(/It will train on/);
    fireEvent.click(screen.getByRole("button", { name: "Train model" }));
    await waitFor(() => expect(calls("start_label_training")).toHaveLength(1));
    expect(calls("start_label_training")[0][1].request).not.toHaveProperty("research");
    handlers.get("label-training-event")?.({ payload: { kind: "finished", runId: "r", label: "snap", outcome: "failed", message: "x" } });
    fireEvent.click(await screen.findByRole("checkbox", { name: "Also run research checks" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Train model" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Train model" }));
    await waitFor(() => expect(calls("start_label_training")).toHaveLength(2));
    expect(calls("start_label_training")[1][1].request.research).toBe(true);
  });

  it("draws the trainer's progress reports as a chart and keeps them out of the log", async () => {
    setup();
    choose("snap");
    await screen.findByText(/It will train on/);
    fireEvent.click(screen.getByRole("button", { name: "Train model" }));
    await vi.waitFor(() => expect(handlers.has("label-training-event")).toBe(true));
    const send = (payload: unknown) => act(() => handlers.get("label-training-event")?.({ payload }));
    send({ kind: "started", runId: "run-1", label: "snap", backend: "torch-mlp" });
    send({ kind: "log", runId: "run-1", message: "loading the recordings" });
    for (let epoch = 1; epoch <= 3; epoch += 1) {
      send({ kind: "log", runId: "run-1", message: `@curve ${JSON.stringify({ epoch, epochs: 3, trainLoss: 1 / epoch, evalLoss: 1.1 / epoch, evalAuc: 0.5 + epoch / 10 })}` });
    }
    const progress = await screen.findByRole("region", { name: "Training progress" });
    expect(progress).toHaveTextContent("Round 3 of 3: training loss 0.3333, held-out loss 0.3667");
    expect(screen.getByLabelText("Training log")).toHaveTextContent("loading the recordings");
    expect(screen.getByLabelText("Training log")).not.toHaveTextContent("@curve");
    send({ kind: "started", runId: "run-2", label: "snap", backend: "torch-mlp" }); // a new run starts clean
    expect(screen.queryByRole("region", { name: "Training progress" })).not.toBeInTheDocument();
  });

  it("says a model that was trained but is not good enough was not kept, and what to try", async () => {
    setup();
    await vi.waitFor(() => expect(handlers.has("label-training-event")).toBe(true));
    act(() => handlers.get("label-training-event")?.({ payload: { kind: "finished", runId: "r", label: "snap", outcome: "evaluationOnly", message: "It scored the gesture's windows lower than the others (AUC 0.05)", versionId: null, metrics: { windows: 300, positiveWindows: 135, negativeWindows: 165, precision: 0.4, recall: 1, f1: 0.6, falseActivationRate: 0.99, rocAuc: 0.05, activationThreshold: 0.05 } } }));
    const result = await screen.findByRole("status", { name: "Training result" });
    expect(result).toHaveTextContent("not good enough to keep");
    expect(result).toHaveTextContent("AUC) was 0.05");
    expect(result).toHaveTextContent("Nothing was added to your models");
    expect(result).toHaveTextContent("pulse sensor for finger gestures");
  });

  it("warns when only one recording of the gesture would be trained on", async () => {
    setup({ plan: okPlan });
    choose("snap");
    expect(await screen.findByText(/Only 1 recording with snap to train on/)).toBeInTheDocument();
    cleanup();
    setup({ plan: { ...okPlan, train: ["s1", "s2", "i1"], evaluation: ["i2"] } });
    choose("snap");
    await screen.findByText(/It will train on 3/);
    expect(screen.queryByText(/Only .* recording with snap/)).not.toBeInTheDocument();
  });

  it("shows why a run failed or was cancelled", async () => {
    setup();
    await vi.waitFor(() => expect(handlers.has("label-training-event")).toBe(true));
    act(() => handlers.get("label-training-event")?.({ payload: { kind: "finished", runId: "r", label: "snap", outcome: "failed", message: "only 3 windows of the target label", versionId: null, metrics: null } }));
    expect(await screen.findByRole("status", { name: "Training result" })).toHaveTextContent("only 3 windows of the target label");
    act(() => handlers.get("label-training-event")?.({ payload: { kind: "finished", runId: "r", label: "snap", outcome: "cancelled", message: "You cancelled the training.", versionId: null, metrics: null } }));
    expect(await screen.findByText("Training was cancelled")).toBeInTheDocument();
  });

  it("picks up a run that is already going when the page opens", async () => {
    setup({ status: { running: { runId: "run-9", label: "snap" }, last: null } });
    expect(await screen.findByText("Training…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("shows the reason when training cannot be started", async () => {
    setup();
    choose("snap");
    await screen.findByText(/It will train on/);
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "start_label_training") throw "a model is already being trained";
      return command === "plan_label_training" ? okPlan : { available: true, detail: "" };
    });
    fireEvent.click(screen.getByRole("button", { name: "Train model" }));
    expect(await screen.findByText("a model is already being trained")).toBeInTheDocument();
  });
});
