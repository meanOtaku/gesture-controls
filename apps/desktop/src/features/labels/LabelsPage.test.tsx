import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
    const [pinch, fist] = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(fist).toContain("0 recordings · 0 gestures");
    expect(pinch).toContain("1 recording · 1 gesture");
  });
});
