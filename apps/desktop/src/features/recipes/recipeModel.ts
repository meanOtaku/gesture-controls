import type { NumberSpec } from "../../shared/forms/numberField";
import type { CalibrationLocation, Recipe, RecipeAction, RecipeStage } from "../../shared/protocol/events";

export const MAX_RECIPE_NAME_CHARS = 40;
export const MAX_STAGES = 6;

export type DeviceKind = "rotationKnob" | "horizontalFader" | "verticalFader" | "stepKnob";
export type Axis = "roll" | "pitch" | "yaw";
export type HoldKind = "pinch" | "stemButton" | "shake" | "swipeLeft" | "swipeRight" | "swipeUp" | "swipeDown" | "tap" | "doubleTap" | "rotateClockwise" | "rotateCounterClockwise";

export const DEVICE_KINDS: ReadonlyArray<{ kind: DeviceKind; label: string; summary: string }> = [
  { kind: "rotationKnob", label: "Rotation knob", summary: "Endless: every degree you turn changes the value." },
  { kind: "horizontalFader", label: "Horizontal fader", summary: "A slider with end stops; suits a yaw (left-right) movement." },
  { kind: "verticalFader", label: "Vertical fader", summary: "A slider with end stops; suits a pitch (up-down) movement." },
  { kind: "stepKnob", label: "Step knob", summary: "Moves in whole steps, like a detented dial." },
];

/** What a recipe can control. `scale` turns the engine's fraction of the range into the unit shown (points, percent, pixels). */
export const ACTIONS: ReadonlyArray<{ value: RecipeAction; label: string; unit: string; scale: number; trigger: boolean; summary: string }> = [
  { value: "volume", label: "Volume", unit: "pts", scale: 100, trigger: false, summary: "The system output volume. Shows the knob on screen while you use it." },
  { value: "brightness", label: "Brightness", unit: "%", scale: 100, trigger: false, summary: "Display brightness. On a Mac it moves in sixteenth steps, like the keyboard keys, and needs Accessibility permission." },
  { value: "scroll", label: "Scroll", unit: "px", scale: 1000, trigger: false, summary: "Scrolls the window under the pointer. Turn one way to scroll down, the other to scroll up. A Mac needs Accessibility permission." },
  { value: "playPause", label: "Play / pause", unit: "", scale: 1, trigger: true, summary: "Presses the play/pause media key once each time your steps all hold. There is no wrist rotation: it is a button, not a dial." },
  { value: "nextTrack", label: "Next track", unit: "", scale: 1, trigger: true, summary: "Presses the next-track media key once each time your steps all hold." },
  { value: "previousTrack", label: "Previous track", unit: "", scale: 1, trigger: true, summary: "Presses the previous-track media key once each time your steps all hold." },
  { value: "mute", label: "Mute", unit: "", scale: 1, trigger: true, summary: "Toggles the system mute each time your steps all hold." },
];

/** A trigger fires once when its steps all hold, instead of following your wrist. It has no wrist rotation or device. */
export function isTrigger(action: RecipeAction): boolean {
  return actionInfo(action).trigger;
}

export function actionInfo(action: RecipeAction) {
  return ACTIONS.find((candidate) => candidate.value === action) ?? ACTIONS[0];
}

export const AXES: ReadonlyArray<{ value: Axis; label: string }> = [
  { value: "roll", label: "Roll" },
  { value: "pitch", label: "Pitch" },
  { value: "yaw", label: "Yaw" },
];

export const HOLDS: ReadonlyArray<{ value: HoldKind; label: string }> = [
  { value: "pinch", label: "Pinch and hold" },
  { value: "stemButton", label: "Hold STEM button" },
  { value: "shake", label: "Shake wrist" },
  { value: "swipeLeft", label: "Swipe left" },
  { value: "swipeRight", label: "Swipe right" },
  { value: "swipeUp", label: "Swipe up" },
  { value: "swipeDown", label: "Swipe down" },
  { value: "tap", label: "Tap watch" },
  { value: "doubleTap", label: "Double-tap watch" },
  { value: "rotateClockwise", label: "Rotate wrist clockwise" },
  { value: "rotateCounterClockwise", label: "Rotate wrist counter-clockwise" },
];

