import { describe, expect, it } from "vitest";
import type { CalibrationLocation, Recipe } from "../../shared/protocol/events";
import {
  actionInfo, blankRecipe, buildDevice, deviceSpecs, chainProblem, defaultNumbers, describeRecipe, deviceNumbers, driveStage, leadingStages, nameProblem,
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
        { kind: "hold", hold: "pinch" },
        { kind: "drive", axis: "pitch", deadZoneDegrees: 3, invert: false },
      ],
      device: buildDevice("stepKnob", defaultNumbers("stepKnob")),
    };
    expect(describeRecipe(recipe, (id) => locations.find((l) => l.id === id)?.name ?? "?")).toBe(
      "Look at Top right → Pinch and hold → Pitch wrist → step knob → Volume",
    );
  });

  it("refuses a repeated step, an unknown location and too many steps", () => {
    expect(chainProblem([{ kind: "hold", hold: "pinch" }], locations)).toBeNull();
    expect(chainProblem([{ kind: "hold", hold: "pinch" }, { kind: "hold", hold: "pinch" }], locations)).toMatch(/twice/);
    expect(chainProblem([{ kind: "headAt", location: "gone" }], locations)).toMatch(/no longer exists/);
    const many = [
      { kind: "headAt", location: "topRight" }, { kind: "headAt", location: "leftEdge" },
      { kind: "hold", hold: "pinch" }, { kind: "hold", hold: "stemButton" },
      { kind: "headAt", location: "center" } ,
    ] as const;
    expect(chainProblem([...many], locations)).toBeNull();
    expect(chainProblem([...many, { kind: "headAt", location: "other" }], locations)).toMatch(/at most 5/);
  });

  it("validates the name", () => {
    expect(nameProblem("  ")).toBe("Give the recipe a name.");
    expect(nameProblem("x".repeat(41))).toMatch(/Too long/);
    expect(nameProblem("Pinch volume")).toBeNull();
  });
});
