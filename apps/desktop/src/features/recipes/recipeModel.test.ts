import { describe, expect, it } from "vitest";
import type { CalibrationLocation, Recipe } from "../../shared/protocol/events";
import {
  actionInfo, isMomentaryStage, isValidLabel, heuristicOf, offGesturesUsed, holdsFor, isMomentary, isTrigger, blankRecipe, buildDevice, deviceSpecs, chainProblem, defaultNumbers, describeRecipe, deviceNumbers, driveStage, leadingStages, nameProblem,
} from "./recipeModel";

const locations: CalibrationLocation[] = [
  { id: "center", name: "Screen center", calibrated: true, builtin: true },
  { id: "topRight", name: "Top right", calibrated: true, builtin: false },
  { id: "leftEdge", name: "Left edge", calibrated: false, builtin: false },
];

describe("recipeModel", () => {
  it("converts devices between stored fractions and volume points, both ways", () => {
    expect(buildDevice("rotationKnob", { a: 0.5, b: 0 })).toEqual({ kind: "rotationKnob", fractionPerDegree: 0.005 });
    expect(buildDevice("horizontalFader", { a: 40, b: 50 })).toEqual({ kind: "horizontalFader", travelDegrees: 40, fractionPerTravel: 0.5 });
    expect(buildDevice("stepKnob", { a: 15, b: 5 })).toEqual({ kind: "stepKnob", degreesPerStep: 15, fractionPerStep: 0.05 });
    for (const kind of ["rotationKnob", "horizontalFader", "verticalFader", "stepKnob"] as const) {
      const numbers = defaultNumbers(kind);
      const back = deviceNumbers(buildDevice(kind, numbers));
      expect(back.a).toBeCloseTo(numbers.a, 9);
      if (kind !== "rotationKnob") expect(back.b).toBeCloseTo(numbers.b, 9);
    }
  });

  it("shows device numbers in the unit of what is controlled, and stores the same fractions either way", () => {
    expect(deviceSpecs("rotationKnob", "volume").a.unit).toBe("pts/°");
    expect(deviceSpecs("rotationKnob", "brightness").a.unit).toBe("%/°");
    const scroll = deviceSpecs("rotationKnob", "scroll").a;
    expect(scroll.unit).toBe("px/°");
    expect(scroll.defaultValue).toBeCloseTo(10 / 3, 9); // a third of a point per degree, times ten
    expect(deviceSpecs("stepKnob", "scroll").b).toMatchObject({ unit: "px", defaultValue: 50, max: 1000 });
    // The same on-screen default is the same stored fraction for volume and brightness (a percent of the range).
    expect(buildDevice("stepKnob", defaultNumbers("stepKnob", "brightness"), "brightness")).toEqual(
      buildDevice("stepKnob", defaultNumbers("stepKnob", "volume"), "volume"),
    );
    // And a value typed in pixels is stored as a fraction of the 1000 px range.
    expect(buildDevice("rotationKnob", { a: 5, b: 0 }, "scroll")).toEqual({ kind: "rotationKnob", fractionPerDegree: 0.005 });
    expect(deviceNumbers({ kind: "rotationKnob", fractionPerDegree: 0.005 }, "scroll").a).toBeCloseTo(5, 9);
    expect(actionInfo("brightness").label).toBe("Brightness");
  });

  it("starts a new recipe off, looking at the first location the user added", () => {
    const recipe = blankRecipe(locations);
    expect(recipe).toMatchObject({ id: "", enabled: false, action: "volume" });
    expect(leadingStages(recipe)).toEqual([{ kind: "headAt", location: "topRight" }]);
    expect(driveStage(recipe)).toMatchObject({ axis: "roll", deadZoneDegrees: 3, invert: false });
  });

  it("describes a recipe as a chain ending in the device and what it controls", () => {
    const recipe: Recipe = {
      ...blankRecipe(locations),
      stages: [
        { kind: "headAt", location: "topRight" },
        { kind: "model", label: "pinch", hold: "held" },
        { kind: "drive", axis: "pitch", deadZoneDegrees: 3, invert: false },
      ],
      device: buildDevice("stepKnob", defaultNumbers("stepKnob")),
    };
    expect(describeRecipe(recipe, (id) => locations.find((l) => l.id === id)?.name ?? "?")).toBe(
      "Look at Top right → Model “pinch” → Pitch wrist → step knob → Volume",
    );
  });

  it("refuses a repeated step, an unknown location and too many steps", () => {
    expect(chainProblem([{ kind: "model", label: "pinch", hold: "held" }], locations)).toBeNull();
    expect(chainProblem([{ kind: "model", label: "pinch", hold: "held" }, { kind: "model", label: "pinch", hold: "held" }], locations)).toMatch(/twice/);
    expect(chainProblem([{ kind: "headAt", location: "gone" }], locations)).toMatch(/no longer exists/);
    const many = [
      { kind: "headAt", location: "topRight" }, { kind: "headAt", location: "leftEdge" },
      { kind: "model", label: "pinch", hold: "held" }, { kind: "hold", hold: "stemButton" },
      { kind: "headAt", location: "center" } ,
    ] as const;
    expect(chainProblem([...many], locations)).toBeNull();
    expect(chainProblem([...many, { kind: "headAt", location: "other" }], locations)).toMatch(/at most 5/);
  });

  it("treats media actions as buttons that need at least one step", () => {
    expect(isTrigger("playPause")).toBe(true);
    expect(isTrigger("mute")).toBe(true);
    expect(isTrigger("scroll")).toBe(false);
    expect(chainProblem([], locations, true)).toMatch(/at least one step/);
    expect(chainProblem([], locations, false)).toBeNull();
    // With no wrist rotation a trigger may use all six steps.
    const six = Array.from({ length: 6 }, (_, i) => ({ kind: "headAt", location: ["center", "topRight", "leftEdge"][i % 3] }) as const);
    expect(chainProblem(six.slice(0, 3), locations, true)).toBeNull();
  });

  it("allows a shake step for a button and, as a switch, for a dial, but not beside a grab/release pair", () => {
    const shake = [{ kind: "hold", hold: "shake" }] as const;
    expect(chainProblem([...shake], locations, true)).toBeNull();
    expect(chainProblem([...shake], locations, false)).toBeNull();
    expect(chainProblem([...shake, { kind: "modelPair", startLabel: "pinch_in", endLabel: "pinch_out" }], locations, false)).toMatch(/already says when the dial is on/);
    expect(holdsFor(true).map((hold) => hold.value)).toContain("shake");
    expect(holdsFor(false).map((hold) => hold.value)).toEqual(expect.arrayContaining(["shake", "shakeVertical", "wiggle", "hammer", "doubleTap"]));
    for (const swipe of ["swipeLeft", "swipeRight", "swipeUp", "swipeDown"] as const) {
      expect(isMomentary(swipe)).toBe(true);
      expect(chainProblem([{ kind: "hold", hold: swipe }], locations, false)).toBeNull();
      expect(chainProblem([{ kind: "hold", hold: swipe }], locations, true)).toBeNull();
    }
    expect(isMomentary("stemButton")).toBe(false);
    expect(holdsFor(false)).toEqual(holdsFor(true));
  });

  it("knows which built-in gesture switch each step depends on", () => {
    expect(heuristicOf("stemButton")).toBeNull();
    expect(heuristicOf("swipeDown")).toBe("swipe");
    expect(heuristicOf("doubleTap")).toBe("tap");
    expect(heuristicOf("rollCounterClockwise")).toBe("roll");
    expect(heuristicOf("pitchUp")).toBe("pitch");
    expect(heuristicOf("shake")).toBe("shake");
    const recipe: Recipe = {
      ...blankRecipe(locations),
      action: "nextTrack",
      stages: [{ kind: "hold", hold: "tap" }, { kind: "hold", hold: "doubleTap" }, { kind: "model", label: "pinch", hold: "held" }],
    };
    expect(offGesturesUsed(recipe, { shake: true, swipe: true, tap: false, roll: true, pitch: true, wiggle: true, hammer: true })).toEqual(["tap"]);
    expect(offGesturesUsed(recipe, { shake: true, swipe: true, tap: true, roll: true, pitch: true, wiggle: true, hammer: true })).toEqual([]);
  });

  it("validates the name", () => {
    expect(nameProblem("  ")).toBe("Give the recipe a name.");
    expect(nameProblem("x".repeat(41))).toMatch(/Too long/);
    expect(nameProblem("Pinch volume")).toBeNull();
  });
});

