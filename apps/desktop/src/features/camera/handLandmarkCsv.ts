import { LANDMARK_COUNT, type HandFrame, type Point3 } from "./handTypes";
import type { SyncPair } from "./clockSync";

/**
 * The saved camera evidence. The format is fixed by the desktop's bundle writer, which checks the exact header and the
 * field count of every row (`recording_bundle.rs`); a test on each side pins the header.
 *
 * Only landmarks are saved, never the picture. One row per hand per frame; a frame with no hand gets one row with the
 * hand fields empty, so "the camera saw no hand" is recorded rather than being a gap that could be mistaken for a missing
 * frame.
 */
export function handLandmarksHeader(): string {
  const columns = ["frame_index", "capture_ms", "hand_index", "hand_count", "model_handedness", "score"];
  for (const prefix of ["i", "w"]) {
    for (let index = 0; index < LANDMARK_COUNT; index += 1) {
      for (const axis of ["x", "y", "z"]) columns.push(`${prefix}${axis}${index}`);
    }
  }
  return columns.join(",");
}

export const CLOCK_SYNC_HEADER = "watch_timestamp_ns,browser_arrival_ms";
export const HAND_LANDMARKS_FILE = "hand_landmarks.csv";
export const CLOCK_SYNC_FILE = "clock_sync.csv";

const FIELD_COUNT = 6 + 2 * LANDMARK_COUNT * 3;
const num = (value: number, places: number) => (Number.isFinite(value) ? value.toFixed(places) : "");

/** The rows for one frame (no header). */
export function frameToCsvRows(frame: HandFrame): string[] {
  const head = (handIndex: string, model: string, score: string) =>
    [String(frame.frameIndex), frame.captureMs.toFixed(3), handIndex, String(frame.hands.length), model, score];
  if (frame.hands.length === 0) {
    return [[...head("", "", ""), ...new Array<string>(FIELD_COUNT - 6).fill("")].join(",")];
  }
  return frame.hands.map((hand, handIndex) => {
    const fields = [...head(String(handIndex), hand.modelHandedness, num(hand.score, 4))];
    for (const points of [hand.image, hand.world]) {
      for (let i = 0; i < LANDMARK_COUNT; i += 1) {
        const point = points[i];
        fields.push(point ? num(point.x, 5) : "", point ? num(point.y, 5) : "", point ? num(point.z, 5) : "");
      }
    }
    return fields.join(",");
  });
}

export function clockSyncCsv(pairs: SyncPair[]): string {
  return [CLOCK_SYNC_HEADER, ...pairs.map((pair) => `${Math.round(pair.watchTimestampNs)},${pair.browserArrivalMs.toFixed(3)}`)].join("\n");
}

/** Reads `hand_landmarks.csv` back into frames. Rows that do not parse are skipped, so a damaged line costs one hand, not the file. */
export function parseHandLandmarks(text: string): HandFrame[] {
  const frames = new Map<number, HandFrame>();
  const lines = text.split("\n");
  for (let i = 1; i < lines.length; i += 1) {
    const f = lines[i].trim().split(",");
    if (f.length !== FIELD_COUNT) continue;
    const frameIndex = Number(f[0]);
    const captureMs = Number(f[1]);
    if (!Number.isFinite(frameIndex) || !Number.isFinite(captureMs)) continue;
    let frame = frames.get(frameIndex);
    if (!frame) {
      frame = { frameIndex, captureMs, hands: [] };
      frames.set(frameIndex, frame);
    }
    if (f[2] === "") continue; // a frame with no hand
    const handedness = f[4];
    if (handedness !== "Left" && handedness !== "Right") continue;
    const read = (offset: number): Point3[] | null => {
      const points: Point3[] = [];
      for (let k = 0; k < LANDMARK_COUNT; k += 1) {
        const x = Number(f[offset + k * 3]);
        const y = Number(f[offset + k * 3 + 1]);
        const z = Number(f[offset + k * 3 + 2]);
        if (![x, y, z].every(Number.isFinite) || f[offset + k * 3] === "") return null;
        points.push({ x, y, z });
      }
      return points;
    };
    const image = read(6);
    const world = read(6 + LANDMARK_COUNT * 3);
    const score = Number(f[5]);
    if (image && world && Number.isFinite(score)) frame.hands.push({ modelHandedness: handedness, score, image, world });
  }
  return [...frames.values()].sort((a, b) => a.captureMs - b.captureMs);
}

/** Reads `clock_sync.csv`; unreadable lines are skipped. */
export function parseClockSync(text: string): SyncPair[] {
  const pairs: SyncPair[] = [];
  for (const line of text.split("\n").slice(1)) {
    const [watch, arrival] = line.trim().split(",");
    const watchTimestampNs = Number(watch);
    const browserArrivalMs = Number(arrival);
    if (watch && arrival && Number.isFinite(watchTimestampNs) && Number.isFinite(browserArrivalMs)) pairs.push({ watchTimestampNs, browserArrivalMs });
  }
  return pairs;
}
