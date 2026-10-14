import { describe, expect, it } from "vitest";
import { analyse, firingRate, type MeasureSample } from "./calibration";
import { sampleFrame } from "./sampling";
import { makeHand, type HandSpec } from "./testHands";

/** A small deterministic wobble, so frames of one pose are not identical. */
function wobble(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296 - 0.5;
  };
}

/** `count` frames of a pose with the hand turned, the fingers curled and the thumb moved a little differently each time. */
function frames(pose: "thumbsUp" | "thumbsDown" | "fist" | "open" | "point", count: number, seed: number): MeasureSample[] {
  const random = wobble(seed);
  return Array.from({ length: count }, (_, i) => {
    const curl = (value: number) => Math.min(1, Math.max(0, value + random() * 0.2));
    const spec: HandSpec =
      pose === "open" ? { turnDeg: random() * 60 }
      : pose === "point" ? { curl: { middle: curl(1), ring: curl(1), pinky: curl(1) }, thumb: "tucked", turnDeg: random() * 40 }
      : {
          curl: { index: curl(1), middle: curl(1), ring: curl(1), pinky: curl(1) },
          thumb: pose === "fist" ? "tucked" : "out",
          turnDeg: (pose === "thumbsDown" ? 90 : -90) + random() * 40,
        };
    return sampleFrame({ frameIndex: i, captureMs: i * 33, hands: [makeHand(spec)] }, "either")!;
  });
}

describe("telling similar gestures apart", () => {
  const thumbsUp = frames("thumbsUp", 120, 1);
  const thumbsDown = frames("thumbsDown", 120, 2);
  const fist = frames("fist", 120, 3);
  const background = [...frames("open", 60, 4), ...frames("point", 60, 5)];

  it("with the other gestures recorded, a rule for thumbs up leaves out the fist and the thumbs down", () => {
    const analysis = analyse(thumbsUp, background, [{ name: "Fist", samples: fist }, { name: "Thumbs down", samples: thumbsDown }]);
    expect(analysis.verdict).toBe("good");
    expect(analysis.conditions.map((c) => c.measure)).toContain("thumb.up");
    expect(analysis.confusions.map((c) => c.name).sort()).toEqual(["Fist", "Thumbs down"]);
    for (const confusion of analysis.confusions) expect(confusion.firesOn).toBeLessThan(0.05);
    expect(firingRate(analysis.conditions, thumbsUp)).toBeGreaterThan(0.9);
  });

  it("and a rule for thumbs down the same", () => {
    const analysis = analyse(thumbsDown, background, [{ name: "Fist", samples: fist }, { name: "Thumbs up", samples: thumbsUp }]);
    expect(analysis.conditions.map((c) => c.measure)).toContain("thumb.up");
    expect(analysis.conditions.find((c) => c.measure === "thumb.up")!.direction).toBe("below");
    for (const confusion of analysis.confusions) expect(confusion.firesOn).toBeLessThan(0.05);
  });

  it("and a rule for a fist leaves out both thumbs", () => {
    const analysis = analyse(fist, background, [{ name: "Thumbs up", samples: thumbsUp }, { name: "Thumbs down", samples: thumbsDown }]);
    for (const confusion of analysis.confusions) expect(confusion.firesOn).toBeLessThan(0.05);
    expect(firingRate(analysis.conditions, fist)).toBeGreaterThan(0.9);
  });

  it("warns, naming the gesture, when two gestures cannot be told apart", () => {
    const twin = frames("fist", 120, 9); // the same pose recorded again
    const analysis = analyse(fist, background, [{ name: "Fist copy", samples: twin }]);
    expect(analysis.verdict).toBe("weak");
    expect(analysis.advice).toContain("Fist copy");
    expect(analysis.confusions[0].firesOn).toBeGreaterThan(0.3);
  });

  it("gives the same answer as before when there are no other gestures", () => {
    const analysis = analyse(thumbsUp, background);
    expect(analysis.confusions).toEqual([]);
    expect(analysis.balancedAccuracy).toBeGreaterThan(0.9);
  });
});
