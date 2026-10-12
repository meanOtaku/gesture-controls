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
 * Marks `label` in the recording under way wherever the cameras see one of its `definitions`, from the moment the
 * recording is armed until the returned stop function runs. It belongs to the recording, not to a page: it reads the
 * cameras' frames directly, so moving to another page keeps marking, and the definitions are fixed when it starts, so
 * choosing another label in the picker mid-recording changes nothing. Marks open where the gesture began and close where
 * it ended, both as the detector timed them.
 */
export function startCameraMarking(
  label: string,
  definitions: GestureDefinition[],
  target: MarkingTarget = telemetryStore,
  cameraFor: (slot: CameraSlot) => MarkingCamera = getCameraController,
): () => void {
  if (definitions.length === 0) return () => undefined;
  const detector = new CombinedGestureDetector([...definitions]);
  const held = new Set<string>();
  let onsetMs: number | undefined;
  let releaseMs = 0;
  // Whether the store still has to be told: it refuses while the recording is arming, so a change is retried on later frames.
  let pending = false;

  const reconcile = () => {
    if (!pending) return;
    const active = target.getActiveTimelineLabel() === label;
    if (held.size > 0) pending = !(active || target.setTimelineLabel(label, "camera_proposal", onsetMs));
    else pending = active && !target.closeTimelineLabelAt(label, releaseMs);
  };

  const apply = (events: GestureEvent[]) => {
    for (const event of events) {
      const wasHeld = held.size > 0;
      if (event.kind === "onset") held.add(event.gestureId);
      else held.delete(event.gestureId);
      if (!wasHeld && held.size > 0) {
        onsetMs = event.atMs;
        pending = true;
      } else if (wasHeld && held.size === 0) {
        releaseMs = event.atMs;
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
