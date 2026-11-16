import { getCameraController } from "../camera/cameraService";
import type { CameraSlot } from "../camera/handTypes";
import { telemetryStore } from "../telemetry/store/telemetryStore";
import type { MarkingCamera } from "./cameraMarker";
import { CombinedGestureDetector } from "./combinedDetector";
import type { GestureDefinition } from "./definition";
import type { GestureEvent } from "./detector";
import { MARK_MS, type PinchMarkingTarget } from "./pinchEdgeMarker";

/** A held gesture and the labels of its phases, to mark where the camera sees it. */
export interface PhasedGesture {
  gesture: string;
  start?: string;
  hold?: string;
  end?: string;
}

const SLOTS: CameraSlot[] = ["primary", "secondary"];

/** The intervals one held gesture gives, from when it was first seen to when it was let go (`MARK_MS` long edges). */
export function phaseIntervals(phases: PhasedGesture, onsetMs: number, releaseMs: number): { label: string; fromMs: number; toMs: number }[] {
  const startEnd = Math.min(onsetMs + MARK_MS, releaseMs);
  return [
    ...(phases.start ? [{ label: phases.start, fromMs: onsetMs, toMs: startEnd }] : []),
    ...(phases.hold && startEnd < releaseMs ? [{ label: phases.hold, fromMs: phases.start ? startEnd : onsetMs, toMs: releaseMs }] : []),
    ...(phases.end ? [{ label: phases.end, fromMs: releaseMs, toMs: releaseMs + MARK_MS }] : []),
  ];
}

/**
 * Marks held gestures in their phases, as pinch's finger distance marks pinch in, hold and out, but from each gesture's
 * Gesture library rule: a short start where the camera first sees the gesture, its hold while it lasts, and a short end
 * where it stops. `definitions` whose label is the gesture or one of its phases are its rules; while any of them is held,
 * the gesture is. A gesture is marked when it ends, so one still held when the recording stops is not.
 */
export function startPhaseMarking(
  gestures: PhasedGesture[],
  definitions: GestureDefinition[],
  target: PinchMarkingTarget = telemetryStore,
  cameraFor: (slot: CameraSlot) => MarkingCamera = getCameraController,
): () => void {
  const gestureOf = new Map<string, PhasedGesture>();
  for (const definition of definitions) {
    const owner = gestures.find((g) => definition.labelId !== null && [g.gesture, g.start, g.hold, g.end].includes(definition.labelId));
    if (owner) gestureOf.set(definition.id, owner);
  }
  if (gestureOf.size === 0) return () => undefined;
  const detector = new CombinedGestureDetector(definitions.filter((definition) => gestureOf.has(definition.id)));
  // For each gesture: which of its rules are held now, and when the first of them began.
  const held = new Map<string, { ids: Set<string>; onsetMs: number }>();

  const apply = (events: GestureEvent[]) => {
    for (const event of events) {
      const owner = gestureOf.get(event.gestureId);
      if (!owner) continue;
      const now = held.get(owner.gesture);
      if (event.kind === "onset") {
        if (now) now.ids.add(event.gestureId);
        else held.set(owner.gesture, { ids: new Set([event.gestureId]), onsetMs: event.atMs });
        continue;
      }
      if (!now) continue;
      now.ids.delete(event.gestureId);
      if (now.ids.size > 0) continue;
      held.delete(owner.gesture);
      for (const { label, fromMs, toMs } of phaseIntervals(owner, now.onsetMs, event.atMs)) {
        // Refused while the recording is still arming: that gesture is not marked.
        if (!target.addTimelineInterval(label, fromMs, toMs, "camera_proposal")) break;
      }
    }
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
