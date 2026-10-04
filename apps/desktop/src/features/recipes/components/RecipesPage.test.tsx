import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutomationState, CalibrationState, Recipe } from "../../../shared/protocol/events";
import { RecipesPage } from "./RecipesPage";

afterEach(cleanup);

const calibration: CalibrationState = {
  targets: [
    { id: "center", name: "Screen center", calibrated: true, builtin: true },
    { id: "topRight", name: "Top right", calibrated: true, builtin: false },
    { id: "leftEdge", name: "Left edge", calibrated: true, builtin: false },
  ],
  requiresRecalibration: false,
  activationThresholdDegrees: 12,
  dwellMs: 400,
  activeTarget: null,
};

const stem: Recipe = {
  id: "lookStemVolume",
  name: "Look top right, hold STEM, roll",
  enabled: true,
  action: "volume",
  stages: [
    { kind: "headAt", location: "topRight" },
    { kind: "hold", hold: "stemButton" },
    { kind: "drive", axis: "roll", deadZoneDegrees: 3, invert: false },
  ],
  device: { kind: "rotationKnob", fractionPerDegree: 1 / 300 },
};

const automation = (recipes: Recipe[] = [stem]): AutomationState => ({ recipes, blocked: [], conflicts: [] });

function setup(overrides: Partial<React.ComponentProps<typeof RecipesPage>> = {}) {
  const props: React.ComponentProps<typeof RecipesPage> = {
    automation: automation(),
    calibration,
    isPending: () => false,
    onSetEnabled: vi.fn(),
    onSave: vi.fn().mockResolvedValue(null),
    onDelete: vi.fn(),
    ...overrides,
  };
  render(<RecipesPage {...props} />);
  return props;
}

