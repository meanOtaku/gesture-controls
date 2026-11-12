import { describe, expect, it } from "vitest";
import { handLandmarksHeader } from "../camera/handLandmarkCsv";
import type { HandFrame } from "../camera/handTypes";
import { KEEP_MS, MissCameraBuffer } from "./missCamera";

const frame = (frameIndex: number, captureMs: number): HandFrame => ({ frameIndex, captureMs, hands: [] });
const sync = (pairs: { watchTimestampNs: number; browserArrivalMs: number }[]) => ({
  pairsBetween: (from: number, to: number) => pairs.filter((pair) => pair.browserArrivalMs >= from && pair.browserArrivalMs <= to),
});

describe("MissCameraBuffer", () => {
  it("keeps the last 45 seconds of frames and forgets older ones", () => {
    const buffer = new MissCameraBuffer(sync([]));
    for (let i = 0; i <= 600; i += 1) buffer.push(frame(i, i * 100));
    // 60 s of frames at 10 a second: the first 15 s are gone.
    expect(buffer.length).toBe(KEEP_MS / 100 + 1);
  });

  it("writes the frames of the 45 seconds before the mark, numbered from 0, with the clock pairs that place them", () => {
    const buffer = new MissCameraBuffer(sync([{ watchTimestampNs: 5e9, browserArrivalMs: 9_500 }, { watchTimestampNs: 9e9, browserArrivalMs: 500_000 }]));
    for (let i = 0; i < 5; i += 1) buffer.push(frame(100 + i, 10_000 + i * 100));
    const files = buffer.files(10_250);
    expect(files).not.toBeNull();
    const rows = files!["hand_landmarks.csv"].trimEnd().split("\n");
    expect(rows[0]).toBe(handLandmarksHeader());
    // Three frames were taken by the mark; the two after it are left out.
    expect(rows.slice(1).map((row) => row.split(",").slice(0, 2))).toEqual([["0", "10000.000"], ["1", "10100.000"], ["2", "10200.000"]]);
    expect(files!["clock_sync.csv"]).toBe("watch_timestamp_ns,browser_arrival_ms\n5000000000,9500.000\n");
  });

  it("has nothing to save with the camera off, or without the watch's clock to place the frames by", () => {
    const empty = new MissCameraBuffer(sync([{ watchTimestampNs: 1, browserArrivalMs: 1 }]));
    expect(empty.files(1_000)).toBeNull();
    const unplaced = new MissCameraBuffer(sync([]));
    unplaced.push(frame(0, 900));
    expect(unplaced.files(1_000)).toBeNull();
  });

  it("starts again when the camera was turned off and on", () => {
    const buffer = new MissCameraBuffer(sync([]));
    buffer.push(frame(50, 5_000));
    buffer.push(frame(0, 4_000));
    expect(buffer.length).toBe(1);
    buffer.clear();
    expect(buffer.length).toBe(0);
  });
});
