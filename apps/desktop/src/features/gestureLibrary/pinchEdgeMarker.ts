import type { HandFrame } from "../camera/handTypes";
import { measureHand } from "../camera/landmarkMath";
import { getCameraController } from "../camera/cameraService";
import type { CameraSlot } from "../camera/handTypes";
import { telemetryStore } from "../telemetry/store/telemetryStore";
import type { MarkingCamera } from "./cameraMarker";

/** The label marked where thumb and index meet. */
export const PINCH_IN = "pinch_in";
/** The label marked where they separate again. */
export const PINCH_OUT = "pinch_out";
/** The label on while they stay together, between pinch in and pinch out (optional). */
export const PINCH_HOLD = "pinch_hold";
/** How long each mark lasts: a short stretch at the moment, not the hold. */
export const MARK_MS = 300;
/** A stretch of closed fingers must last this long to be a pinch, not a hand turning past the camera. */
export const MIN_DIP_MS = 150;
/** Closed fingers back within this long are the same pinch, across a dropped frame or a lost hand. */
export const JOIN_MS = 400;
/** A pinch's touch and release are the first and last frames this close to its closest distance, in hand sizes. */
export const NEAR_CLOSEST = 0.1;
/** Until a pinch has been seen, how closed the fingers are taken to get, in hand sizes. */
const EXPECTED_CLOSED = 0.3;
/** The share of the session's distances taken as its open hand, and as its closed hand. */
const OPEN_SHARE = 0.7;
const CLOSED_SHARE = 0.02;
/** A camera reading older than this no longer counts as the hand's current distance. */
const FRESH_MS = 200;
/** Readings needed before the open hand is known; a second or so of camera. */
const WARM_UP_FRAMES = 30;

/** Whether `labels` asks for pinch-in and pinch-out marking: both of them (with `pinch_hold`, the hold is labelled too). */
export function wantsPinchEdges(labels: readonly string[]): boolean {
  return labels.includes(PINCH_IN) && labels.includes(PINCH_OUT);
}

/** The labels pinch marking writes, which no other label may share a recording with. */
export const PINCH_LABELS: readonly string[] = [PINCH_IN, PINCH_HOLD, PINCH_OUT];

/** The part of the telemetry store pinch marking writes to. */
export type PinchMarkingTarget = { addTimelineInterval(label: string, fromMs: number, toMs: number, mechanism: "camera_proposal"): boolean };

export type Pinch = { touchMs: number; releaseMs: number };

/**
 * Each pinch of a recording, judged against this recording's own hand, the rule `scripts/relabel_pinch_from_camera.py`
 * applied to the recordings already made. How close thumb and index look depends on how the hand faces the camera (from
 * about 0.15 to 0.45 hand sizes at their closest), so one fixed level misses whole sessions.
 *
 * A pinch is a stretch of at least `MIN_DIP_MS` below halfway between the open hand (the 70th percentile of the distances
 * so far) and the closed hand (their 2nd, or `EXPECTED_CLOSED` until a pinch has brought it lower), joined across gaps under
 * `JOIN_MS`. Its touch is the first frame within `NEAR_CLOSEST` of its closest distance, and its release the last.
 *
 * Neither is known until the pinch is over, so `update` returns a pinch once the fingers have stayed open for `JOIN_MS`.
 */
export class PinchDips {
  private readonly seen: number[] = []; // kept sorted
  private stretch: { atMs: number; distance: number }[] = [];
  private lastClosedMs = -Infinity;

  private halfway(): number {
    const level = (share: number) => this.seen[Math.floor(share * (this.seen.length - 1))];
    return (level(OPEN_SHARE) + Math.min(level(CLOSED_SHARE), EXPECTED_CLOSED)) / 2;
  }

