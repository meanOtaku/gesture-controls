import { parseClockSync, parseHandLandmarks } from "../camera/handLandmarkCsv";
import type { HandFrame, TrackedHand } from "../camera/handTypes";
import { measureHand } from "../camera/landmarkMath";
import { alignClocks } from "../gestureLibrary/proposals";
import { lowerBound } from "./labellingModel";
import type { GestureDefinition } from "../gestureLibrary/definition";

/** A pinch's thumb-to-index distance closes past this (hand-size units) when the Gesture library has no pinch of its own. */
export const DEFAULT_CONTACT_THRESHOLD = 0.35;

/**
 * What the camera saw during a recording, on the recording's own timeline: the thumb-to-index distance at each frame (the
 * closest of the hands in view; null with no hand), and how closely the camera and watch clocks line up.
 */
export interface CameraTrack {
  timesMs: number[];
  values: (number | null)[];
  /** The hands the camera saw at each frame, to draw at a moment. */
  hands: TrackedHand[][];
  /** About how far apart the two clocks can be: no contact time is more exact than this. */
  jitterMs: number;
  frames: number;
}

/**
 * The camera track from a recording's saved camera evidence, on the timeline whose zero is `originNs` (the recording's
 * first sample, watch clock). Null with a reason when it cannot be made.
 */
export function cameraTrack(
  evidence: { handLandmarks?: string | null; handLandmarksSecond?: string | null; clockSync: string },
  originNs: number,
): { track: CameraTrack } | { problem: string } {
  const alignment = alignClocks(parseClockSync(evidence.clockSync));
  if (!alignment) return { problem: "the camera and watch clocks could not be lined up (too few clock samples were saved)" };
  const frames: HandFrame[] = [
    ...(evidence.handLandmarks ? parseHandLandmarks(evidence.handLandmarks) : []),
    ...(evidence.handLandmarksSecond ? parseHandLandmarks(evidence.handLandmarksSecond) : []),
  ].sort((a, b) => a.captureMs - b.captureMs);
  if (frames.length === 0) return { problem: "no camera frames were saved" };
  const originMs = originNs / 1e6;
  const timesMs: number[] = [];
  const values: (number | null)[] = [];
  const hands: TrackedHand[][] = [];
  for (const frame of frames) {
    let closest: number | null = null;
    for (const hand of frame.hands) {
      const distance = measureHand(hand)?.pinch.index ?? null;
      if (distance !== null && (closest === null || distance < closest)) closest = distance;
    }
    // The camera's clock is the watch's plus the offset.
    timesMs.push(frame.captureMs - alignment.offsetMs - originMs);
    values.push(closest);
    hands.push(frame.hands);
  }
  return { track: { timesMs, values, hands, jitterMs: alignment.jitterMs, frames: frames.length } };
}

/** The level a pinch closes past: the Gesture library's pinch on `label` (its "below" rule on the index pinch), or the default. */
export function contactThreshold(definitions: GestureDefinition[], label: string): number {
  for (const definition of definitions) {
    if (definition.labelId !== label) continue;
    const rule = definition.conditions.find((condition) => condition.measure === "pinch.index" && condition.direction === "below");
    if (rule) return rule.enter;
  }
  return DEFAULT_CONTACT_THRESHOLD;
}

/** The moments the fingers close: each time the distance falls from at or above `threshold` to below it. */
/** The hands nearest `atMs`, if a frame was taken within `withinMs` of it. */
export function handsAt(track: Pick<CameraTrack, "timesMs" | "hands">, atMs: number, withinMs = 150): TrackedHand[] | null {
  const after = lowerBound(track.timesMs, atMs);
  const nearest = [after - 1, after]
    .filter((i) => i >= 0 && i < track.timesMs.length)
    .sort((a, b) => Math.abs(track.timesMs[a] - atMs) - Math.abs(track.timesMs[b] - atMs))[0];
  return nearest !== undefined && Math.abs(track.timesMs[nearest] - atMs) <= withinMs ? track.hands[nearest] : null;
}

export function contactOnsets(track: Pick<CameraTrack, "timesMs" | "values">, threshold: number): number[] {
  const onsets: number[] = [];
  let open = false;
  track.values.forEach((value, i) => {
    if (value === null) return;
    if (value >= threshold) open = true;
    else if (open) {
      onsets.push(track.timesMs[i]);
      open = false;
    }
  });
  return onsets;
}
