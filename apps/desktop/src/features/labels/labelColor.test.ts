import { describe, expect, it } from "vitest";
import { hashColor, labelColor } from "./labelColor";

describe("a label's colour", () => {
  it("is the Labels tab's, else steady from its name; nothing-here and left-out are fixed", () => {
    expect(labelColor("pinch", [{ id: "pinch", color: "#ff0" }])).toBe("#ff0");
    expect(labelColor("wave", [])).toBe(hashColor("wave"));
    expect(hashColor("wave")).toBe(hashColor("wave"));
    expect(labelColor("-", [{ id: "-", color: "#123" }])).toBe("#8a8a8a");
    expect(labelColor("left_out", [])).toBe("#52525b");
  });
});
