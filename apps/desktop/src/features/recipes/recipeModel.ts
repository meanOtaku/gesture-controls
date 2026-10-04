import type { NumberSpec } from "../../shared/forms/numberField";
import type { CalibrationLocation, Recipe, RecipeStage } from "../../shared/protocol/events";

export const MAX_RECIPE_NAME_CHARS = 40;
export const MAX_STAGES = 6;

export type DeviceKind = "rotationKnob" | "horizontalFader" | "verticalFader" | "stepKnob";
export type Axis = "roll" | "pitch" | "yaw";
export type HoldKind = "pinch" | "stemButton";

export const DEVICE_KINDS: ReadonlyArray<{ kind: DeviceKind; label: string; summary: string }> = [
  { kind: "rotationKnob", label: "Rotation knob", summary: "Endless: every degree you turn changes the value." },
  { kind: "horizontalFader", label: "Horizontal fader", summary: "A slider with end stops; suits a yaw (left-right) movement." },
  { kind: "verticalFader", label: "Vertical fader", summary: "A slider with end stops; suits a pitch (up-down) movement." },
  { kind: "stepKnob", label: "Step knob", summary: "Moves in whole steps, like a detented dial." },
];

export const AXES: ReadonlyArray<{ value: Axis; label: string }> = [
  { value: "roll", label: "Roll" },
  { value: "pitch", label: "Pitch" },
  { value: "yaw", label: "Yaw" },
];

export const HOLDS: ReadonlyArray<{ value: HoldKind; label: string }> = [
  { value: "pinch", label: "Pinch and hold" },
  { value: "stemButton", label: "Hold STEM button" },
];

export const DEAD_ZONE_SPEC: NumberSpec = {
  label: "Dead zone", unit: "°", min: 0, max: 89, step: 0.5, defaultValue: 3,
  description: "Turning less than this from where you started does nothing",
};

/**
 * Each device has up to two numbers. They are shown in volume points rather than the engine's fractions of the
 * range (0.01 is one point), so the form speaks the same units as the knob on screen.
 */
export interface DeviceSpecs {
  a: NumberSpec;
  b: NumberSpec | null;
}

export function deviceSpecs(kind: DeviceKind): DeviceSpecs {
  switch (kind) {
    case "rotationKnob":
      return {
        a: { label: "Sensitivity", unit: "pts/°", min: 0.01, max: 5, step: 0.01, defaultValue: 1 / 3, description: "Volume points per degree you turn" },
        b: null,
      };
    case "horizontalFader":
    case "verticalFader":
      return {
        a: { label: "Travel", unit: "°", min: 1, max: 180, step: 1, defaultValue: 45, description: "How far to turn each way to reach the end of the slider" },
        b: { label: "Range", unit: "pts", min: 1, max: 100, step: 1, defaultValue: 50, description: "Volume points from the middle to either end" },
      };
    case "stepKnob":
      return {
        a: { label: "Degrees per step", unit: "°", min: 1, max: 180, step: 1, defaultValue: 15, description: "How far to turn for one step" },
        b: { label: "Points per step", unit: "pts", min: 1, max: 100, step: 1, defaultValue: 5, description: "Volume points each step changes" },
      };
  }
}

export interface DeviceNumbers {
  a: number;
  b: number;
}

/** The two numbers shown for a device, in volume points. A knob has only one. */
export function deviceNumbers(device: Recipe["device"]): DeviceNumbers {
  const n = (key: string) => Number(device[key]);
  switch (device.kind) {
    case "rotationKnob":
      return { a: n("fractionPerDegree") * 100, b: 0 };
    case "horizontalFader":
    case "verticalFader":
      return { a: n("travelDegrees"), b: n("fractionPerTravel") * 100 };
    case "stepKnob":
      return { a: n("degreesPerStep"), b: n("fractionPerStep") * 100 };
  }
}

export function defaultNumbers(kind: DeviceKind): DeviceNumbers {
  const specs = deviceSpecs(kind);
  return { a: specs.a.defaultValue, b: specs.b?.defaultValue ?? 0 };
}

/** The device as the backend stores it, from the numbers shown in the form. */
export function buildDevice(kind: DeviceKind, { a, b }: DeviceNumbers): Recipe["device"] {
  switch (kind) {
    case "rotationKnob":
      return { kind, fractionPerDegree: a / 100 };
    case "horizontalFader":
    case "verticalFader":
      return { kind, travelDegrees: a, fractionPerTravel: b / 100 };
    case "stepKnob":
      return { kind, degreesPerStep: a, fractionPerStep: b / 100 };
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
    deviceLabel(recipe.device.kind),
    "Volume",
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
export function blankRecipe(locations: CalibrationLocation[]): Recipe {
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
    device: buildDevice("rotationKnob", defaultNumbers("rotationKnob")),
  };
}

const sameStage = (a: RecipeStage, b: RecipeStage) => JSON.stringify(a) === JSON.stringify(b);

/** Why this chain of steps cannot be saved, or null. The backend checks the same things. */
export function chainProblem(leading: RecipeStage[], locations: CalibrationLocation[]): string | null {
  if (leading.length + 1 > MAX_STAGES) return `A recipe can have at most ${MAX_STAGES - 1} steps before the wrist rotation.`;
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
