import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationState, CalibrationState, Recipe } from "../../../shared/protocol/events";

const library = vi.hoisted(() => ({ listGestureDefinitions: vi.fn() }));
vi.mock("../../gestureLibrary/gestureLibraryApi", () => library);

import { RecipesPage } from "./RecipesPage";

const calibration: CalibrationState = {
  targets: [{ id: "center", name: "Screen center", calibrated: true, builtin: true }],
  requiresRecalibration: false, activationThresholdDegrees: 12, dwellMs: 400, activeTarget: null,
};
const automation = (recipes: Recipe[], unavailableCameras: { recipe: string; gesture: string }[] = []): AutomationState => ({ recipes, blocked: [], conflicts: [], unavailable: [], loadedLabels: [], unavailableCameras });

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  library.listGestureDefinitions.mockResolvedValue([{ id: "gesture-1a2b", name: "Pinch" }]);
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

function setup(recipes: Recipe[] = [], unavailable: { recipe: string; gesture: string }[] = []) {
  const props: React.ComponentProps<typeof RecipesPage> = {
    automation: automation(recipes, unavailable), calibration, pendingRecipeIds: [], onSetEnabled: vi.fn(), onSave: vi.fn().mockResolvedValue(null), onDelete: vi.fn(),
  };
  render(<RecipesPage {...props} />);
  return props;
}

describe("camera gesture steps", () => {
  it("builds a button recipe from a library gesture, offering the once option", async () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: /New recipe/ }));
    const editor = within(screen.getByRole("region", { name: "Recipe editor" }));
    fireEvent.change(editor.getByLabelText("Name"), { target: { value: "Pinch to pause" } });
    fireEvent.change(editor.getByLabelText("Controls"), { target: { value: "playPause" } });
    await waitFor(() => expect(editor.getByRole("button", { name: /Add a camera gesture/ })).toBeEnabled());
    fireEvent.click(editor.getByRole("button", { name: /Add a camera gesture/ }));
    expect(editor.getByLabelText("Step 2 camera gesture")).toHaveValue("gesture-1a2b");
    fireEvent.change(editor.getByLabelText("Step 2 camera timing"), { target: { value: "oneShot" } });
    expect(editor.getByText(/only works while this app is open with its camera on/)).toBeInTheDocument();
    fireEvent.click(editor.getByRole("button", { name: "Save recipe" }));
    await waitFor(() => expect(props.onSave).toHaveBeenCalled());
    expect(vi.mocked(props.onSave).mock.calls[0][0]).toMatchObject({ action: "playPause", stages: [{ kind: "headAt" }, { kind: "camera", gesture: "gesture-1a2b", hold: "oneShot" }] });
  });

  it("offers no camera step until the library has a gesture", async () => {
    library.listGestureDefinitions.mockResolvedValue([]);
    setup();
    fireEvent.click(screen.getByRole("button", { name: /New recipe/ }));
    const editor = within(screen.getByRole("region", { name: "Recipe editor" }));
    expect(editor.getByRole("button", { name: /Add a camera gesture/ })).toBeDisabled();
  });

  it("names the gesture in the recipe and says it is waiting for the camera", async () => {
    const recipe: Recipe = { id: "r", name: "Pinch pause", enabled: true, action: "playPause", stages: [{ kind: "camera", gesture: "gesture-1a2b", hold: "oneShot" }], device: { kind: "rotationKnob", fractionPerDegree: 1 / 300 } };
    setup([recipe], [{ recipe: "r", gesture: "gesture-1a2b" }]);
    expect(await screen.findByText("Waiting for camera: Pinch")).toBeInTheDocument();
    expect(screen.getByText(/Camera “Pinch” \(once\)/)).toBeInTheDocument();
  });
});