/** A shake, swipe, tap or rotate is over in a moment, unlike a pinch or a held button. */
export function isMomentary(hold: HoldKind): boolean {
  return hold !== "pinch" && hold !== "stemButton";
}

/** The gestures a recipe can use: a shake, swipe, tap or rotate is over in a moment, so only a button action can use it. */
export function holdsFor(trigger: boolean) {
  return trigger ? HOLDS : HOLDS.filter((hold) => !isMomentary(hold.value));
}

export const DEAD_ZONE_SPEC: NumberSpec = {
  label: "Dead zone", unit: "°", min: 0, max: 89, step: 0.5, defaultValue: 3,
  description: "Turning less than this from where you started does nothing",
};

/**
 * Each device has up to two numbers. They are shown in the unit of what the recipe controls (volume points,
 * brightness percent, scroll pixels) rather than the engine's fractions of the range, so the form speaks the same
 * units as the thing being changed. Degrees are the same for every action.
 */
export interface DeviceSpecs {
  a: NumberSpec;
  b: NumberSpec | null;
}

function scaled(spec: NumberSpec, action: RecipeAction): NumberSpec {
  const { unit, scale } = actionInfo(action);
  const factor = scale / 100;
  return {
    ...spec,
    unit: spec.unit?.replace("pts", unit),
    min: spec.min * factor,
    max: spec.max * factor,
    step: spec.step * factor,
    defaultValue: spec.defaultValue * factor,
  };
}

export function deviceSpecs(kind: DeviceKind, action: RecipeAction = "volume"): DeviceSpecs {
  switch (kind) {
    case "rotationKnob":
      return {
        a: scaled({ label: "Sensitivity", unit: "pts/°", min: 0.01, max: 5, step: 0.01, defaultValue: 1 / 3, description: "How much it changes per degree you turn" }, action),
        b: null,
      };
    case "horizontalFader":
    case "verticalFader":
      return {
        a: { label: "Travel", unit: "°", min: 1, max: 180, step: 1, defaultValue: 45, description: "How far to turn each way to reach the end of the slider" },
        b: scaled({ label: "Range", unit: "pts", min: 1, max: 100, step: 1, defaultValue: 50, description: "How much it changes from the middle to either end" }, action),
      };
    case "stepKnob":
      return {
        a: { label: "Degrees per step", unit: "°", min: 1, max: 180, step: 1, defaultValue: 15, description: "How far to turn for one step" },
        b: scaled({ label: "Per step", unit: "pts", min: 1, max: 100, step: 1, defaultValue: 5, description: "How much each step changes" }, action),
      };
  }
}

export interface DeviceNumbers {
  a: number;
  b: number;
}

/** The two numbers shown for a device, in the action's unit. A knob has only one. */
export function deviceNumbers(device: Recipe["device"], action: RecipeAction = "volume"): DeviceNumbers {
  const n = (key: string) => Number(device[key]);
  const { scale } = actionInfo(action);
  switch (device.kind) {
    case "rotationKnob":
      return { a: n("fractionPerDegree") * scale, b: 0 };
    case "horizontalFader":
    case "verticalFader":
      return { a: n("travelDegrees"), b: n("fractionPerTravel") * scale };
    case "stepKnob":
      return { a: n("degreesPerStep"), b: n("fractionPerStep") * scale };
  }
}

export function defaultNumbers(kind: DeviceKind, action: RecipeAction = "volume"): DeviceNumbers {
  const specs = deviceSpecs(kind, action);
  return { a: specs.a.defaultValue, b: specs.b?.defaultValue ?? 0 };
}

/** The device as the backend stores it, from the numbers shown in the form. */
export function buildDevice(kind: DeviceKind, { a, b }: DeviceNumbers, action: RecipeAction = "volume"): Recipe["device"] {
  const { scale } = actionInfo(action);
  switch (kind) {
    case "rotationKnob":
      return { kind, fractionPerDegree: a / scale };
    case "horizontalFader":
    case "verticalFader":
      return { kind, travelDegrees: a, fractionPerTravel: b / scale };
    case "stepKnob":
      return { kind, degreesPerStep: a, fractionPerStep: b / scale };
  }
}

