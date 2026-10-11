import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blankDefinition } from "../../gestureLibrary/definition";
import { telemetryStore } from "../../telemetry/store/telemetryStore";
import type { DatasetLabel, DatasetSummary } from "../types";
import type { ModelTrainingInfo } from "./FineTuneModel";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
const camera = vi.hoisted(() => ({ snapshot: { status: "on", fps: 30, detectMs: 10 } as Record<string, unknown> }));
vi.mock("../../camera/cameraService", () => ({
  getCameraController: () => ({ subscribe: () => () => undefined, getSnapshot: () => camera.snapshot }),
}));
const library = vi.hoisted(() => ({ listGestureDefinitions: vi.fn() }));
vi.mock("../../gestureLibrary/gestureLibraryApi", () => library);
const live = vi.hoisted(() => ({ held: false }));
vi.mock("../../gestureLibrary/useLiveGestures", () => ({
  useLiveGestures: () => (live.held ? new Map([["g1", { held: true, sinceMs: 5 }]]) : new Map()),
}));
vi.mock("../../gestureLibrary/AgreementPanel", () => ({ AgreementPanel: () => <div>agreement tally</div> }));
const exporter = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("../../telemetry/hooks/useTelemetryExport", () => ({ useTelemetryExport: () => ({ saveDatasetRecording: exporter.save }) }));

import { CorrectionSession, backgroundChoices } from "./CorrectionSession";

const info: ModelTrainingInfo = { label: "snap", backend: "torch-mlp", negatives: ["idle", "walk"], excludes: [], datasetIds: ["d1"], trainOnly: [], designId: null };
const label = (id: string, role: DatasetLabel["role"], archivedAt: string | null = null): DatasetLabel => ({ id, displayName: id, description: "", color: "#fff", role, archivedAt });
const labels = [label("snap", "positiveGesture"), label("idle", "negativeBackground"), label("walk", "negativeBackground", "2026-01-01"), label("other", "negativeBackground")];
const gesture = { ...blankDefinition(), id: "g1", name: "Snap", labelId: "snap" };

beforeEach(() => {
  invokeMock.mockReset();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  camera.snapshot = { status: "on", fps: 30, detectMs: 10 };
  live.held = false;
  library.listGestureDefinitions.mockResolvedValue([gesture]);
  exporter.save.mockReset();
  telemetryStore.discardDatasetRecording();
});
afterEach(() => { cleanup(); telemetryStore.discardDatasetRecording(); });

describe("backgroundChoices", () => {
  it("offers only the model's own background labels that are not archived", () => {
    expect(backgroundChoices(info, labels).map((l) => l.id)).toEqual(["idle"]);
  });
});

describe("CorrectionSession", () => {
  it("says why it cannot start: no library gesture, no background label, camera off", async () => {
    library.listGestureDefinitions.mockResolvedValue([]);
    render(<CorrectionSession info={info} labels={labels} status={null} onSaved={() => undefined} />);
    expect(await screen.findByText(/No gesture in the Gesture library uses “snap”/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start recording corrections" })).toBeNull();
    cleanup();
    library.listGestureDefinitions.mockResolvedValue([gesture]);
    render(<CorrectionSession info={{ ...info, negatives: [] }} labels={labels} status={null} onSaved={() => undefined} />);
    expect(await screen.findByText(/not trained with a background label/)).toBeInTheDocument();
    cleanup();
    camera.snapshot = { status: "off", fps: 0, detectMs: 0 };
    render(<CorrectionSession info={info} labels={labels} status={null} onSaved={() => undefined} />);
    expect(await screen.findByText(/Turn the camera on/)).toBeInTheDocument();
  });

  it("records, shows what the camera sees, and on stop saves, adds the recording to the training data and hands it on", async () => {
    exporter.save.mockResolvedValue({ status: "saved", recordingId: "rec-1", rowCount: 100, intervalCount: 2 });
    const made: DatasetSummary = { id: "d9", originalFilename: "rec-1.csv", importedAt: "", label: "snap, idle", labels: ["idle", "snap"], rowCount: 100 };
    invokeMock.mockResolvedValue(made);
    const onSaved = vi.fn();
    render(<CorrectionSession info={info} labels={labels} status={null} onSaved={onSaved} />);
    fireEvent.click(await screen.findByRole("button", { name: "Start recording corrections" }));
    expect(telemetryStore.getDatasetRecording()).toBe(true);
    expect(telemetryStore.getDatasetCaptureMode()).toBe("timeline");
    expect(await screen.findByText("Camera does not see it")).toBeInTheDocument();
    live.held = true;
    fireEvent.click(screen.getByRole("button", { name: "Stop and use it" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(made));
    expect(invokeMock).toHaveBeenCalledWith("add_recording_to_training_data", { recordingId: "rec-1", filter: "notExcluded", restLabel: "idle" });
    expect(await screen.findByText(/ticked below as an extra recording/)).toBeInTheDocument();
    expect(telemetryStore.getDatasetRecording()).toBe(false);
  });

  it("shows why saving failed and hands nothing on", async () => {
    exporter.save.mockResolvedValue({ status: "error", message: "disk full" });
    const onSaved = vi.fn();
    render(<CorrectionSession info={info} labels={labels} status={null} onSaved={onSaved} />);
    fireEvent.click(await screen.findByRole("button", { name: "Start recording corrections" }));
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: "Stop and use it" })); });
    expect(await screen.findByText("disk full")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith("add_recording_to_training_data", expect.anything());
  });

  it("will not start while another recording is in progress", async () => {
    telemetryStore.startDatasetRecording();
    render(<CorrectionSession info={info} labels={labels} status={null} onSaved={() => undefined} />);
    expect(await screen.findByText(/already in progress in the Recorder/)).toBeInTheDocument();
  });
});
