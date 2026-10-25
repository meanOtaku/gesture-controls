import { describe, expect, it } from "vitest";
import { describeQuality, inImportOrder, recordingNumber, sameDataAs } from "./types";

describe("import order", () => {
  it("puts recordings in the order they were imported, keeping stored order where there is no number", () => {
    const sorted = inImportOrder<{ id: string; sequence?: number }>([{ id: "c", sequence: 3 }, { id: "a", sequence: 1 }, { id: "b", sequence: 2 }]);
    expect(sorted.map((d) => d.id)).toEqual(["a", "b", "c"]);
    expect(inImportOrder<{ id: string; sequence?: number }>([{ id: "x" }, { id: "y" }, { id: "z" }]).map((d) => d.id)).toEqual(["x", "y", "z"]);
  });

  it("numbers a recording by its sequence, and says nothing without one", () => {
    expect(recordingNumber({ sequence: 7 })).toBe("#7");
    expect(recordingNumber({})).toBe("");
  });
});

describe("recording quality and duplicates", () => {
  it("says what training can use and warns about short holds and poor contact", () => {
    expect(describeQuality({ poorContactShare: 0, holds: { pinch: 13, hand_open: 2 }, shortHolds: 0 })).toEqual({ text: "13 pinch · 2 hand open", warn: false });
    expect(describeQuality({ poorContactShare: 0.25, holds: { pinch: 3 }, shortHolds: 2 })).toEqual({
      text: "3 pinch · 2 holds under 200 ms (ignored) · pulse contact flagged on 25% of samples",
      warn: true,
    });
    expect(describeQuality({ poorContactShare: 0, holds: {}, shortHolds: 0 })?.warn).toBe(true);
    expect(describeQuality(undefined)).toBeNull();
  });

  it("finds the other recordings that hold the same data", () => {
    const a = { id: "a", originalFilename: "a", importedAt: "", label: "pinch", rowCount: 1, contentSha: "x" };
    const b = { ...a, id: "b" };
    const c = { ...a, id: "c", contentSha: "y" };
    expect(sameDataAs(a, [a, b, c]).map((d) => d.id)).toEqual(["b"]);
    expect(sameDataAs({ ...a, contentSha: undefined }, [a, b])).toEqual([]);
  });
});
