import * as recordingNames from "../recordingNames";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrainPlan, TrainerEnvironment, TrainingStatus } from "../training";
import type { DatasetLabel, DatasetSummary } from "../types";
import { resetSessionState } from "../hooks/useSessionState";
import { resetTrainingRunStore } from "../hooks/useTrainingRun";
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
const datasets = [{ ...dataset("s1", ["snap"]), group: "New camera labels" }, dataset("s2", ["snap"]), dataset("i1", ["idle", "walking"]), dataset("i2", ["idle"])];

const okPlan: TrainPlan = { train: ["s1", "i1"], evaluation: ["s2", "i2"], problem: null, inputs: 1701 };

function setup(over: { plan?: TrainPlan; environment?: TrainerEnvironment; status?: TrainingStatus; onShowPipeline?: () => void } = {}) {
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "check_label_trainer") return over.environment ?? { available: true, detail: "uv 0.12" };
    if (command === "get_label_training_status") return over.status ?? { running: null, last: null };
    if (command === "plan_label_training") return over.plan ?? okPlan;
    if (command === "start_label_training") return "run-1";
    if (command === "list_training_start_points") return [{ versionId: "snap-v2", name: "Snap v2", createdAt: "2026-11-15T10:00:00Z", trainedOn: ["s1", "i1"], missing: 1 }];
    return undefined;
  });
  render(<TrainPanel desktopAvailable labels={labels} datasets={datasets} onShowPipeline={over.onShowPipeline} />);
}

const calls = (command: string) => invokeMock.mock.calls.filter(([name]) => name === command);
const NAMES: Record<string, string> = { snap: "Snap", idle: "Idle" };
/** Ticks a gesture in the Gestures to teach dropdown, and closes it. */
const choose = (id: string) => {
  fireEvent.click(screen.getByRole("button", { name: "Gestures to teach" }));
  fireEvent.click(within(screen.getByRole("listbox", { name: "Gestures to teach" })).getByRole("option", { name: NAMES[id] ?? id }));
  fireEvent.keyDown(document, { key: "Escape" });
};

beforeEach(() => { invokeMock.mockReset(); handlers.clear(); resetTrainingRunStore(); resetSessionState(); });
afterEach(cleanup);