describe("RecipesPage", () => {
  it("lists recipes with what each does, and switches one on or off", () => {
    const props = setup();
    expect(screen.getByText("Look at Top right → Hold STEM button → Roll wrist → rotation knob → Volume")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Look top right, hold STEM, roll on" }));
    expect(props.onSetEnabled).toHaveBeenCalledWith("lookStemVolume", false);
  });

  it("builds a new recipe from steps, a wrist axis and a device, and saves it", async () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: /New recipe/ }));
    const editor = within(screen.getByRole("region", { name: "Recipe editor" }));

    // Saving without a name is refused, in words.
    fireEvent.click(editor.getByRole("button", { name: "Save recipe" }));
    expect(editor.getByText("Give the recipe a name.")).toBeInTheDocument();
    expect(props.onSave).not.toHaveBeenCalled();

    fireEvent.change(editor.getByLabelText("Name"), { target: { value: "Pinch scroll" } });
    fireEvent.change(editor.getByLabelText("Step 1 location"), { target: { value: "leftEdge" } });
    fireEvent.click(editor.getByRole("button", { name: /Hold a gesture/ }));
    fireEvent.change(editor.getByLabelText("Step 2 gesture"), { target: { value: "pinch" } });
    fireEvent.click(editor.getByRole("radio", { name: /Pitch/ }));
    fireEvent.change(editor.getByLabelText("Device"), { target: { value: "stepKnob" } });
    fireEvent.change(editor.getByLabelText("Points per step"), { target: { value: "10" } });
    fireEvent.click(editor.getByRole("switch", { name: /Reverse direction/ }));
    fireEvent.click(editor.getByRole("button", { name: "Save recipe" }));

    await waitFor(() => expect(props.onSave).toHaveBeenCalledTimes(1));
    expect(props.onSave).toHaveBeenCalledWith({
      id: "",
      name: "Pinch scroll",
      enabled: false,
      action: "volume",
      stages: [
        { kind: "headAt", location: "leftEdge" },
        { kind: "hold", hold: "pinch" },
        { kind: "drive", axis: "pitch", deadZoneDegrees: 3, invert: true },
      ],
      device: { kind: "stepKnob", degreesPerStep: 15, fractionPerStep: 0.1 },
    });
    // The editor closes once the save succeeds.
    await waitFor(() => expect(screen.queryByRole("region", { name: "Recipe editor" })).not.toBeInTheDocument());
  });

  it("edits an existing recipe in place, keeping its id and whether it is on", async () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: "Edit Look top right, hold STEM, roll" }));
    const editor = within(screen.getByRole("region", { name: "Recipe editor" }));
    expect(editor.getByLabelText("Step 1 location")).toHaveValue("topRight");
    expect(editor.getByLabelText("Sensitivity")).toHaveValue(0.3333);
    fireEvent.change(editor.getByLabelText("Name"), { target: { value: "STEM volume" } });
    fireEvent.click(editor.getByRole("button", { name: "Save recipe" }));
    await waitFor(() => expect(props.onSave).toHaveBeenCalled());
    const saved = vi.mocked(props.onSave).mock.calls[0][0];
    expect(saved).toMatchObject({ id: "lookStemVolume", name: "STEM volume", enabled: true });
    // An untouched number keeps its exact stored value, not the rounded text shown for it.
    expect(saved.device).toEqual({ kind: "rotationKnob", fractionPerDegree: 1 / 300 });
  });

  it("keeps the editor open and shows the backend's reason when a save fails", async () => {
    setup({ onSave: vi.fn().mockResolvedValue("the location 'x' does not exist") });
    fireEvent.click(screen.getByRole("button", { name: "Edit Look top right, hold STEM, roll" }));
    fireEvent.click(screen.getByRole("button", { name: "Save recipe" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("the location 'x' does not exist");
    expect(screen.getByRole("region", { name: "Recipe editor" })).toBeInTheDocument();
  });

  it("will not save a repeated step or an invalid number, and says why", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: "Edit Look top right, hold STEM, roll" }));
    const editor = within(screen.getByRole("region", { name: "Recipe editor" }));
    fireEvent.click(editor.getByRole("button", { name: /Hold a gesture/ }));
    fireEvent.change(editor.getByLabelText("Step 3 gesture"), { target: { value: "stemButton" } });
    expect(editor.getByRole("alert")).toHaveTextContent("The same step is used twice");
    fireEvent.click(editor.getByRole("button", { name: "Save recipe" }));
    expect(props.onSave).not.toHaveBeenCalled();

    fireEvent.click(editor.getByRole("button", { name: "Remove step 3" }));
    const deadZone = editor.getByLabelText("Dead zone");
    fireEvent.change(deadZone, { target: { value: "120" } });
    fireEvent.blur(deadZone);
    fireEvent.click(editor.getByRole("button", { name: "Save recipe" }));
    expect(props.onSave).not.toHaveBeenCalled();
    expect(deadZone).toHaveAttribute("aria-invalid", "true");
  });

  it("opens the editor with the device chosen on the Virtual devices tab, then lets go of the request", () => {
    const onStartHandled = vi.fn();
    setup({ startWithDevice: "stepKnob", onStartHandled });
    const editor = within(screen.getByRole("region", { name: "Recipe editor" }));
    expect(editor.getByLabelText("Device")).toHaveValue("stepKnob");
    expect(onStartHandled).toHaveBeenCalled();
  });

  it("asks before deleting a recipe", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: "Delete Look top right, hold STEM, roll" }));
    expect(props.onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Look top right, hold STEM, roll" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Look top right, hold STEM, roll" }));
    expect(props.onDelete).toHaveBeenCalledWith("lookStemVolume");
  });

  it("names the two recipes in conflict", () => {
    const pinch: Recipe = { ...stem, id: "pinch", name: "Pinch volume", stages: [{ kind: "hold", hold: "pinch" }, stem.stages[2]] };
    setup({
      automation: {
        recipes: [stem, pinch],
        blocked: ["lookStemVolume", "pinch"],
        conflicts: [{ resource: "volume", first: "lookStemVolume", second: "pinch" }],
      },
    });
    expect(screen.getByText("These gestures are fighting over volume")).toBeInTheDocument();
    expect(screen.getAllByText("Paused: conflict")).toHaveLength(2);
  });
});
