import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

import { LabelsPage } from "./LabelsPage";

const label = (id: string, displayName: string) => ({ id, displayName, description: "", color: "#65e6ff", role: "positiveGesture", archivedAt: null });

beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
  invoke.mockImplementation(async (command: string) => {
    switch (command) {
      case "list_model_labels": return [label("pinch", "Pinch"), label("fist", "Fist")];
      case "list_model_datasets": return [{ id: "d1", originalFilename: "a.csv", importedAt: "", label: "pinch", rowCount: 5 }];
      case "list_gesture_definitions": return [{ id: "g1", name: "Pinch", labelId: "pinch" }];
      case "list_recording_bundles": return [{ recordingId: "r1", labelIds: ["pinch"], rawRowCount: 1, intervalCount: 1, actualDurationMs: 1, stopReason: "manual_stop", unreviewedCount: 1, approvedCount: 0, excludedCount: 0, isImported: false }];
      case "get_automation_state": return { recipes: [{ id: "r", name: "Pinch pause", stages: [{ kind: "model", label: "pinch", hold: "oneShot" }] }] };
      case "list_label_models": return [];
      case "get_label_runtime_status": return { mode: "off", loadedLabels: [], loadFailures: [], quarantined: [], registryError: null, activeDetections: [], lastScores: {} };
      default: throw new Error(`unexpected ${command}`);
    }
  });
});
afterEach(() => { cleanup(); delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__; });

describe("LabelsPage", () => {
  it("lists every label with the recordings and gestures that use it", async () => {
    render(<LabelsPage />);
    const rowsOf = () => [...(screen.queryByRole("list", { name: "Labels" })?.children ?? [])] as HTMLElement[];
    await waitFor(() => expect(rowsOf()).toHaveLength(2));
    const [pinch, fist] = rowsOf().map((li) => li.textContent ?? "");
    expect(fist).toContain("0 in Recorder recordings · 0 in the training data · 0 gestures");
    expect(pinch).toContain("1 in Recorder recordings · 1 in the training data · 1 gesture");
  });

  it("lists, for a label, every place it is used with a way to open that tab", async () => {
    const onOpen = vi.fn();
    render(<LabelsPage onOpen={onOpen} />);
    const usage = await screen.findByRole("list", { name: "Where pinch is used" });
    expect(usage.textContent).toContain("Gesture library: Pinch");
    expect(usage.textContent).toContain("Recorder recordings: r1");
    expect(usage.textContent).toContain("Training data: a.csv");
    expect(usage.textContent).toContain("Recipes: Pinch pause");
    fireEvent.click(within(usage).getByRole("button", { name: "Open Recipes" }));
    expect(onOpen).toHaveBeenCalledWith("recipes");
    expect(screen.queryByRole("list", { name: "Where fist is used" })).toBeNull();
  });
});
