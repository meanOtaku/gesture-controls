import { describe, expect, it } from "vitest";
import { recordingTag } from "./recordingTag";

describe("recordingTag", () => {
  it("shows the number a recording came in as, and nothing when it has none", () => {
    expect(recordingTag({ sequence: 3 })).toBe("#3");
    expect(recordingTag({})).toBe("");
    expect(recordingTag({ sequence: 0 })).toBe("");
  });
});
