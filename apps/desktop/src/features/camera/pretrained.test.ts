import { describe, expect, it } from "vitest";
import { PRETRAINED_GESTURES, pretrainedLabel, pretrainedReading } from "./pretrained";

describe("pretrainedReading", () => {
  it("takes the model's best guess when it is one of the seven gestures", () => {
    expect(pretrainedReading([{ categoryName: "Thumb_Up", score: 0.93 }, { categoryName: "Closed_Fist", score: 0.04 }])).toEqual({ gesture: "Thumb_Up", score: 0.93 });
  });
  it("gives nothing for None, an unknown name, or no answer", () => {
    expect(pretrainedReading([{ categoryName: "None", score: 0.9 }])).toBeUndefined();
    expect(pretrainedReading([{ categoryName: "Wave", score: 0.9 }])).toBeUndefined();
    expect(pretrainedReading([])).toBeUndefined();
    expect(pretrainedReading(undefined)).toBeUndefined();
  });
  it("names every gesture in words", () => {
    expect(PRETRAINED_GESTURES).toHaveLength(7);
    expect(pretrainedLabel("Thumb_Down")).toBe("Thumb down");
    expect(pretrainedLabel("Mystery")).toBe("Mystery");
  });
});
