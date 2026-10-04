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
    fireEvent.click(editor.getByRole("button", { name: /Add a gesture/ }));
    fireEvent.change(editor.getByLabelText("Step 2 gesture"), { target: { value: "pinch" } });
    fireEvent.click(editor.getByRole("radio", { name: /Pitch/ }));
    fireEvent.change(editor.getByLabelText("Device"), { target: { value: "stepKnob" } });
    fireEvent.change(editor.getByLabelText("Per step"), { target: { value: "10" } });
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

  it("lets a recipe control brightness or scroll, with the numbers in that unit", async () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: /New recipe/ }));
    const editor = within(screen.getByRole("region", { name: "Recipe editor" }));
    fireEvent.change(editor.getByLabelText("Name"), { target: { value: "Scroll pages" } });
    expect(editor.getByLabelText("Sensitivity")).toHaveValue(0.3333);
    fireEvent.change(editor.getByLabelText("Controls"), { target: { value: "scroll" } });
    // Pixels, not points: the same default feel is ten times the number.
    expect(editor.getByLabelText("Sensitivity")).toHaveValue(3.3333);
    fireEvent.change(editor.getByLabelText("Sensitivity"), { target: { value: "5" } });
    fireEvent.click(editor.getByRole("button", { name: "Save recipe" }));
    await waitFor(() => expect(props.onSave).toHaveBeenCalled());
    expect(vi.mocked(props.onSave).mock.calls[0][0]).toMatchObject({
      action: "scroll",
      device: { kind: "rotationKnob", fractionPerDegree: 0.005 },
    });
  });

  it("builds a button-style recipe for a media key: no wrist rotation or device, only steps", async () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: /New recipe/ }));
    const editor = within(screen.getByRole("region", { name: "Recipe editor" }));
    fireEvent.change(editor.getByLabelText("Name"), { target: { value: "Pinch to play" } });
    expect(editor.getByLabelText("Device")).toBeInTheDocument();
    fireEvent.change(editor.getByLabelText("Controls"), { target: { value: "playPause" } });
    // A button has no dial to turn.
    expect(editor.queryByLabelText("Device")).not.toBeInTheDocument();
    expect(editor.queryByLabelText("Dead zone")).not.toBeInTheDocument();
    expect(editor.getByText(/Presses the play\/pause media key once/)).toBeInTheDocument();

    // Remove the pre-filled look-at step: a trigger needs something to start it.
    fireEvent.click(editor.getByRole("button", { name: "Remove step 1" }));
    expect(editor.getByRole("alert")).toHaveTextContent("Add at least one step");
    fireEvent.click(editor.getByRole("button", { name: "Save recipe" }));
    expect(props.onSave).not.toHaveBeenCalled();

    fireEvent.click(editor.getByRole("button", { name: /Add a gesture/ }));
    fireEvent.change(editor.getByLabelText("Step 1 gesture"), { target: { value: "pinch" } });
    fireEvent.click(editor.getByRole("button", { name: "Save recipe" }));
    await waitFor(() => expect(props.onSave).toHaveBeenCalled());
    const saved = vi.mocked(props.onSave).mock.calls[0][0];
    expect(saved.action).toBe("playPause");
    expect(saved.stages).toEqual([{ kind: "hold", hold: "pinch" }]);
  });

  it("offers a shake only for button actions and explains why it is refused otherwise", async () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: /New recipe/ }));
    const editor = within(screen.getByRole("region", { name: "Recipe editor" }));
    fireEvent.change(editor.getByLabelText("Name"), { target: { value: "Shake for next" } });
    fireEvent.click(editor.getByRole("button", { name: /Add a gesture/ }));
    // A volume dial is turned over time; a shake is a moment, so it is not offered.
    expect(within(editor.getByLabelText("Step 2 gesture")).queryByRole("option", { name: "Shake wrist" })).not.toBeInTheDocument();

    fireEvent.change(editor.getByLabelText("Controls"), { target: { value: "nextTrack" } });
    fireEvent.change(editor.getByLabelText("Step 2 gesture"), { target: { value: "shake" } });
    expect(editor.getByText(/needs the watch's acceleration sensor/)).toBeInTheDocument();

    // Switching back to a dial keeps the shake step but refuses to save it, in words.
    fireEvent.change(editor.getByLabelText("Controls"), { target: { value: "volume" } });
    expect(editor.getByRole("alert")).toHaveTextContent("A shake, swipe, tap, roll or pitch only works for a button action");
    fireEvent.click(editor.getByRole("button", { name: "Save recipe" }));
    expect(props.onSave).not.toHaveBeenCalled();

    fireEvent.change(editor.getByLabelText("Controls"), { target: { value: "nextTrack" } });
    fireEvent.click(editor.getByRole("button", { name: "Save recipe" }));
    await waitFor(() => expect(props.onSave).toHaveBeenCalled());
    expect(vi.mocked(props.onSave).mock.calls[0][0]).toMatchObject({
      action: "nextTrack",
      stages: [{ kind: "headAt", location: "topRight" }, { kind: "hold", hold: "shake" }],
    });
  });

  it("builds a swipe recipe for a media key and refuses a swipe on a dial", async () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: /New recipe/ }));
    const editor = within(screen.getByRole("region", { name: "Recipe editor" }));
    fireEvent.change(editor.getByLabelText("Name"), { target: { value: "Swipe for next" } });
    fireEvent.click(editor.getByRole("button", { name: "Remove step 1" }));
    fireEvent.change(editor.getByLabelText("Controls"), { target: { value: "nextTrack" } });
    fireEvent.click(editor.getByRole("button", { name: /Add a gesture/ }));
    const options = within(editor.getByLabelText("Step 1 gesture")).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Pinch and hold", "Hold STEM button", "Shake wrist", "Swipe left", "Swipe right", "Swipe up", "Swipe down", "Tap watch", "Double-tap watch", "Roll wrist clockwise", "Roll wrist counter-clockwise", "Pitch hand up", "Pitch hand down"]);
    fireEvent.change(editor.getByLabelText("Step 1 gesture"), { target: { value: "swipeRight" } });
    expect(editor.getByText(/Swipes are read from the watch's acceleration/)).toBeInTheDocument();

    fireEvent.change(editor.getByLabelText("Controls"), { target: { value: "scroll" } });
    expect(editor.getByRole("alert")).toHaveTextContent("A shake, swipe, tap, roll or pitch only works for a button action");
    fireEvent.click(editor.getByRole("button", { name: "Save recipe" }));
    expect(props.onSave).not.toHaveBeenCalled();

    fireEvent.change(editor.getByLabelText("Controls"), { target: { value: "nextTrack" } });
    fireEvent.click(editor.getByRole("button", { name: "Save recipe" }));
    await waitFor(() => expect(props.onSave).toHaveBeenCalled());
    expect(vi.mocked(props.onSave).mock.calls[0][0]).toMatchObject({
      action: "nextTrack",
      stages: [{ kind: "hold", hold: "swipeRight" }],
    });
  });

  it("builds a double-tap recipe and explains the delay of a single tap", async () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: /New recipe/ }));
    const editor = within(screen.getByRole("region", { name: "Recipe editor" }));
    fireEvent.change(editor.getByLabelText("Name"), { target: { value: "Double tap to mute" } });
    fireEvent.click(editor.getByRole("button", { name: "Remove step 1" }));
    fireEvent.change(editor.getByLabelText("Controls"), { target: { value: "mute" } });
    fireEvent.click(editor.getByRole("button", { name: /Add a gesture/ }));
    fireEvent.change(editor.getByLabelText("Step 1 gesture"), { target: { value: "doubleTap" } });
    expect(editor.getByText(/fires about 0.4 seconds after the knock/)).toBeInTheDocument();
    fireEvent.click(editor.getByRole("button", { name: "Save recipe" }));
    await waitFor(() => expect(props.onSave).toHaveBeenCalled());
    expect(vi.mocked(props.onSave).mock.calls[0][0]).toMatchObject({ action: "mute", stages: [{ kind: "hold", hold: "doubleTap" }] });
  });

  it("builds a roll recipe and says how it differs from the dial's slow roll", async () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: /New recipe/ }));
    const editor = within(screen.getByRole("region", { name: "Recipe editor" }));
    fireEvent.change(editor.getByLabelText("Name"), { target: { value: "Flick for next" } });
    fireEvent.click(editor.getByRole("button", { name: "Remove step 1" }));
    fireEvent.change(editor.getByLabelText("Controls"), { target: { value: "nextTrack" } });
    fireEvent.click(editor.getByRole("button", { name: /Add a gesture/ }));
    fireEvent.change(editor.getByLabelText("Step 1 gesture"), { target: { value: "rollClockwise" } });
    expect(editor.getByText(/not the slow roll that turns a dial/)).toBeInTheDocument();
    fireEvent.click(editor.getByRole("button", { name: "Save recipe" }));
    await waitFor(() => expect(props.onSave).toHaveBeenCalled());
    expect(vi.mocked(props.onSave).mock.calls[0][0]).toMatchObject({ action: "nextTrack", stages: [{ kind: "hold", hold: "rollClockwise" }] });
  });

  it("builds a pitch recipe and says how it differs from the dial's slow tilt", async () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: /New recipe/ }));
    const editor = within(screen.getByRole("region", { name: "Recipe editor" }));
    fireEvent.change(editor.getByLabelText("Name"), { target: { value: "Nod to pause" } });
    fireEvent.click(editor.getByRole("button", { name: "Remove step 1" }));
    fireEvent.change(editor.getByLabelText("Controls"), { target: { value: "playPause" } });
    fireEvent.click(editor.getByRole("button", { name: /Add a gesture/ }));
    fireEvent.change(editor.getByLabelText("Step 1 gesture"), { target: { value: "pitchUp" } });
    expect(editor.getByText(/not the slow tilt that turns a dial/)).toBeInTheDocument();
    fireEvent.click(editor.getByRole("button", { name: "Save recipe" }));
    await waitFor(() => expect(props.onSave).toHaveBeenCalled());
    expect(vi.mocked(props.onSave).mock.calls[0][0]).toMatchObject({ action: "playPause", stages: [{ kind: "hold", hold: "pitchUp" }] });
  });

  it("flags a recipe whose built-in gesture is switched off in Settings", () => {
    const swipe: Recipe = { ...stem, id: "swipe", name: "Swipe for next", action: "nextTrack", stages: [{ kind: "hold", hold: "swipeRight" }] };
    setup({
      automation: automation([stem, swipe]),
      builtInGestures: { shake: true, swipe: false, tap: true, roll: true, pitch: true },
    });
    // Only the recipe that uses the off gesture is flagged; the STEM recipe is untouched.
    const flags = screen.getAllByText(/Never fires/);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toHaveTextContent("swipe gesture off in Settings");
    expect(screen.getByText("Swipe for next").closest("li")).toContainElement(flags[0]);
  });

  it("describes a media recipe without a device", () => {
    const play: Recipe = { ...stem, id: "play", name: "Pinch to play", action: "playPause", stages: [{ kind: "hold", hold: "pinch" }] };
    setup({ automation: automation([play]) });
    expect(screen.getByText("Pinch and hold → Play / pause")).toBeInTheDocument();
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
    fireEvent.click(editor.getByRole("button", { name: /Add a gesture/ }));
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