export function deviceLabel(kind: string): string {
  return DEVICE_KINDS.find((device) => device.kind === kind)?.label.toLowerCase() ?? kind;
}

function stageLabel(stage: RecipeStage, locationName: (id: string) => string): string {
  switch (stage.kind) {
    case "headAt":
      return `Look at ${locationName(stage.location)}`;
    case "hold":
      return HOLDS.find((hold) => hold.value === stage.hold)?.label ?? stage.hold;
    case "drive":
      return `${AXES.find((axis) => axis.value === stage.axis)?.label ?? stage.axis} wrist`;
  }
}

/** "Look at Top right → Pinch and hold → Roll wrist → rotation knob → Volume" */
export function describeRecipe(recipe: Recipe, locationName: (id: string) => string): string {
  return [
    ...recipe.stages.map((stage) => stageLabel(stage, locationName)),
    ...(isTrigger(recipe.action) ? [] : [deviceLabel(recipe.device.kind)]),
    actionInfo(recipe.action).label,
  ].join(" → ");
}

/** The steps before the wrist rotation, which every recipe ends with. */
export function leadingStages(recipe: Recipe): Exclude<RecipeStage, { kind: "drive" }>[] {
  return recipe.stages.filter((stage): stage is Exclude<RecipeStage, { kind: "drive" }> => stage.kind !== "drive");
}

export function driveStage(recipe: Recipe): Extract<RecipeStage, { kind: "drive" }> {
  const drive = recipe.stages.find((stage): stage is Extract<RecipeStage, { kind: "drive" }> => stage.kind === "drive");
  return drive ?? { kind: "drive", axis: "roll", deadZoneDegrees: DEAD_ZONE_SPEC.defaultValue, invert: false };
}

/** A blank recipe to start from: look at the first location you added, then roll. Off until you switch it on. */
export function blankRecipe(locations: CalibrationLocation[], kind: DeviceKind = "rotationKnob"): Recipe {
  const first = locations.find((location) => !location.builtin) ?? locations[0];
  return {
    id: "",
    name: "",
    enabled: false,
    action: "volume",
    stages: [
      ...(first ? [{ kind: "headAt", location: first.id } as const] : []),
      { kind: "drive", axis: "roll", deadZoneDegrees: DEAD_ZONE_SPEC.defaultValue, invert: false },
    ],
    device: buildDevice(kind, defaultNumbers(kind)),
  };
}

const sameStage = (a: RecipeStage, b: RecipeStage) => JSON.stringify(a) === JSON.stringify(b);

/** Why this chain of steps cannot be saved, or null. The backend checks the same things. */
export function chainProblem(leading: RecipeStage[], locations: CalibrationLocation[], trigger = false): string | null {
  if (trigger && leading.length === 0) return "Add at least one step: something has to start it.";
  if (!trigger && leading.some((stage) => stage.kind === "hold" && isMomentary(stage.hold))) {
    return "A shake, swipe, tap or rotate only works for a button action (play/pause, next, previous or mute). Choose one under To control, or remove that step.";
  }
  const limit = trigger ? MAX_STAGES : MAX_STAGES - 1;
  if (leading.length > limit) return `A recipe can have at most ${limit} steps${trigger ? "" : " before the wrist rotation"}.`;
  for (const [index, stage] of leading.entries()) {
    if (leading.slice(0, index).some((earlier) => sameStage(earlier, stage))) {
      return "The same step is used twice. Remove one of them.";
    }
    if (stage.kind === "headAt" && !locations.some((location) => location.id === stage.location)) {
      return "A step looks at a location that no longer exists. Pick another.";
    }
  }
  return null;
}

export function nameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "Give the recipe a name.";
  if (trimmed.length > MAX_RECIPE_NAME_CHARS) return `Too long: the maximum is ${MAX_RECIPE_NAME_CHARS} characters.`;
  return null;
}
