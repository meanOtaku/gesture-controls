import { describe, expect, it } from "vitest";
import { AgreementTracker, LAG_MS } from "./agreement";

const seen = () => { const t = new AgreementTracker(); t.setHandInView(0, true); return t; };

describe("AgreementTracker", () => {
  it("counts a detection soon after a camera hold as found, with its delay", () => {
    const t = seen();
    t.cameraOnset("pinch", 1000);
    t.cameraRelease("pinch", 1800);
    t.modelDetected("pinch", 1400);
    t.cameraOnset("pinch", 6000);
    t.cameraRelease("pinch", 6500);
    t.modelDetected("pinch", 6600);
    expect(t.summarize("pinch", 20_000)).toEqual({ holds: 2, found: 2, missed: 0, falseAlarms: 0, unverified: 0, medianDelayMs: 500 });
  });

  it("counts a hold the model never answered as missed, but only after the model has had time", () => {
    const t = seen();
    t.cameraOnset("pinch", 1000);
    expect(t.summarize("pinch", 1000 + LAG_MS - 1).holds).toBe(0);
    expect(t.summarize("pinch", 1000 + LAG_MS)).toMatchObject({ holds: 1, found: 0, missed: 1, medianDelayMs: null });
  });

  it("counts a detection with the camera watching and no hold as a false alarm, and one with no hand in view as unverified", () => {
    const t = new AgreementTracker();
    t.setHandInView(0, true);
    t.modelDetected("pinch", 1000);
    t.setHandInView(2000, false);
    t.modelDetected("pinch", 3000);
    expect(t.summarize("pinch", 10_000)).toMatchObject({ falseAlarms: 1, unverified: 1 });
  });

  it("does not count a repeat detection during one long hold as a false alarm, nor use one detection for two holds", () => {
    const t = seen();
    t.cameraOnset("pinch", 1000);
    t.modelDetected("pinch", 1200);
    t.modelDetected("pinch", 3000); // re-triggered while still held
    t.cameraRelease("pinch", 3500);
    t.cameraOnset("pinch", 4000);
    t.cameraRelease("pinch", 4200);
    expect(t.summarize("pinch", 20_000)).toMatchObject({ holds: 2, found: 1, missed: 1, falseAlarms: 0 });
  });

  it("keeps labels apart and can be reset", () => {
    const t = seen();
    t.cameraOnset("pinch", 1000);
    t.modelDetected("fist", 1100);
    expect(t.labels().sort()).toEqual(["fist", "pinch"]);
    expect(t.summarize("pinch", 10_000).found).toBe(0);
    t.reset();
    expect(t.labels()).toEqual([]);
  });
});
