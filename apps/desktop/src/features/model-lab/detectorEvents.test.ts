import { describe, expect, it } from "vitest";
import { cohortNote, type EventTotals, type Judged } from "./detectorEvents";

const totals = (starts: number, caught: number, falseActivations: number, seconds: number, recordings = 1): EventTotals => ({
  recordings, starts, caught, repeats: 0, late: 0, falseActivations, negativeSeconds: seconds, falseActivationsPerHour: falseActivations / (seconds / 3600),
});

describe("the note under a judged total", () => {
  it("says what was judged, sets the estimated recordings apart, and gives the false activations on everyday noise", () => {
    const camera = totals(25, 10, 3, 600, 2);
    const noise = totals(0, 0, 6, 1800);
    const judged: Judged = { ...totals(25, 10, 9, 2400, 3), cohort: "camera", byLabelTiming: { camera, estimated: totals(30, 28, 0, 600), noGesture: noise } };
    expect(cohortNote(judged)).toBe(
      "Judged on the 2 camera-timed recordings and the 1 of everyday noise. Shown, not judged on: estimated from motion (1): caught 28 of 30 starts (93%), 0 false activations an hour with no gesture under way."
      + " On everyday noise (1 recording, 30 min): 12 false activations an hour, what daily use would see.",
    );
  });

  it("is only about the noise when the rest was all timed by the camera, and absent with neither", () => {
    const camera = totals(25, 10, 3, 600);
    expect(cohortNote({ ...camera, cohort: "all", byLabelTiming: { camera, noGesture: totals(0, 0, 1, 3600) } })).toBe("On everyday noise (1 recording, 60 min): 1 false activations an hour, what daily use would see.");
    expect(cohortNote({ ...camera, cohort: "all", byLabelTiming: { camera } })).toBeNull();
  });
});
