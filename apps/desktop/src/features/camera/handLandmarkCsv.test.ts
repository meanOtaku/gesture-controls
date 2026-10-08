import { describe, expect, it } from "vitest";
import { clockSyncCsv, frameToCsvRows, handLandmarksHeader, parseClockSync, parseHandLandmarks } from "./handLandmarkCsv";
import type { HandFrame, Point3, TrackedHand } from "./handTypes";

const points = (base: number): Point3[] => Array.from({ length: 21 }, (_, i) => ({ x: base + i / 1000, y: base + i / 100, z: -i / 10000 }));
const hand = (modelHandedness: "Left" | "Right"): TrackedHand => ({ modelHandedness, score: 0.9123456, image: points(0.5), world: points(0) });

describe("hand landmark CSV", () => {
  it("has the header the desktop's bundle writer checks, which is also pinned in Rust", () => {
    const header = handLandmarksHeader();
    expect(header.split(",")).toHaveLength(6 + 2 * 21 * 3);
    expect(header.startsWith("frame_index,capture_ms,hand_index,hand_count,model_handedness,score,ix0,iy0,iz0,ix1,")).toBe(true);
    expect(header.endsWith(",wx20,wy20,wz20")).toBe(true);
    expect(header.split(",").indexOf("wx0")).toBe(6 + 63);
  });

  it("writes one row per hand with the right number of fields", () => {
    const frame: HandFrame = { frameIndex: 7, captureMs: 12345.6789, hands: [hand("Left"), hand("Right")] };
    const rows = frameToCsvRows(frame);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.split(",")).toHaveLength(6 + 126);
    const first = rows[0].split(",");
    expect(first.slice(0, 6)).toEqual(["7", "12345.679", "0", "2", "Left", "0.9123"]);
    expect(first[6]).toBe("0.50000"); // landmark 0's x
    expect(rows[1].split(",")[2]).toBe("1");
  });

  it("writes a frame with no hand as one row with the hand fields empty, so it is not mistaken for a missing frame", () => {
    const rows = frameToCsvRows({ frameIndex: 3, captureMs: 100, hands: [] });
    expect(rows).toHaveLength(1);
    const fields = rows[0].split(",");
    expect(fields).toHaveLength(6 + 126);
    expect(fields.slice(0, 4)).toEqual(["3", "100.000", "", "0"]);
    expect(fields.slice(4).every((f) => f === "")).toBe(true);
  });

  it("leaves a value empty rather than writing NaN", () => {
    const bad = hand("Left");
    bad.world[3] = { x: Number.NaN, y: 0, z: 0 };
    const fields = frameToCsvRows({ frameIndex: 0, captureMs: 0, hands: [bad] })[0].split(",");
    expect(fields).toHaveLength(132);
    expect(fields.some((f) => f === "NaN")).toBe(false);
  });

  it("writes the clock pairs", () => {
    expect(clockSyncCsv([{ watchTimestampNs: 1500.4, browserArrivalMs: 20.12345 }])).toBe("watch_timestamp_ns,browser_arrival_ms\n1500,20.123");
    expect(clockSyncCsv([])).toBe("watch_timestamp_ns,browser_arrival_ms");
  });

  it("reads back what it wrote, including a frame with no hand, and skips a damaged line", () => {
    const frames: HandFrame[] = [
      { frameIndex: 0, captureMs: 100, hands: [hand("Left")] },
      { frameIndex: 1, captureMs: 133.333, hands: [] },
      { frameIndex: 2, captureMs: 166.667, hands: [hand("Right"), hand("Left")] },
    ];
    const text = [handLandmarksHeader(), ...frames.flatMap(frameToCsvRows), "garbage,line"].join("\n");
    const back = parseHandLandmarks(text);
    expect(back.map((f) => [f.frameIndex, f.hands.length])).toEqual([[0, 1], [1, 0], [2, 2]]);
    expect(back[0].hands[0].modelHandedness).toBe("Left");
    expect(back[0].hands[0].score).toBeCloseTo(0.9123, 4);
    expect(back[0].hands[0].image[3].x).toBeCloseTo(0.503, 4);
    expect(back[2].hands[1].world[20].z).toBeCloseTo(-0.002, 4);
    expect(back[1].captureMs).toBeCloseTo(133.333, 3);
  });

  it("reads clock pairs back", () => {
    const pairs = [{ watchTimestampNs: 5_000_000_000, browserArrivalMs: 1234.5 }, { watchTimestampNs: 5_200_000_000, browserArrivalMs: 1434.5 }];
    expect(parseClockSync(clockSyncCsv(pairs))).toEqual(pairs);
    expect(parseClockSync("watch_timestamp_ns,browser_arrival_ms\nx,y\n")).toEqual([]);
  });
});
