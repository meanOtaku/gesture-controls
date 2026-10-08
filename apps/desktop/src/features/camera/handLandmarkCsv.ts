import { LANDMARK_COUNT, type HandFrame } from "./handTypes";
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