describe("TrainPanel", () => {
  it("offers only labels that are not archived, and nothing else until one is chosen", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Gestures to teach" }));
    const list = screen.getByRole("listbox", { name: "Gestures to teach" });
    expect(within(list).getByRole("option", { name: "Snap" })).toBeInTheDocument();
    expect(within(list).queryByRole("option", { name: "Old" })).not.toBeInTheDocument();
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
      request: { label: "snap", datasetIds: ["s1", "s2", "i1", "i2"], negatives: ["idle", "walking"], excludes: [], method: "ppg-imu-cnn" },
    });
  });

  it("shows the dataset group beside each training recording", async () => {
    setup();
    choose("snap");
    const recordings = screen.getByRole("list", { name: "Recordings to use" });
    const rows = within(recordings).getAllByRole("listitem");
    expect(within(rows[0]).getByLabelText("Dataset group: New camera labels")).toHaveTextContent("Group: New camera labels");
    expect(within(rows[1]).getByLabelText("Dataset group: Ungrouped")).toHaveTextContent("Group: Ungrouped");
    expect(within(rows[0]).getByRole("checkbox")).toBeChecked();
  });

  it("does not rebuild the recording list for training log updates", async () => {
    const title = vi.spyOn(recordingNames, "recordingTitle");
    setup({ plan: { train: [], evaluation: [], problem: "Pick more recordings", inputs: 1701 } });
    choose("snap");
    await screen.findByText("Pick more recordings");
    title.mockClear();
    act(() => handlers.get("label-training-event")?.({ payload: { kind: "log", runId: "r", message: "Training progress" } }));
    expect(title).not.toHaveBeenCalled();
    title.mockRestore();
  });

  it("coalesces rapid recording choices into one plan request", async () => {
    setup();
    choose("snap");
    fireEvent.click(screen.getByRole("checkbox", { name: "Use s2.csv" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Use i2.csv" }));
    await screen.findByText(/It will train on/);
    expect(calls("plan_label_training")).toHaveLength(1);
    expect(calls("plan_label_training")[0][1]).toEqual(expect.objectContaining({ request: expect.objectContaining({ datasetIds: ["s1", "i1"] }) }));
  });

  it("sends the roles and the recordings, and nothing about the model when it is the trees", async () => {
    setup();
    choose("snap");
    await screen.findByText(/It will train on/);
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "ppg-onset-trees" } });
    expect(screen.getByRole("region", { name: "The model" })).toHaveTextContent("PPG + IMU gesture-start model");
    fireEvent.change(screen.getByLabelText("Role of walking"), { target: { value: "exclude" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Use i2.csv" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Train model" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Train model" }));
    await waitFor(() => expect(calls("start_label_training")).toHaveLength(1));
    expect(calls("start_label_training")[0][1]).toEqual({
      request: { label: "snap", datasetIds: ["s1", "s2", "i1"], negatives: ["idle"], excludes: ["walking"] },
    });
  });

  it("will not train when the plan says it cannot, and says why", async () => {
    setup({ plan: { train: [], evaluation: [], problem: "there must be at least two recordings with 'snap'", inputs: 1701 } });
    choose("snap");
    expect(await screen.findByText(/at least two recordings with 'snap'/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Train model" })).toBeDisabled();
  });

  it("will not train without the trainer", async () => {
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
    send({ kind: "started", runId: "run-1", label: "snap", backend: "ppg-onset-trees" });
    send({ kind: "log", runId: "run-1", message: "downloading scikit-learn" });
    expect(await screen.findByLabelText("Training log")).toHaveTextContent("downloading scikit-learn");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(calls("cancel_label_training")).toHaveLength(1));
    send({ kind: "finished", runId: "run-1", label: "snap", outcome: "deployable", message: "", versionId: "snap-abc", metrics: { windows: 50, positiveWindows: 20, negativeWindows: 30, precision: 0.9, recall: 0.8, f1: 0.85, falseActivationRate: 0.04, rocAuc: 0.95, activationThreshold: 0.6 } });
    const result = await screen.findByRole("status", { name: "Training result" });
    expect(result).toHaveTextContent("A model for snap was added as a draft");
    expect(result).toHaveTextContent("80% of the 20 gesture starts");
    expect(result).toHaveTextContent("chosen using those same test recordings");
    expect(result).toHaveTextContent("Review it under Label models");
    expect(screen.getByRole("button", { name: "Train model" })).toBeInTheDocument();
  });

  it("trains the CNN by default, and describes it", async () => {
    setup();
    choose("snap");
    await screen.findByText(/It will train on/);
    expect(screen.getByLabelText("Model")).toHaveValue("ppg-imu-cnn");
    expect(screen.getByRole("region", { name: "The model" })).toHaveTextContent("CNN gesture-start model");
    expect(screen.getByRole("region", { name: "The model" })).toHaveTextContent(/leave Settings → Gestures → Still hand off/);
    await waitFor(() => expect(calls("plan_label_training").at(-1)?.[1].request.method).toBe("ppg-imu-cnn"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Train model" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Train model" }));
    await waitFor(() => expect(calls("start_label_training")).toHaveLength(1));
    expect(calls("start_label_training")[0][1].request.method).toBe("ppg-imu-cnn");
  });

  it("says each model in one line, with the rest under About this model, and groups the trees as older", async () => {
    setup();
    choose("snap");
    await screen.findByText(/It will train on/);
    const model = within(screen.getByRole("region", { name: "The model" }));
    expect(model.getByText(/Fires about 0\.5 s after a gesture starts/)).toBeInTheDocument();
    const about = model.getByText("About this model").closest("details");
    expect(about).not.toHaveAttribute("open");
    expect(about).toHaveTextContent(/Three small convolutional networks/);
    expect(screen.getByRole("group", { name: "Older" })).toHaveTextContent("(trees)");
  });

  it("folds the options, and names the ones that are on", async () => {
    setup();
    choose("snap");
    await screen.findByText(/It will train on/);
    const summary = screen.getByText("Options", { selector: ".advanced-title" }).parentElement!;
    expect(summary).toHaveTextContent(/none on/);
    fireEvent.click(screen.getByRole("checkbox", { name: "Learn from its own false alarms" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Also run research checks" }));
    expect(summary).toHaveTextContent("On: learning from its false alarms, research checks");
  });

  it("asks for research checks only when ticked", async () => {
    setup();
    choose("snap");
    await screen.findByText(/It will train on/);
    fireEvent.click(screen.getByRole("button", { name: "Train model" }));
    await waitFor(() => expect(calls("start_label_training")).toHaveLength(1));
    expect(calls("start_label_training")[0][1].request).not.toHaveProperty("research");
    fireEvent.click(screen.getByRole("checkbox", { name: "Also run research checks" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Train model" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Train model" }));
    await waitFor(() => expect(calls("start_label_training")).toHaveLength(2));
    expect(calls("start_label_training")[1][1].request.research).toBe(true);
  });

  it("points to how the model works", async () => {
    const onOpen = vi.fn();
    setup({ onShowPipeline: onOpen });
    fireEvent.click(await screen.findByRole("button", { name: "See how it works" }));
    expect(onOpen).toHaveBeenCalled();
  });

  it("says a model that did not pass the checks for going live was kept to run in Monitor only", async () => {
    setup();
    await vi.waitFor(() => expect(handlers.has("label-training-event")).toBe(true));
    act(() => handlers.get("label-training-event")?.({ payload: { kind: "finished", runId: "r", label: "snap", outcome: "monitorOnly", message: "Replayed over the held-out recordings it fired 40 times without the gesture", versionId: "snap-abc", metrics: { windows: 300, positiveWindows: 40, negativeWindows: 260, precision: 0.4, recall: 0.7, f1: 0.5, falseActivationRate: 0.08, rocAuc: 0.84, activationThreshold: 0.6 } } }));
    const result = await screen.findByRole("status", { name: "Training result" });
    expect(result).toHaveTextContent("can only run in Monitor");
    expect(result).toHaveTextContent("fired 40 times without the gesture");
    expect(result).toHaveTextContent("never start a recipe");
  });

  it("warns when only one recording of the gesture would be trained on", async () => {
    setup({ plan: okPlan });
    choose("snap");
    expect(await screen.findByText(/Only 1 recording with snap to train on/)).toBeInTheDocument();
    cleanup();
    resetSessionState();
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

describe("TrainPanel training plan", () => {
  const stagedPlan: TrainPlan = { ...okPlan, stages: [{ name: "Recordings with snap", train: ["s1"], heldOut: ["s2"] }, { name: "Everything else", train: ["i1"], heldOut: ["i2"] }] };

  it("offers stages only for the CNN, starts from the label's recordings then the rest, and sends the plan", async () => {
    setup({ plan: stagedPlan });
    choose("snap");
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "ppg-onset-trees" } });
    expect(screen.queryByRole("checkbox", { name: "Train in stages" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "ppg-imu-cnn" } });
    fireEvent.click(await screen.findByRole("checkbox", { name: "Train in stages" }));
    const stages = screen.getByRole("list", { name: "Training stages" });
    expect(within(stages).getAllByRole("listitem", { name: /^Stage \d$/ })).toHaveLength(2);
    expect(screen.getByLabelText("Name of stage 1")).toHaveValue("Recordings with snap");
    await waitFor(() => expect(calls("plan_label_training").at(-1)?.[1]).toMatchObject({
      request: { method: "ppg-imu-cnn", stages: [
        { name: "Recordings with snap", datasetIds: ["s1", "s2"], rehearse: true },
        { name: "Everything else", datasetIds: ["i1", "i2"], rehearse: true },
      ] },
    }));
    expect(await screen.findByText(/Recordings with snap: trains on s1.csv; s2.csv is held out for testing/)).toBeInTheDocument();
  });

  it("edits a plan: adds a stage, fills it, sets its passes and rehearsal, and reorders", async () => {
    setup({ plan: stagedPlan });
    choose("snap");
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "ppg-imu-cnn" } });
    fireEvent.click(await screen.findByRole("checkbox", { name: "Train in stages" }));
    fireEvent.click(screen.getByRole("button", { name: "Add a stage" }));
    expect(screen.getByText("This stage has no recordings yet.")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "All with snap" })[2]);
    fireEvent.change(screen.getByLabelText("Passes in stage 3"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Rehearse earlier stages in stage 3" }));
    fireEvent.click(screen.getByRole("button", { name: "Move stage 3 up" }));
    await waitFor(() => expect(calls("plan_label_training").at(-1)?.[1].request.stages[1]).toEqual(
      { name: "Stage 3", datasetIds: ["s1", "s2"], rehearse: false, epochs: 4 },
    ));
    fireEvent.click(screen.getByRole("button", { name: "Remove stage 2" }));
    expect(within(screen.getByRole("list", { name: "Training stages" })).getAllByRole("listitem", { name: /^Stage \d$/ })).toHaveLength(2);
  });

  it("names chosen recordings no stage uses", async () => {
    setup({ plan: stagedPlan });
    choose("snap");
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "ppg-imu-cnn" } });
    fireEvent.click(await screen.findByRole("checkbox", { name: "Train in stages" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "i2.csv in stage 2" }));
    expect(screen.getByRole("note")).toHaveTextContent("Not in any stage: i2.csv");
  });

  it("shows each stage what the stages before it used, by their names, and whether it rehearses them", async () => {
    setup({ plan: stagedPlan });
    choose("snap");
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "ppg-imu-cnn" } });
    fireEvent.click(await screen.findByRole("checkbox", { name: "Train in stages" }));
    expect(screen.queryByRole("region", { name: "From earlier stages, stage 1" })).toBeNull();
    const second = screen.getByRole("region", { name: "From earlier stages, stage 2" });
    expect(second).toHaveTextContent("s1.csv in “Recordings with snap” (stage 1) · not in this stage");
    expect(second).toHaveTextContent("s2.csv in “Recordings with snap” (stage 1) · not in this stage");
    expect(second).toHaveTextContent("This stage rehearses them");
    fireEvent.click(screen.getByRole("checkbox", { name: "Rehearse earlier stages in stage 2" }));
    expect(second).toHaveTextContent("Not rehearsed: this stage trains only on its own recordings");
    // Renaming a stage shows at once in the stages after it.
    fireEvent.change(screen.getByLabelText("Name of stage 1"), { target: { value: "Pinches" } });
    expect(second).toHaveTextContent("s1.csv in “Pinches” (stage 1)");
    // A third stage with s1 again: selected here too; i1 from stage 2 is not; the rows say who used them.
    fireEvent.click(screen.getByRole("button", { name: "Add a stage" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "s1.csv in stage 3" }));
    const third = screen.getByRole("region", { name: "From earlier stages, stage 3" });
    expect(third).toHaveTextContent("s1.csv in “Pinches” (stage 1) · selected here too");
    expect(third).toHaveTextContent("i1.csv in “Everything else” (stage 2) · not in this stage");
    const rows = within(screen.getByRole("list", { name: "Recordings in stage 3" }));
    expect(rows.getAllByText(/used in “Everything else” \(stage 2\)/)).toHaveLength(2); // i1 and i2
    expect(rows.getAllByText(/used in “Pinches” \(stage 1\)/)).toHaveLength(2); // s1 and s2
  });

  it("names what a rehearsing stage brings back in the plan preview", async () => {
    setup({ plan: stagedPlan });
    choose("snap");
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "ppg-imu-cnn" } });
    fireEvent.click(await screen.findByRole("checkbox", { name: "Train in stages" }));
    expect(await screen.findByText(/Everything else: trains on i1.csv, rehearsing s1.csv from earlier stages; i2.csv is held out for testing/)).toBeInTheDocument();
  });

  it("keeps the choices and the whole log when its tab is left during training and opened again", async () => {
    setup();
    choose("snap");
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "ppg-imu-cnn" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Use i2.csv" }));
    await waitFor(() => expect(handlers.has("label-training-event")).toBe(true));
    act(() => handlers.get("label-training-event")!({ payload: { kind: "started", runId: "run-1", label: "snap", backend: "ppg-imu-cnn" } }));
    act(() => handlers.get("label-training-event")!({ payload: { kind: "log", runId: "run-1", message: "Stage 1 of 2" } }));
    cleanup(); // the tab is left: the panel is gone
    act(() => handlers.get("label-training-event")!({ payload: { kind: "log", runId: "run-1", message: "Stage 2 of 2" } }));
    render(<TrainPanel desktopAvailable labels={labels} datasets={datasets} />);
    expect(screen.getByRole("button", { name: "Gestures to teach" })).toHaveTextContent("Snap");
    expect(screen.getByLabelText("Model")).toHaveValue("ppg-imu-cnn");
    expect(screen.getByRole("checkbox", { name: "Use i2.csv" })).not.toBeChecked();
    expect(await screen.findByText(/Stage 1 of 2/)).toBeInTheDocument();
    expect(screen.getByText(/Stage 2 of 2/)).toBeInTheDocument(); // sent while it was away
  });

  it("continues a CNN v2 from one you have, choosing what it trained on again, and only for CNN v2", async () => {
    setup();
    choose("snap");
    expect(screen.queryByLabelText("Start from")).toBeNull();
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "ppg-imu-cnn-v2" } });
    const startFrom = await screen.findByLabelText("Start from");
    await within(startFrom).findByRole("option", { name: "Continue training Snap v2" });
    expect(calls("list_training_start_points").at(-1)?.[1]).toEqual({ label: "snap" });
    // Leave out one it trained on, then continue: it comes back.
    fireEvent.click(screen.getByRole("checkbox", { name: "Use s1.csv" }));
    fireEvent.change(startFrom, { target: { value: "snap-v2" } });
    expect(screen.getByRole("checkbox", { name: "Use s1.csv" })).toBeChecked();
    expect(screen.getByText(/The 2 recordings it trained on are chosen again/)).toHaveTextContent("1 of the recordings it trained on are no longer in Model Lab");
    await waitFor(() => expect(calls("plan_label_training").at(-1)?.[1]).toMatchObject({ request: { method: "ppg-imu-cnn-v2", startFrom: "snap-v2" } }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Use i1.csv" }));
    expect(screen.getByText(/1 of the recordings it trained on are not chosen: it may forget/)).toBeInTheDocument();
    // Another model kind never continues.
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "ppg-imu-cnn" } });
    await waitFor(() => expect(calls("plan_label_training").at(-1)?.[1]).not.toHaveProperty("request.startFrom"));
  });

  it("learns several ticked gestures in one CNN v2, switching to it, with no role for them, and never continues one", async () => {
    setup();
    choose("snap");
    expect(screen.getByLabelText("Model")).toHaveValue("ppg-imu-cnn");
    choose("idle");
    expect(screen.getByLabelText("Model")).toHaveValue("ppg-imu-cnn-v2");
    expect(screen.getByRole("button", { name: "Gestures to teach" })).toHaveTextContent("SnapIdle");
    expect(screen.queryByLabelText("Role of idle")).toBeNull();
    expect(screen.queryByLabelText("Start from")).toBeNull();
    expect(screen.getByText(/One network learns snap, idle together/)).toBeInTheDocument();
    await waitFor(() => expect(calls("plan_label_training").at(-1)?.[1]).toEqual({
      request: { label: "snap", datasetIds: ["s1", "s2", "i1", "i2"], negatives: ["walking"], excludes: [], method: "ppg-imu-cnn-v2", gestures: ["idle"] },
    }));
    // Another model learns one gesture, and says so.
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "ppg-imu-cnn" } });
    await waitFor(() => expect(calls("plan_label_training").at(-1)?.[1]).not.toHaveProperty("request.gestures"));
    expect(screen.getByText(/Only CNN v2 learns several gestures in one model/)).toBeInTheDocument();
    // Unticking the first makes the next one the target.
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "ppg-imu-cnn-v2" } });
    choose("snap");
    await waitFor(() => expect(calls("plan_label_training").at(-1)?.[1]).toMatchObject({ request: { label: "idle" } }));
    expect(calls("plan_label_training").at(-1)?.[1]).not.toHaveProperty("request.gestures");
  });

  it("names each gesture's model and shows the confusion matrices when a multi-gesture model is trained", async () => {
    setup();
    choose("snap");
    await screen.findByText(/It will train on/);
    fireEvent.click(screen.getByRole("button", { name: "Train model" }));
    await vi.waitFor(() => expect(handlers.has("label-training-event")).toBe(true));
    act(() => handlers.get("label-training-event")?.({ payload: { kind: "finished", runId: "run-1", label: "snap", outcome: "deployable", message: "", versionId: "snap-1",
      metrics: { windows: 50, positiveWindows: 20, negativeWindows: 30, precision: 0.9, recall: 0.8, f1: 0.85, falseActivationRate: 0.04, rocAuc: 0.95, activationThreshold: 0.97 },
      gestures: [{ label: "snap", outcome: "deployable", message: "", versionId: "snap-1" }, { label: "idle", outcome: "monitorOnly", message: "too few", versionId: "idle-1" }],
      confusion: {
        events: { gestures: ["snap", "idle"], rows: [{ gesture: "snap", starts: 10, caughtBy: { snap: 9, idle: 1 }, missed: 1 }, { gesture: "idle", starts: 8, caughtBy: { snap: 0, idle: 7 }, missed: 1 }],
          noGesture: { falseActivations: { snap: 2, idle: 0 }, hours: { snap: 0.5, idle: 0.5 }, falseActivationsPerHour: { snap: 4, idle: 0 } } },
        moments: { labels: ["nothing", "snap", "idle"], counts: [[900, 3, 1], [2, 18, 0], [1, 0, 15]] },
      } } }));
    const result = await screen.findByRole("status", { name: "Training result" });
    expect(result).toHaveTextContent("snap: added as a draft; idle: added as a draft that can only run in Monitor");
    const live = within(result).getByRole("table", { name: "Gestures caught as each gesture, played through live" });
    expect(live).toHaveTextContent("snap1091");
    expect(live).toHaveTextContent("No gesture30 min2 (about 4 an hour)0");
    const moments = within(result).getByRole("table", { name: "Each held-out moment by what it is and what the model said" });
    expect(moments).toHaveTextContent("a start of snap2180");
  });

  it("puts a continued model next to the one it began from, on the same test recordings", async () => {
    setup();
    choose("snap");
    await screen.findByText(/It will train on/);
    fireEvent.click(screen.getByRole("button", { name: "Train model" }));
    await vi.waitFor(() => expect(handlers.has("label-training-event")).toBe(true));
    const events = (caught: number, falseActivations: number, perHour: number) => ({ recordings: 2, gestures: 10, caught, gestureRecall: caught / 10, repeats: 0, medianLatencyMs: 300, falseActivations, negativeSeconds: 3600, falseActivationsPerHour: perHour });
    act(() => handlers.get("label-training-event")?.({ payload: { kind: "finished", runId: "run-1", label: "snap", outcome: "deployable", message: "", versionId: "snap-new",
      metrics: { windows: 50, positiveWindows: 20, negativeWindows: 30, precision: 0.9, recall: 0.8, f1: 0.85, falseActivationRate: 0.04, rocAuc: 0.95, activationThreshold: 0.97,
        events: events(9, 2, 2), startedFrom: { name: "Snap v2", threshold: 0.99, events: events(7, 21, 21) } } } }));
    const table = await screen.findByRole("table", { name: "The new model and Snap v2 on the same test recordings" });
    expect(table).toHaveTextContent("Gestures caught7 of 109 of 10");
    expect(table).toHaveTextContent("False alarms21 (about 21 an hour)2 (about 2 an hour)");
    expect(table).toHaveTextContent("Cut-off0.990.97");
  });

  it("names the label being trained when the run is already going and nothing was chosen here", async () => {
    setup({ status: { running: { runId: "run-9", label: "pinch_out" }, last: null } });
    expect(await screen.findByRole("status", { name: "Run in progress" })).toHaveTextContent("Training a model for pinch_out.");
  });
});
