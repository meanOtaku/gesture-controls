import type { CameraController } from "../camera/cameraController";
import { getCameraController } from "../camera/cameraService";
import type { CameraSlot } from "../camera/handTypes";
import { telemetryStore } from "../telemetry/store/telemetryStore";
import { CombinedGestureDetector } from "./combinedDetector";
import type { GestureDefinition } from "./definition";
import type { GestureEvent } from "./detector";

/** The parts of the telemetry store the marker writes to. */
export interface MarkingTarget {
  getActiveTimelineLabel(): string | null;
  setTimelineLabel(label: string, mechanism: "camera_proposal", sinceMs?: number): boolean;
  closeTimelineLabelAt(label: string, atMs: number): boolean;
}

/** The parts of a camera the marker reads. */
export type MarkingCamera = Pick<CameraController, "getSnapshot" | "subscribe" | "subscribeFrames">;

const SLOTS: CameraSlot[] = ["primary", "secondary"];

/**
 * Marks the recording under way wherever the cameras see a gesture of one of `labels` (one label or several), from the
 * moment the recording is armed until the returned stop function runs. `definitions` are the gestures to look for; those
 * whose label is not in `labels` are ignored. It belongs to the recording, not to a page: it reads the cameras' frames
 * directly, so moving to another page keeps marking, and the gestures are fixed when it starts, so choosing other labels
 * in the picker mid-recording changes nothing. Marks open where the gesture began and close where it ended, both as the
 * detector timed them.
 *
 * Only one label can be on at a time. If gestures of two labels are held together, the one that began last is marked;
 * when it ends and the other is still held, the other takes over from there. A label's own gestures overlapping simply
 * keep it on until the last ends.
 */
export function startCameraMarking(
  labels: string | string[],
  definitions: GestureDefinition[],
  target: MarkingTarget = telemetryStore,
  cameraFor: (slot: CameraSlot) => MarkingCamera = getCameraController,
): () => void {
  const wanted = new Set(typeof labels === "string" ? [labels] : labels);
  const mine = definitions.filter((definition) => definition.labelId !== null && wanted.has(definition.labelId));
  if (mine.length === 0) return () => undefined;
  const labelOf = new Map(mine.map((definition) => [definition.id, definition.labelId as string]));
  const detector = new CombinedGestureDetector([...mine]);
  // The gestures held now, oldest first, each with when it began.
  const held: { id: string; label: string; onsetMs: number }[] = [];
  let releaseMs = 0;
  // Where the label now wanted on began: the gesture's own onset, or the moment the label that outranked it ended.
  let fromMs = 0;
  // Whether the store still has to be told: it refuses while the recording is arming, so a change is retried on later frames.
  let pending = false;

  const reconcile = () => {
    if (!pending) return;
    const top = held.at(-1);
    const active = target.getActiveTimelineLabel();
    if (top) {
      pending = !(active === top.label || target.setTimelineLabel(top.label, "camera_proposal", fromMs));
    } else {
      // Only a mark the camera made is the camera's to close.
      pending = active !== null && wanted.has(active) && !target.closeTimelineLabelAt(active, releaseMs);
    }
  };

  const apply = (events: GestureEvent[]) => {
    for (const event of events) {
      const before = held.at(-1)?.label ?? null;
      const topId = held.at(-1)?.id ?? null;
      const label = labelOf.get(event.gestureId);
      if (label === undefined) continue;
      if (event.kind === "onset") {
        if (!held.some((entry) => entry.id === event.gestureId)) held.push({ id: event.gestureId, label, onsetMs: event.atMs });
      } else {
        const index = held.findIndex((entry) => entry.id === event.gestureId);
        if (index >= 0) held.splice(index, 1);
      }
      const after = held.at(-1);
      if (after === undefined) {
        releaseMs = event.atMs;
        pending = true;
      } else if (after.id !== topId && (after.label !== before || before === null)) {
        // A new label took over, or the first gesture began, or the one on top ended and an older one is still held.
        fromMs = event.kind === "onset" ? event.atMs : Math.max(event.atMs, after.onsetMs);
        pending = true;
      }
    }
    reconcile();
  };

  const stops: (() => void)[] = [];
  for (const slot of SLOTS) {
    const camera = cameraFor(slot);
    let running = camera.getSnapshot().status === "on";
    let lastFrame = -1;
    apply(detector.setSlotRunning(slot, running, performance.now()));
    stops.push(
      camera.subscribe(() => {
        const now = camera.getSnapshot().status === "on";
        if (now === running) return;
        running = now;
        if (!now) lastFrame = -1;
        apply(detector.setSlotRunning(slot, now, performance.now()));
      }),
      camera.subscribeFrames((frame) => {
        if (!frame || frame.frameIndex === lastFrame) return;
        lastFrame = frame.frameIndex;
        apply(detector.update(slot, frame.captureMs, frame.hands));
      }),
    );
  }
  return () => stops.forEach((stop) => stop());
}
