import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatasetLabel, DatasetSummary } from "../types";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const api = vi.hoisted(() => ({ onRecordingsChanged: vi.fn(), listRecordingBundles: vi.fn() }));
vi.mock("../../../shared/tauri/recordingBundle", () => api);

import { RecorderRecordings, eligibleIntervals } from "./RecorderRecordings";

const bundle = (recordingId: string, approvedCount: number, unreviewedCount: number) => ({
  recordingId, rawRowCount: 100, intervalCount: approvedCount + unreviewedCount, actualDurationMs: 12000, stopReason: "manual_stop",
  labelIds: ["pinch"], unreviewedCount, approvedCount, excludedCount: 0, isImported: false,
});
const label = (id: string, role: DatasetLabel["role"]): DatasetLabel => ({ id, displayName: id, description: "", color: "#65e6ff", role, archivedAt: null });

beforeEach(() => {
  invoke.mockReset();
  api.onRecordingsChanged.mockReturnValue(() => undefined);
  invoke.mockResolvedValue({ id: "d1", rowCount: 40, labels: ["idle", "pinch"] });
  api.listRecordingBundles.mockResolvedValue({ status: "ok", value: [bundle("aaaaaaaa-1", 0, 2), bundle("bbbbbbbb-2", 0, 0)] });
});
afterEach(() => cleanup());

describe("eligibleIntervals", () => {
  it("counts unreviewed intervals only when they are allowed", () => {
    expect(eligibleIntervals({ approvedCount: 2, unreviewedCount: 3 }, "notExcluded")).toBe(5);
    expect(eligibleIntervals({ approvedCount: 2, unreviewedCount: 3 }, "approvedOnly")).toBe(2);
  });
});

describe("RecorderRecordings", () => {
  it("adds a recording with the chosen filter and background label, and says what was added", async () => {
    const onAdded = vi.fn();
    render(<RecorderRecordings desktopAvailable labels={[label("idle", "negativeBackground"), label("pinch", "positiveGesture")]} datasets={[]} onAdded={onAdded} />);
    const buttons = await screen.findAllByRole("button", { name: "Add to training data" });
    expect(buttons[0]).toBeEnabled();
    expect(buttons[1]).toBeDisabled(); // no labelled intervals
    fireEvent.change(screen.getByLabelText("Label everything else as"), { target: { value: "idle" } });
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("add_recording_to_training_data", { recordingId: "aaaaaaaa-1", filter: "notExcluded", restLabel: "idle" }));
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
  });

  it("disables an unreviewed-only recording when only approved intervals are allowed, and marks recordings already added", async () => {
    render(<RecorderRecordings desktopAvailable labels={[]} datasets={[{ id: "d", originalFilename: "x", importedAt: "", label: "pinch", rowCount: 1, sourceRecordingId: "aaaaaaaa-1" } as DatasetSummary]} onAdded={vi.fn()} />);
    await screen.findAllByRole("button", { name: "Add to training data" });
    expect(screen.getByText("Added")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Intervals to use"), { target: { value: "approvedOnly" } });
    expect(screen.getAllByRole("button", { name: "Add to training data" })[0]).toBeDisabled();
  });

  it("shows the desktop's refusal, such as an unchanged recording added twice", async () => {
    invoke.mockRejectedValue("this recording was already added with the same labelled rows, so nothing changed");
    render(<RecorderRecordings desktopAvailable labels={[]} datasets={[]} onAdded={vi.fn()} />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Add to training data" }))[0]);
    expect(await screen.findByRole("alert")).toHaveTextContent("already added");
  });
});
