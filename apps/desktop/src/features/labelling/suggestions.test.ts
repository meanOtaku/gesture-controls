import { describe, expect, it } from "vitest";
import { NO_LABEL } from "./labellingModel";
import { contactSpans, motionBursts, suggestionKey, suggestionsFor } from "./suggestions";

describe("suggested stretches to label", () => {
  it("finds where the fingers were closed, from the fall below the threshold to the rise back", () => {
    const track = { timesMs: [0, 100, 200, 300, 400, 500, 600], values: [0.9, 0.2, 0.1, 0.5, null, 0.1, 0.1] };
    // Closed 100 to 300; closed again from 500, still closed at the end, so it never ends.
    expect(contactSpans(track, 0.35)).toEqual([{ startMs: 100, endMs: 300 }]);
    // Fingers closed from the start are not a closing.
    expect(contactSpans({ timesMs: [0, 100, 200], values: [0.1, 0.1, 0.9] }, 0.35)).toEqual([]);
  });

  it("finds sharp turns of the wrist, well above the recording's usual speed", () => {
    const times = Array.from({ length: 100 }, (_, i) => i * 20);
    const x = times.map((_, i) => (i >= 50 && i <= 56 ? 4 : 0.05 * (i % 3)));
    const zero = times.map(() => 0);
    expect(motionBursts(times, [x, zero, zero])).toEqual([{ startMs: 900, endMs: 1220 }]);
    // A still recording has no bursts in its noise.
    expect(motionBursts(times, [times.map((_, i) => 0.01 * (i % 5)), zero, zero])).toEqual([]);
  });

  it("leaves out what is labelled or skipped, and lets the surer source speak where two agree", () => {
    const suggestions = suggestionsFor({
      contacts: [{ startMs: 1000, endMs: 1400 }, { startMs: 5000, endMs: 5300 }, { startMs: 9000, endMs: 9300 }],
      contactLabel: "pinch",
      falseDetections: [{ startMs: 3000, label: "pinch" }, { startMs: 12_000, label: "pinch" }],
      everydayLabel: "everyday",
      bursts: [{ startMs: 1100, endMs: 1300 }, { startMs: 20_000, endMs: 20_300 }],
      recorded: [{ startMs: 4900, endMs: 5500, label: "pinch" }, { startMs: 11_500, endMs: 11_600, label: NO_LABEL }],
      byHand: [{ startMs: 8900, endMs: 9100, label: NO_LABEL }],
      skipped: new Set([suggestionKey({ source: "motion", startMs: 20_000 })]),
    });
    expect(suggestions.map((s) => [s.source, s.startMs, s.label])).toEqual([
      ["camera", 1000, "pinch"], // the motion burst inside it is the same moment
      ["model", 2120, "everyday"], // 880 ms before the detection
      ["model", 11_120, "everyday"], // a recorded "nothing here" is not a label of the stretch
    ]);
  });
});