describe("model steps", () => {
  it("accepts only lowercase slug labels", () => {
    for (const ok of ["snap", "snap_fingers", "a1"]) expect(isValidLabel(ok)).toBe(true);
    for (const bad of ["", "Snap", "1a", "a-b", "a b", "a".repeat(49)]) expect(isValidLabel(bad)).toBe(false);
  });

  it("treats a one-shot as momentary and a held label as not", () => {
    expect(isMomentaryStage({ kind: "model", label: "snap", hold: "oneShot" })).toBe(true);
    expect(isMomentaryStage({ kind: "model", label: "snap", hold: "held" })).toBe(false);
    expect(isMomentaryStage({ kind: "hold", hold: "shake" })).toBe(true);
  });

  it("takes a one-shot model step for a dial as a switch, and rejects a bad label anywhere", () => {
    expect(chainProblem([{ kind: "model", label: "snap", hold: "oneShot" }], [], false)).toBeNull();
    expect(chainProblem([{ kind: "model", label: "snap", hold: "held" }], [], false)).toBeNull();
    expect(chainProblem([{ kind: "model", label: "Bad Label", hold: "held" }], [], true)).toMatch(/needs a label/);
  });
});

describe("camera steps", () => {
  const camera = (hold: "held" | "oneShot" = "held", gesture = "gesture-1") => ({ kind: "camera" as const, gesture, hold });
  it("describes a camera step by the gesture's name, and says once for a one-shot", () => {
    const recipe = { ...blankRecipe([], "rotationKnob"), stages: [camera("oneShot"), { kind: "drive" as const, axis: "roll" as const, deadZoneDegrees: 0, invert: false }] };
    expect(describeRecipe(recipe, () => "x", () => "Pinch")).toContain("Camera “Pinch” (once)");
  });
  it("needs a gesture, and takes a one-shot camera gesture for a button or a dial", () => {
    expect(chainProblem([camera("held", " ")], [], true)).toMatch(/needs a gesture from the Gesture library/);
    expect(chainProblem([camera("oneShot")], [], false)).toBeNull();
    expect(chainProblem([camera("oneShot")], [], true)).toBeNull();
    expect(chainProblem([camera("held")], [], false)).toBeNull();
  });
});

