import { describe, expect, it } from "vitest";
import { caughtStarts, commit, historyOf, lagFromContacts, lagFromDetections, negativeSpanFor, shiftRecordedLabels, lowerBound, minMaxBuckets, NO_LABEL, paint, pan, redo, rowsToDraw, spanAt, undo, zoom, type Span } from "./labellingModel";

const span = (startMs: number, endMs: number, label: string): Span => ({ startMs, endMs, label });

describe("painting hand labels", () => {
  it("cuts back whatever was there, so spans never overlap", () => {
    const spans = paint([span(0, 100, "pinch")], 40, 60, "fist");
    expect(spans.map((s) => s.label)).toEqual(["pinch", "fist", "pinch"]);
    expect(spans[0].endMs).toBeLessThan(40);
    expect(spans[2].startMs).toBeGreaterThan(60);
    expect(spanAt(spans, 50)?.label).toBe("fist");
    expect(spanAt(spans, 20)?.label).toBe("pinch");
  });

  it("erases a stretch, and joins a span to a touching one with the same label", () => {
    const erased = paint([span(0, 100, "pinch")], 0, 30, null);
    expect(erased).toHaveLength(1);
    expect(spanAt(erased, 10)).toBeNull();
    const joined = paint(paint([], 0, 50, "pinch"), 50, 80, "pinch");
    expect(joined).toEqual([span(0, 80, "pinch")]);
  });

  it("takes a selection made right to left", () => {
    expect(paint([], 80, 20, NO_LABEL)).toEqual([span(20, 80, NO_LABEL)]);
  });
});

describe("undo and redo", () => {
  it("steps back and forward through the edits, and a new edit drops what could be redone", () => {
    let history = historyOf([]);
    history = commit(history, [span(0, 10, "pinch")]);
    history = commit(history, [span(0, 20, "pinch")]);
    history = undo(history);
    expect(history.present).toEqual([span(0, 10, "pinch")]);
    history = redo(history);
    expect(history.present).toEqual([span(0, 20, "pinch")]);
    history = commit(undo(history), [span(5, 6, "fist")]);
    expect(history.future).toEqual([]);
    expect(commit(history, history.present)).toBe(history);
  });
});

describe("drawing a long recording", () => {
  it("finds the rows in view and keeps each pixel's lowest and highest value", () => {
    const times = [0, 10, 20, 30, 40];
    expect(lowerBound(times, 15)).toBe(2);
    expect(lowerBound(times, 50)).toBe(5);
    const buckets = minMaxBuckets(times, [1, null, 5, -2, 3], 0, 40, 2);
    expect(buckets).toEqual([{ min: 1, max: 1 }, { min: -2, max: 5 }]);
  });

  it("draws a view between two samples with the samples on either side, so the line reaches both edges", () => {
    const times = [0, 40, 80, 120];
    expect(rowsToDraw(times, 50, 70)).toEqual([1, 2]);
    expect(rowsToDraw(times, 40, 80)).toEqual([0, 2]);
    expect(rowsToDraw(times, 0, 200)).toEqual([0, 3]);
    expect(rowsToDraw([], 0, 10)).toEqual([0, -1]);
  });

  it("zooms around the cursor and pans without leaving the recording", () => {
    expect(zoom({ startMs: 0, endMs: 1000 }, 500, 0.5, 1000)).toEqual({ startMs: 250, endMs: 750 });
    expect(zoom({ startMs: 0, endMs: 1000 }, 0, 4, 1000)).toEqual({ startMs: 0, endMs: 1000 });
    expect(zoom({ startMs: 0, endMs: 100 }, 50, 0.01, 1000).endMs - zoom({ startMs: 0, endMs: 100 }, 50, 0.01, 1000).startMs).toBe(50);
    expect(pan({ startMs: 900, endMs: 1000 }, 500, 1000)).toEqual({ startMs: 900, endMs: 1000 });
    expect(pan({ startMs: 100, endMs: 200 }, -500, 1000)).toEqual({ startMs: 0, endMs: 100 });
  });
});

describe("checking a model on a recording", () => {
  it("counts a detection 680 to 1,280 ms after a start of its gesture as catching it", () => {
    const detections = [span(1700, 1800, "pinch"), span(5000, 5100, "pinch"), span(9500, 9600, "pinch")]; // 1,500 ms after the 8,000 ms start: too late
    expect(caughtStarts(detections, [1000, 8000])).toEqual([true, false, false]);
  });

  it("labels a false detection from 880 ms before it, so training takes that moment as a negative", () => {
    expect(negativeSpanFor(5000)).toEqual({ startMs: 4120, endMs: 5120 });
    expect(negativeSpanFor(300).startMs).toBe(0);
  });
});

describe("how late a recording's labels are", () => {
  it("from the camera: the median gap between label starts and the nearest contact", () => {
    // Labels 300, 350 and 400 ms after the fingers touched; one start has no contact near it.
    expect(lagFromContacts([1300, 5350, 9400, 20000], [1000, 5000, 9000])).toEqual({ lagMs: 350, pairs: 3 });
    expect(lagFromContacts([1300], [1000])).toBeNull();
  });

  it("from the model: the shift that lets its detections catch the most starts", () => {
    // Detections 880 ms after the true starts at 1 s, 5 s and 9 s; the labels say 1.6 s, 5.6 s and 9.6 s (600 ms late).
    const detections = [1880, 5880, 9880].map((at) => span(at, at + 40, "pinch"));
    const found = lagFromDetections([1600, 5600, 9600], detections);
    expect(found?.caught).toBe(3);
    expect(found?.caughtAsIs).toBe(0);
    expect(found!.lagMs).toBeGreaterThanOrEqual(400);
    expect(found!.lagMs).toBeLessThanOrEqual(800);
    expect(lagFromDetections([1000], [])).toBeNull();
  });

  it("moves the recorded labels as hand labels, marking where they were as nothing", () => {
    const moved = shiftRecordedLabels([], [span(1000, 1500, "pinch")], 300);
    expect(spanAt(moved, 800)?.label).toBe("pinch");
    expect(spanAt(moved, 1100)?.label).toBe("pinch");
    expect(spanAt(moved, 1300)?.label).toBe(NO_LABEL);
  });
});

describe("snapping", () => {
  it("moves a moment to the nearest point within the tolerance, and leaves it otherwise", async () => {
    const { snapTo } = await import("./labellingModel");
    expect(snapTo(1040, [500, 1000, 1100], 60)).toBe(1000);
    expect(snapTo(1060, [500, 1000, 1100], 60)).toBe(1100);
    expect(snapTo(800, [500, 1000, 1100], 60)).toBe(800);
    expect(snapTo(10, [], 60)).toBe(10);
  });
});
