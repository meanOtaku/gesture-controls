import { describe, expect, it } from "vitest";
import { inImportOrder, recordingNumber } from "./types";

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
