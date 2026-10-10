import { describe, expect, it } from "vitest";
import { alignClocks, proposeIntervals, toAnnotationInterval } from "./proposals";
import { blankDefinition, type GestureDefinition } from "./definition";
import { makeHand } from "./testHands";

const pinch: GestureDefinition = {
  ...blankDefinition(), id: "g1", name: "Pinch", labelId: "pinch",
  conditions: [{ measure: "pinch.index", direction: "below", enter: 0.3, exit: 0.5 }], minHoldMs: 100, releaseGraceMs: 100,
};

/** 30 fps camera frames from 10 000 ms; the pinch is held for frames 30..59 (1 s). */
const frames = Array.from({ length: 120 }, (_, i) => ({
  frameIndex: i, captureMs: 10_000 + i * 33.333,
  hands: [makeHand({ pinch: i >= 30 && i < 60 ? 0.1 : 1.2 })],
}));
/** The watch clock runs 4 000 ms behind the camera's; raw rows every 20 ms from the start of the camera clip. */
const OFFSET = 4000;
const raw = Array.from({ length: 300 }, (_, i) => Math.round((10_000 - OFFSET + i * 20) * 1e6));
const alignment = { offsetMs: OFFSET, jitterMs: 5, samples: 50 };

describe("alignClocks", () => {
  it("takes the fastest sample as the offset and the spread above it as jitter", () => {
    const pairs = Array.from({ length: 20 }, (_, i) => ({ watchTimestampNs: i * 1e8, browserArrivalMs: i * 100 + 4000 + (i % 5 === 0 ? 0 : 8) }));
    const a = alignClocks(pairs)!;
    expect(a.offsetMs).toBeCloseTo(4000, 6);
    expect(a.jitterMs).toBeCloseTo(8, 6);
  });
  it("refuses too few pairs", () => expect(alignClocks([{ watchTimestampNs: 1, browserArrivalMs: 1 }])).toBeNull());
});

describe("proposeIntervals", () => {
  it("turns a hold into the raw rows that span it, on the watch clock", () => {
    const [p] = proposeIntervals({ definitions: [pinch], frames, alignment, rawTimestampsNs: raw, existing: [] });
    expect(p.labelId).toBe("pinch");
    // The pose began at frame 30 = 10 999.99 ms on the camera = 6 999.99 ms on the watch; raw rows start at 6 000 ms, 20 ms apart: row 50.
    expect(p.startRow).toBe(50);
    expect(p.endRow).toBeGreaterThan(p.startRow + 40);
    expect(p.endRow).toBeLessThan(p.startRow + 60);
    expect(p.overlaps).toBe(false);
  });

  it("closes a hold still going at the end of the clip, and ignores gestures with no label", () => {
    const held = frames.map((f) => ({ ...f, hands: [makeHand({ pinch: 0.1 })] }));
    const [p] = proposeIntervals({ definitions: [pinch, { ...pinch, id: "g2", name: "Other", labelId: null }], frames: held, alignment, rawTimestampsNs: raw, existing: [] });
    expect(p.endMs).toBeCloseTo(held[held.length - 1].captureMs, 3);
    expect(proposeIntervals({ definitions: [{ ...pinch, labelId: null }], frames: held, alignment, rawTimestampsNs: raw, existing: [] })).toEqual([]);
  });

  it("flags a proposal that would overlap an existing interval, and drops one outside the recording", () => {
    const [p] = proposeIntervals({ definitions: [pinch], frames, alignment, rawTimestampsNs: raw, existing: [{ startRow: 0, endRow: 60 }] });
    expect(p.overlaps).toBe(true);
    const late = { ...alignment, offsetMs: -100_000 };
    expect(proposeIntervals({ definitions: [pinch], frames, alignment: late, rawTimestampsNs: raw, existing: [] })).toEqual([]);
  });

  it("makes a bundle interval that is an unreviewed camera proposal", () => {
    const [p] = proposeIntervals({ definitions: [pinch], frames, alignment, rawTimestampsNs: raw, existing: [] });
    const interval = toAnnotationInterval(p, raw, "2026-10-09T10:00:00Z");
    expect(interval).toMatchObject({ label_id: "pinch", creation_mechanism: "camera_proposal", curation_status: "unreviewed", revision: 1 });
    expect(interval.resolved_start).toEqual({ raw_row: p.startRow, source_timestamp_ns: raw[p.startRow] });
  });
});

