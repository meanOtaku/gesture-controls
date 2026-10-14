import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blankDefinition } from "../../gestureLibrary/definition";
import { telemetryStore } from "../../telemetry/store/telemetryStore";
import type { LabelModel } from "../labelModels";
import type { DatasetLabel, DatasetSummary } from "../types";
import type { ModelTrainingInfo } from "./FineTuneModel";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
const camera = vi.hoisted(() => ({ snapshot: { status: "on", fps: 30, detectMs: 10 } as Record<string, unknown>, enable: vi.fn() }));
vi.mock("../../camera/cameraService", () => ({
  getCameraController: () => ({ subscribe: () => () => undefined, subscribeFrames: () => () => undefined, getSnapshot: () => camera.snapshot, enable: camera.enable }),
}));
const library = vi.hoisted(() => ({ listGestureDefinitions: vi.fn() }));
vi.mock("../../gestureLibrary/gestureLibraryApi", () => library);
const live = vi.hoisted(() => ({ held: false }));
vi.mock("../../gestureLibrary/useLiveGestures", () => ({
  useLiveGestures: () => (live.held ? new Map([["g1", { held: true, sinceMs: 5 }]]) : new Map()),
}));
vi.mock("../../gestureLibrary/AgreementPanel", () => ({ AgreementPanel: ({ candidateId, hideUntilReady }: { candidateId?: string | null; hideUntilReady?: boolean }) => <div>agreement tally {candidateId ?? "alone"}{hideUntilReady ? " (quiet until ready)" : ""}</div> }));
const exporter = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("../../telemetry/hooks/useTelemetryExport", () => ({ useTelemetryExport: () => ({ saveDatasetRecording: exporter.save }) }));

import { CorrectionSession, restChoices, type CorrectionRound } from "./CorrectionSession";

const info: ModelTrainingInfo = { label: "snap", backend: "torch-mlp", negatives: ["idle"], excludes: [], datasetIds: ["d1"], trainOnly: [], designId: null };
const label = (id: string, role: DatasetLabel["role"], archivedAt: string | null = null): DatasetLabel => ({ id, displayName: id, description: "", color: "#fff", role, archivedAt });
const labels = [label("snap", "positiveGesture"), label("idle", "negativeBackground"), label("rest", "negativeBackground"), label("fist", "positiveGesture"), label("old", "negativeBackground", "2026-01-01")];
const gesture = { ...blankDefinition(), id: "g1", name: "Snap", labelId: "snap" };
const model = (id: string, state: LabelModel["state"], active: boolean): LabelModel => ({ id, label: "snap", state, deployable: true, imported: false, modelSha256: "x", createdAt: "", active });
const models = [model("snap-1", "active", true), model("snap-2", "draft", false), model("snap-old", "archived", false)];
const made: DatasetSummary = { id: "d9", originalFilename: "rec-1.csv", importedAt: "", label: "snap, idle", labels: ["idle", "snap"], rowCount: 100 };
let stored: CorrectionRound[] = [];

beforeEach(() => {
  invokeMock.mockReset();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  camera.snapshot = { status: "on", fps: 30, detectMs: 10 };
  camera.enable.mockReset();
  live.held = false;
  stored = [];
  library.listGestureDefinitions.mockResolvedValue([gesture]);
  exporter.save.mockReset();
  invokeMock.mockImplementation(async (command: string) => {
    switch (command) {
      case "list_correction_rounds": return stored;
      case "get_shadow_model": return null;
      case "add_recording_to_training_data": return made;
      default: return undefined;
    }
  });
  telemetryStore.discardDatasetRecording();
});
afterEach(() => { cleanup(); telemetryStore.discardDatasetRecording(); });

const status = { mode: "monitor", loadedLabels: ["snap"], loadFailures: [], quarantined: [], registryError: null, activeDetections: [], lastScores: {} } as never;
const view = (over: Partial<Parameters<typeof CorrectionSession>[0]> = {}) =>
  render(<CorrectionSession info={info} modelId="snap-1" models={models} labels={labels} status={status} onSaved={() => undefined} {...over} />);

describe("restChoices", () => {
  it("offers any label but the one taught, the model's own background first, and not archived ones", () => {
    expect(restChoices(info, labels).map((l) => l.id)).toEqual(["idle", "rest", "fist"]);
    expect(restChoices({ ...info, negatives: ["rest"] }, labels).map((l) => l.id)).toEqual(["rest", "idle", "fist"]); // the model's own background label comes first
  });
});

