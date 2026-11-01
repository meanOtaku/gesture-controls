import type { HandFrame } from "../camera/handTypes";
import { measureHand } from "../camera/landmarkMath";
import { getCameraController } from "../camera/cameraService";
import type { CameraSlot } from "../camera/handTypes";
import { DEFAULT_CONTACT_THRESHOLD } from "../labelling/cameraTrack";
import { telemetryStore } from "../telemetry/store/telemetryStore";
import type { MarkingCamera, MarkingTarget } from "./cameraMarker";

/** The label marked where thumb and index meet. */
export const PINCH_IN = "pinch_in";
/** The label marked where they separate again. */
export const PINCH_OUT = "pinch_out";
/** The label on while they stay together, between pinch in and pinch out (optional). */
export const PINCH_HOLD = "pinch_hold";
/** How long each mark lasts: a short stretch at the moment, not the hold. */
export const MARK_MS = 300;
/** How far past the contact level the fingers must open before a release counts, so a distance hovering at the level does not mark a flurry. */
export const RELEASE_MARGIN = 0.1;
/** A camera reading older than this no longer counts as the hand's current distance. */
const FRESH_MS = 200;
/** With no hand seen for this long, the next reading starts afresh rather than being taken as a touch or a release. */
const LOST_MS = 400;

/** Whether `labels` asks for pinch-in and pinch-out marking: both of them (with `pinch_hold`, the hold is labelled too). */
export function wantsPinchEdges(labels: readonly string[]): boolean {
  return labels.includes(PINCH_IN) && labels.includes(PINCH_OUT);
}

/** The labels pinch marking writes, which no other label may share a recording with. */
export const PINCH_LABELS: readonly string[] = [PINCH_IN, PINCH_HOLD, PINCH_OUT];

export type PinchEdge = { kind: "in" | "out"; atMs: number };

/**
 * The moments thumb and index meet and separate, from their distance in hand sizes (`measureHand(...).pinch.index`).
 * A touch is the frame the distance falls below `contact`, once the fingers have been open (at `contact + RELEASE_MARGIN`
 * or more); a release is timed at the frame it rose back past `contact`, and counted once it reaches the margin. A
 * reading after the hand was lost for a while only sets the state.
 */
export class PinchEdges {
  private state: "unknown" | "open" | "closed" = "unknown";
  private rosePastMs: number | null = null;
  private lastSeenMs = -Infinity;

  constructor(private readonly contact = DEFAULT_CONTACT_THRESHOLD) {}

  update(atMs: number, distance: number | null): PinchEdge | null {
    if (distance === null) {
      if (atMs - this.lastSeenMs > LOST_MS) {
        this.state = "unknown";
        this.rosePastMs = null;
      }
      return null;
    }
    if (atMs - this.lastSeenMs > LOST_MS) this.state = "unknown";
    this.lastSeenMs = atMs;
    const release = this.contact + RELEASE_MARGIN;
    if (this.state === "unknown") {
      this.state = distance < this.contact ? "closed" : distance >= release ? "open" : "unknown";
      this.rosePastMs = null;
      return null;
    }
    if (this.state === "open") {
      if (distance < this.contact) {
        this.state = "closed";
        this.rosePastMs = null;
        return { kind: "in", atMs };
      }
      return null;
    }
    // Closed: note where it rose past the contact level, and count the release once it is clearly open.
    if (distance < this.contact) {
      this.rosePastMs = null;
      return null;
    }
    this.rosePastMs ??= atMs;
    if (distance >= release) {
      this.state = "open";
      const at = this.rosePastMs;
      this.rosePastMs = null;
      return { kind: "out", atMs: at };
    }
    return null;
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
 * Marks the recording under way with `pinch_in` where the camera sees thumb and index meet and `pinch_out` where they
 * separate, each as a short unreviewed interval of `MARK_MS` from that moment (cut short if the next one comes sooner),
 * until the returned stop function runs. With `withHold`, `pinch_hold` is on for the rest of the time they stay together,
 * from the end of pinch in to pinch out (only one label is on at a time, so the three follow each other); if the hand is
 * lost mid-hold, the hold ends at the last frame that saw it. It reads the cameras' frames directly, like
 * `startCameraMarking`, so it keeps marking whichever page is open; with both cameras on, the hand closer to a pinch in
 * either counts. `contact` is the distance, in hand sizes, below which the fingers touch.
 */
export function startPinchEdgeMarking(
  contact = DEFAULT_CONTACT_THRESHOLD,
  target: MarkingTarget = telemetryStore,
  cameraFor: (slot: CameraSlot) => MarkingCamera = getCameraController,
  withHold = false,
): () => void {
  const edges = new PinchEdges(contact);
  const latest = new Map<CameraSlot, { atMs: number; distance: number | null }>();
  // The mark now open, and where it is to end (never, for the hold, until the fingers part).
  let open: { label: string; untilMs: number } | null = null;
  // Whether the fingers are together, and when a hand was last seen.
  let holding = false;
  let lastSeenMs = -Infinity;

  const closeOpen = (atMs: number) => {
    if (open && target.closeTimelineLabelAt(open.label, Math.min(atMs, open.untilMs))) open = null;
    // The store refuses only once the recording has stopped; then there is nothing left to close.
    else if (open && target.getActiveTimelineLabel() !== open.label) open = null;
  };

  const onFrame = (slot: CameraSlot, frame: HandFrame) => {
    latest.set(slot, { atMs: frame.captureMs, distance: closestPinch(frame) });
    if (open && frame.captureMs >= open.untilMs) {
      const endedAt = open.untilMs;
      const ended = open.label;
      closeOpen(endedAt);
      // Pinch in is over and the fingers are still together: the hold takes over from there.
      if (withHold && holding && ended === PINCH_IN && open === null && target.setTimelineLabel(PINCH_HOLD, "camera_proposal", endedAt)) {
        open = { label: PINCH_HOLD, untilMs: Infinity };
      }
    }
    const fresh = [...latest.values()].filter((reading) => frame.captureMs - reading.atMs <= FRESH_MS && reading.distance !== null);
    const distance = fresh.length === 0 ? null : Math.min(...fresh.map((reading) => reading.distance as number));
    if (distance !== null) lastSeenMs = frame.captureMs;
    else if (open?.label === PINCH_HOLD && frame.captureMs - lastSeenMs > LOST_MS) {
      // The hand left mid-hold: end the hold where it was last seen, not at whatever comes next.
      closeOpen(lastSeenMs);
      holding = false;
    }
    const edge = edges.update(frame.captureMs, distance);
    if (!edge) return;
    holding = edge.kind === "in";
    if (open) closeOpen(edge.atMs);
    const label = edge.kind === "in" ? PINCH_IN : PINCH_OUT;
    // Refused while the recording is still arming: that moment is not marked.
    if (target.setTimelineLabel(label, "camera_proposal", edge.atMs)) open = { label, untilMs: edge.atMs + MARK_MS };
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
