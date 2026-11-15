import { describe, expect, it } from "vitest";

import { hapticSpans } from "./labellingApi";

describe("hapticSpans", () => {
  it("puts each buzz on the recording's timeline exactly, however large the watch clock", () => {
    const origin = "1763200000123456789";
    expect(hapticSpans([{ timestampNs: "1763200001123456789", durationMs: 20, source: "knob" }], origin)).toEqual([{ startMs: 1000, endMs: 1020, label: "knob" }]);
  });

  it("skips a bad timestamp", () => {
    expect(hapticSpans([{ timestampNs: "x", durationMs: 20, source: "knob" }], "0")).toEqual([]);
  });
});