describe("CorrectionSession", () => {
  it("lists what a round needs, with a button to turn the camera on", async () => {
    camera.snapshot = { status: "off", fps: 0, detectMs: 0 };
    view({ status: null });
    const needs = await screen.findByRole("list", { name: "What a round needs" });
    expect(within(needs).getByText("Camera on")).toBeInTheDocument();
    fireEvent.click(within(needs).getByRole("button", { name: "Turn camera on" }));
    expect(camera.enable).toHaveBeenCalled();
    expect(screen.getByText("Finish the checks above to record.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start recording a round" })).toBeNull();
  });

  it("keeps Stop and Discard while recording when the camera goes off", async () => {
    const page = view();
    fireEvent.click(await screen.findByRole("button", { name: "Start recording a round" }));
    expect(telemetryStore.getDatasetRecording()).toBe(true);
    camera.snapshot = { status: "off", fps: 0, detectMs: 0 };
    page.rerender(<CorrectionSession info={info} modelId="snap-1" models={models} labels={labels} status={status} onSaved={() => undefined} />);
    expect(await screen.findByText(/nothing is being marked now/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop and use it" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(telemetryStore.getDatasetRecording()).toBe(false);
  });

  it("says each missing thing at once, not only the first", async () => {
    library.listGestureDefinitions.mockResolvedValue([]);
    view({ models: [], labels: [label("snap", "positiveGesture")] });
    const needs = await screen.findByRole("list", { name: "What a round needs" });
    await waitFor(() => expect(within(needs).getByText(/none yet, make one in the Gesture library/)).toBeInTheDocument());
    expect(within(needs).getByText(/An active model for this label/)).toBeInTheDocument();
    expect(within(needs).getByText(/make one under Labels/)).toBeInTheDocument();
  });

  it("records a round, saves it with how the active model and the candidate did, and hands the recording on", async () => {
    exporter.save.mockResolvedValue({ status: "saved", recordingId: "rec-1", rowCount: 100, intervalCount: 2 });
    const onSaved = vi.fn();
    view({ onSaved });
    fireEvent.change(await screen.findByLabelText("Run beside the active model"), { target: { value: "snap-2" } });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("start_shadow_model", { id: "snap-2" }));
    expect(await screen.findByText("agreement tally snap-2 (quiet until ready)")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Start recording a round" }));
    expect(telemetryStore.getDatasetRecording()).toBe(true);
    expect(telemetryStore.getDatasetCaptureMode()).toBe("timeline");
    expect(await screen.findByText("Camera does not see it")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop and use it" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(made));
    expect(invokeMock).toHaveBeenCalledWith("add_recording_to_training_data", { recordingId: "rec-1", filter: "notExcluded", restLabel: "idle" });
    const saved = invokeMock.mock.calls.find(([command]) => command === "save_correction_round")?.[1] as { round: { label: string; recordingId: string; active: { modelId: string }; candidate: { modelId: string } } };
    expect(saved.round).toMatchObject({ label: "snap", recordingId: "d9", active: { modelId: "snap-1" }, candidate: { modelId: "snap-2" } });
    expect(await screen.findByText(/Review the plan, then start the fine-tune/)).toBeInTheDocument();
    expect(telemetryStore.getDatasetRecording()).toBe(false);
  });

  it("offers only other models of the label that can run, and warns that a rest label new to the model gets a role later", async () => {
    view();
    const candidate = await screen.findByLabelText("Run beside the active model");
    expect(Array.from((candidate as HTMLSelectElement).options).map((o) => o.value)).toEqual(["", "snap-2"]); // not the active one, not archived
    fireEvent.change(screen.getByLabelText("Label for the rest of the recording"), { target: { value: "rest" } });
    expect(screen.getByText(/not trained with a role for “rest”/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Label for the rest of the recording"), { target: { value: "idle" } });
    expect(screen.queryByText(/not trained with a role for/)).toBeNull();
  });

  it("shows the rounds so far, and stops comparing when the panel closes", async () => {
    stored = [
      { id: "r1", label: "snap", savedAt: "2026-10-12T10:00:00Z", recordingId: "d5", active: { modelId: "snap-1", holds: 6, found: 3, missed: 3, falseAlarms: 5 }, candidate: null },
      { id: "r2", label: "snap", savedAt: "2026-10-12T11:00:00Z", recordingId: "d6", active: { modelId: "snap-1", holds: 6, found: 4, missed: 2, falseAlarms: 3 }, candidate: { modelId: "snap-2", holds: 6, found: 6, missed: 0, falseAlarms: 0 } },
    ];
    const { unmount } = view();
    const table = await screen.findByRole("table", { name: "Correction rounds" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("3/6");
    expect(rows[1]).toHaveTextContent("snap-2: found 6/6, 0 false alarms");
    expect(screen.getByRole("img", { name: /round 2 missed 2 of 6, 3 false alarms/ })).toBeInTheDocument();
    unmount();
    expect(invokeMock).toHaveBeenCalledWith("stop_shadow_model");
  });

  it("shows why saving failed and hands nothing on", async () => {
    exporter.save.mockResolvedValue({ status: "error", message: "disk full" });
    const onSaved = vi.fn();
    view({ onSaved });
    fireEvent.click(await screen.findByRole("button", { name: "Start recording a round" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop and use it" }));
    expect(await screen.findByText("disk full")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith("save_correction_round", expect.anything());
  });

  it("will not start while another recording is in progress", async () => {
    telemetryStore.startDatasetRecording();
    view();
    expect(await screen.findByText(/already in progress in the Recorder/)).toBeInTheDocument();
  });
});
