import { describe, expect, it } from "vitest";
import { phaseIntervals } from "./phaseMarker";

describe("phaseIntervals", () => {
  it("gives a short start, the hold, and a short end, as pinch is marked", () => {
    expect(phaseIntervals({ gesture: "fist", start: "fist_in", hold: "fist_hold", end: "fist_out" }, 1000, 2000)).toEqual([
      { label: "fist_in", fromMs: 1000, toMs: 1300 },
      { label: "fist_hold", fromMs: 1300, toMs: 2000 },
      { label: "fist_out", fromMs: 2000, toMs: 2300 },
    ]);
    // Held for less than the start mark: no hold.
    expect(phaseIntervals({ gesture: "fist", start: "fist_in", hold: "fist_hold", end: "fist_out" }, 1000, 1200).map((i) => i.label)).toEqual(["fist_in", "fist_out"]);
    // No start phase: the hold runs from the onset.
    expect(phaseIntervals({ gesture: "g", hold: "g_hold" }, 1000, 2000)).toEqual([{ label: "g_hold", fromMs: 1000, toMs: 2000 }]);
  });
});