  private remember(distance: number): void {
    let low = 0;
    let high = this.seen.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.seen[middle] < distance) low = middle + 1;
      else high = middle;
    }
    this.seen.splice(low, 0, distance);
  }

  update(atMs: number, distance: number | null): Pinch | null {
    if (distance !== null) {
      this.remember(distance);
      if (this.seen.length >= WARM_UP_FRAMES && distance < this.halfway()) {
        this.stretch.push({ atMs, distance });
        this.lastClosedMs = atMs;
        return null;
      }
    }
    return atMs - this.lastClosedMs >= JOIN_MS ? this.finish() : null;
  }

  /** The pinch that ended, if the stretch so far is one; the stretch is over either way. */
  finish(): Pinch | null {
    const stretch = this.stretch;
    this.stretch = [];
    if (stretch.length === 0 || stretch[stretch.length - 1].atMs - stretch[0].atMs < MIN_DIP_MS) return null;
    const near = Math.min(...stretch.map((frame) => frame.distance)) + NEAR_CLOSEST;
    const closed = stretch.filter((frame) => frame.distance <= near);
    return { touchMs: closed[0].atMs, releaseMs: closed[closed.length - 1].atMs };
  }
}

/** The thumb-to-index distance of the hand closest to a pinch in a frame, or null with no hand. */
function closestPinch(frame: HandFrame): number | null {
  let closest: number | null = null;
  for (const hand of frame.hands) {
    const distance = measureHand(hand)?.pinch.index ?? null;
    if (distance !== null && (closest === null || distance < closest)) closest = distance;
  }
  return closest;
}

const SLOTS: CameraSlot[] = ["primary", "secondary"];

/**
 * Marks the recording under way with `pinch_in` from where the camera saw thumb and index meet and `pinch_out` from where
 * they parted, each a short unreviewed interval of `MARK_MS` (`pinch_in` cut short if the fingers part sooner). With
 * `withHold`, `pinch_hold` covers the time between them. A pinch is marked a moment after it ends, once `PinchDips` knows its
 * touch and release; one still under way when the recording stops is not marked. It reads the cameras' frames directly, like
 * `startCameraMarking`, so it keeps marking whichever page is open; with both cameras on, the hand closer to a pinch in
 * either counts.
 */
export function startPinchEdgeMarking(
  target: PinchMarkingTarget = telemetryStore,
  cameraFor: (slot: CameraSlot) => MarkingCamera = getCameraController,
  withHold = false,
): () => void {
  const dips = new PinchDips();
  const latest = new Map<CameraSlot, { atMs: number; distance: number | null }>();

  const mark = ({ touchMs, releaseMs }: Pinch) => {
    const inEnd = Math.min(touchMs + MARK_MS, releaseMs);
    // Refused while the recording is still arming: that pinch is not marked.
    if (!target.addTimelineInterval(PINCH_IN, touchMs, inEnd, "camera_proposal")) return;
    if (withHold && inEnd < releaseMs) target.addTimelineInterval(PINCH_HOLD, inEnd, releaseMs, "camera_proposal");
    target.addTimelineInterval(PINCH_OUT, releaseMs, releaseMs + MARK_MS, "camera_proposal");
  };

  const onFrame = (slot: CameraSlot, frame: HandFrame) => {
    latest.set(slot, { atMs: frame.captureMs, distance: closestPinch(frame) });
    const fresh = [...latest.values()].filter((reading) => frame.captureMs - reading.atMs <= FRESH_MS && reading.distance !== null);
    const distance = fresh.length === 0 ? null : Math.min(...fresh.map((reading) => reading.distance as number));
    const pinch = dips.update(frame.captureMs, distance);
    if (pinch) mark(pinch);
  };

  const stops: (() => void)[] = [];
  for (const slot of SLOTS) {
    const camera = cameraFor(slot);
    let lastFrame = -1;
    stops.push(
      camera.subscribeFrames((frame) => {
        if (!frame || frame.frameIndex === lastFrame) return;
        lastFrame = frame.frameIndex;
        onFrame(slot, frame);
      }),
    );
  }
  return () => stops.forEach((stop) => stop());
}
