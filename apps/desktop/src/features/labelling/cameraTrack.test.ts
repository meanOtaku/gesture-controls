import { describe, expect, it } from "vitest";
import { contactOnsets, contactThreshold, DEFAULT_CONTACT_THRESHOLD } from "./cameraTrack";
import { blankDefinition, type GestureDefinition } from "../gestureLibrary/definition";

describe("camera contact", () => {
  it("marks each time the thumb-to-index distance closes past the threshold, once per closing", () => {
    const track = { timesMs: [0, 33, 66, 100, 133, 166, 200], values: [0.9, 0.5, 0.2, 0.1, null, 0.8, 0.2] };
    expect(contactOnsets(track, 0.35)).toEqual([66, 200]);
    // A track that starts closed has no closing until it opens.
    expect(contactOnsets({ timesMs: [0, 33, 66], values: [0.1, 0.9, 0.1] }, 0.35)).toEqual([66]);
  });

  it("takes the threshold from the Gesture library's pinch rule for the label, else a default", () => {
    const pinch: GestureDefinition = { ...blankDefinition(), id: "g1", labelId: "pinch", conditions: [{ measure: "pinch.index", direction: "below", enter: 0.28, exit: 0.4 }] };
    expect(contactThreshold([pinch], "pinch")).toBe(0.28);
    expect(contactThreshold([pinch], "fist")).toBe(DEFAULT_CONTACT_THRESHOLD);
  });
});

describe("the hands at a moment", () => {
  it("are the nearest frame's, if it was taken close enough", async () => {
    const { handsAt } = await import("./cameraTrack");
    const hand = { modelHandedness: "Left" as const, score: 1, image: [], world: [] };
    const track = { timesMs: [0, 100, 200], hands: [[], [hand], []] };
    expect(handsAt(track, 120)).toEqual([hand]);
    expect(handsAt(track, 160)).toEqual([]);
    expect(handsAt(track, 600)).toBeNull();
  });
});