describe("closing and opening stretches", () => {
  const withPhases: GestureDefinition = { ...pinch, closePhase: { labelId: "pinch_close", ms: 500 }, openPhase: { labelId: "pinch_open", ms: 500 } };
  const propose = (over: Partial<Parameters<typeof proposeIntervals>[0]> = {}) =>
    proposeIntervals({ definitions: [withPhases], frames, alignment, rawTimestampsNs: raw, existing: [], ...over });

  it("adds the closing stretch just before the hold and the opening stretch just after it, under their own labels", () => {
    const all = propose();
    const hold = all.find((p) => p.phase === "hold")!;
    const close = all.find((p) => p.phase === "close")!;
    const open = all.find((p) => p.phase === "open")!;
    expect([close.labelId, hold.labelId, open.labelId]).toEqual(["pinch_close", "pinch", "pinch_open"]);
    expect(close.endRow).toBe(hold.startRow - 1);
    expect(open.startRow).toBe(hold.endRow + 1);
    // 500 ms of rows 20 ms apart is 25 rows.
    expect(close.endRow - close.startRow + 1).toBeGreaterThanOrEqual(24);
    expect(open.endRow - open.startRow + 1).toBeGreaterThanOrEqual(24);
    expect(all.map((p) => p.phase)).toEqual(["close", "hold", "open"]); // in time order
    expect(all.every((p) => !p.overlaps && !p.clipped)).toBe(true);
    // None of the three share a row.
    expect(close.endRow).toBeLessThan(hold.startRow);
    expect(open.startRow).toBeGreaterThan(hold.endRow);
  });

  it("proposes no stretch for a gesture that did not ask for them", () => {
    expect(proposeIntervals({ definitions: [pinch], frames, alignment, rawTimestampsNs: raw, existing: [] }).map((p) => p.phase)).toEqual(["hold"]);
  });

  it("shortens a stretch that would run into another interval, and drops one with too little left", () => {
    const hold = propose().find((p) => p.phase === "hold")!;
    // Something already owns rows up to 13 rows before the hold: the closing stretch keeps only the part next to the hold.
    const clipped = propose({ existing: [{ startRow: 0, endRow: hold.startRow - 13 }] }).find((p) => p.phase === "close")!;
    expect(clipped.clipped).toBe(true);
    expect(clipped.startRow).toBe(hold.startRow - 12);
    // 4 rows is under 200 ms: not worth a label.
    expect(propose({ existing: [{ startRow: 0, endRow: hold.startRow - 5 }] }).some((p) => p.phase === "close")).toBe(false);
    // The opening stretch is shortened from its far end.
    const openClipped = propose({ existing: [{ startRow: hold.endRow + 14, endRow: 199 }] }).find((p) => p.phase === "open")!;
    expect(openClipped.endRow).toBe(hold.endRow + 13);
  });

  it("never lets two intervals share a row, even when holds follow each other closely", () => {
    const twice = Array.from({ length: 120 }, (_, i) => ({ frameIndex: i, captureMs: 10_000 + i * 33.333, hands: [makeHand({ pinch: (i >= 30 && i < 50) || (i >= 62 && i < 85) ? 0.1 : 1.2 })] }));
    const all = proposeIntervals({ definitions: [withPhases], frames: twice, alignment, rawTimestampsNs: raw, existing: [] });
    expect(all.filter((p) => p.phase === "hold").length).toBeGreaterThanOrEqual(1);
    const sorted = [...all].sort((a, b) => a.startRow - b.startRow);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i].startRow).toBeGreaterThan(sorted[i - 1].endRow);
  });
});

describe("two cameras", () => {
  const open = frames.map((f) => ({ ...f, hands: [makeHand({ pinch: 1.2 })] }));
  // The second camera's frames are 10 ms offset from the first's, with its own frame numbers.
  const second = frames.map((f, i) => ({ frameIndex: i, captureMs: f.captureMs + 10, hands: f.hands }));
  const run = (over: Partial<Parameters<typeof proposeIntervals>[0]>) =>
    proposeIntervals({ definitions: [pinch], frames, alignment, rawTimestampsNs: raw, existing: [], ...over });

  it("finds a gesture only the second camera saw", () => {
    const [p] = run({ frames: open, secondFrames: second });
    expect(p.phase).toBe("hold");
    expect(p.startRow).toBeGreaterThanOrEqual(49);
    expect(p.startRow).toBeLessThanOrEqual(51);
  });

  it("finds a gesture both saw as one hold, not two, starting at the earlier camera's start", () => {
    const both = run({ frames, secondFrames: second }).filter((p) => p.phase === "hold");
    expect(both).toHaveLength(1);
    const firstOnly = run({}).filter((p) => p.phase === "hold");
    expect(both[0].startRow).toBeLessThanOrEqual(firstOnly[0].startRow);
  });

  it("behaves as before with one camera, and works when only the second camera has frames", () => {
    expect(run({}).filter((p) => p.phase === "hold")).toHaveLength(1);
    expect(run({ frames: [], secondFrames: second }).filter((p) => p.phase === "hold")).toHaveLength(1);
    expect(run({ frames: [], secondFrames: [] })).toEqual([]);
  });
});