describe("keyboard shortcuts", () => {
  it("accepts what the backend can press and says why not otherwise", async () => {
    const { shortcutProblem } = await import("./recipeModel");
    for (const good of ["cmd+shift+4", "Shift + Command + K", "option+ctrl+Left", "f5", "esc", "ctrl+return", "win+d"]) {
      expect(shortcutProblem(good), good).toBeNull();
    }
    expect(shortcutProblem("")).toMatch(/Type the shortcut/);
    expect(shortcutProblem("k")).toMatch(/Add cmd, ctrl or alt/);
    expect(shortcutProblem("shift+k")).toMatch(/Add cmd, ctrl or alt/);
    expect(shortcutProblem("cmd+")).toMatch(/needs a key/);
    expect(shortcutProblem("cmd+shift")).toMatch(/needs a key/);
    expect(shortcutProblem("cmd+k+j")).toMatch(/one key/);
    expect(shortcutProblem("cmd+cmd+k")).toMatch(/twice/);
    expect(shortcutProblem("cmd+f13")).toMatch(/not a key/);
  });

  it("describes a shortcut recipe by its keys", () => {
    const recipe = { ...blankRecipe([], "rotationKnob"), action: "shortcut" as const, keys: "cmd+shift+4", stages: [{ kind: "hold" as const, hold: "hammer" as const }] };
    expect(describeRecipe(recipe, () => "x")).toBe("Hammer on palm → Press cmd+shift+4");
  });
});
