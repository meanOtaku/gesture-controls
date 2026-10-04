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

const okPlan: TrainPlan = { train: ["s1", "i1"], evaluation: ["s2", "i2"], problem: null };

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
      request: { label: "snap", datasetIds: ["s1", "s2", "i1", "i2"], negatives: ["idle", "walking"], excludes: [], backend: "logreg", sources: ["watchAcceleration", "watchGyroscope"] },
    });
  });

  it("sends exactly the choices made: roles, method, streams and recordings", async () => {
    setup();
    choose("snap");
    await screen.findByText(/It will train on/);
    fireEvent.change(screen.getByLabelText("Role of walking"), { target: { value: "exclude" } });
    fireEvent.change(screen.getByLabelText("Method"), { target: { value: "mlp" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Orientation" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Gyroscope" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Use i2.csv" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Train model" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Train model" }));
    await waitFor(() => expect(calls("start_label_training")).toHaveLength(1));
    expect(calls("start_label_training")[0][1]).toEqual({
      request: { label: "snap", datasetIds: ["s1", "s2", "i1"], negatives: ["idle"], excludes: ["walking"], backend: "mlp", sources: ["watchAcceleration", "watchOrientation"] },
    });
  });

  it("will not train when the plan says it cannot, and says why", async () => {
    setup({ plan: { train: [], evaluation: [], problem: "there must be at least two recordings with 'snap'" } });
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
    send({ kind: "finished", runId: "run-1", label: "snap", outcome: "deployable", message: "", versionId: "snap-abc", metrics: { windows: 50, positiveWindows: 20, negativeWindows: 30, precision: 0.9, recall: 0.8, f1: 0.85, falseActivationRate: 0.04, rocAuc: 0.95 } });
    const result = await screen.findByRole("status", { name: "Training result" });
    expect(result).toHaveTextContent("A model for snap was added as a draft");
    expect(result).toHaveTextContent("80% of the 20 windows");
    expect(result).toHaveTextContent("Review it under Label models");
    expect(screen.getByRole("button", { name: "Train model" })).toBeInTheDocument();
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
