import { describe, expect, it } from "vitest";
import { describeWindow, type PpgWindowObservation } from "./types";

const base: PpgWindowObservation = {
  deviceId: "watch",
  sequence: 1,
  timestampNs: 1,
  sampleCount: 24,
  contactQualityMean: 0,
  activeModelId: "m",
  outcome: { kind: "accepted" },
};

describe("describeWindow", () => {
  it("is unchanged for a window that matches the model's training window", () => {
    const text = describeWindow({ ...base, window: { declaredMs: 500, observedMs: 480, compatible: true } });
    expect(text).toBe("accepted 24 samples; contact quality 0");
    expect(describeWindow(base)).toBe(text);
  });

  it("flags a window that differs from what the model was trained on", () => {
    const text = describeWindow({ ...base, window: { declaredMs: 500, observedMs: 960, compatible: false } });
    expect(text).toContain("window mismatch");
    expect(text).toContain("live 960 ms vs trained 500 ms");
    expect(text).toContain("Live is blocked");
  });

  it("flags an unmeasurable window", () => {
    const text = describeWindow({ ...base, window: { declaredMs: 500, observedMs: null, compatible: false } });
    expect(text).toContain("unmeasurable");
  });
});
