import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CameraSnapshot } from "../camera/cameraController";
import type { CameraSlot } from "../camera/handTypes";
import type { GestureDefinition } from "./definition";
import type { AgreementTracker } from "./agreement";
import { CombinedGestureDetector } from "./combinedDetector";
import { dualCameraMode, subscribeDualCameraMode } from "./dualCamera";
import type { GestureEvent, GestureState } from "./detector";

/**
 * Runs the saved gestures over the camera's frames and reports which are held now and how many times each has started.
 * With a second camera running, each camera is checked on its own and their decisions are merged (see
 * `CombinedGestureDetector`); without one this behaves as a single camera.
 */
export function useLiveGestures(
  definitions: GestureDefinition[],
  camera: CameraSnapshot,
  tracker?: AgreementTracker,
  secondary?: CameraSnapshot,
): Map<string, GestureState> {
  const mode = useSyncExternalStore(subscribeDualCameraMode, dualCameraMode, dualCameraMode);
  const detector = useRef(new CombinedGestureDetector(definitions, mode));
  const [states, setStates] = useState<Map<string, GestureState>>(() => detector.current.states());
  const lastFrame = useRef<Record<CameraSlot, number>>({ primary: -1, secondary: -1 });
  const seesHand = useRef<Record<CameraSlot, boolean>>({ primary: false, secondary: false });
  const definitionsRef = useRef(definitions);
  definitionsRef.current = definitions;

  const publish = useCallback(() => {
    const next = detector.current.states();
    setStates((previous) => {
      for (const [id, state] of next) {
        const before = previous.get(id);
        if (!before || before.held !== state.held || before.count !== state.count) return next;
      }
      return previous.size === next.size ? previous : next;
    });
  }, []);

  /** Passes merged starts and ends on to the model-against-camera tracker. */
  const report = useCallback(
    (events: GestureEvent[]) => {
      if (!tracker) return;
      for (const event of events) {
        const label = definitionsRef.current.find((d) => d.id === event.gestureId)?.labelId;
        if (!label) continue;
        if (event.kind === "onset") tracker.cameraOnset(label, event.atMs);
        else tracker.cameraRelease(label, event.atMs);
      }
    },
    [tracker],
  );

  useEffect(() => {
    detector.current.setDefinitions(definitions);
    publish();
  }, [definitions, publish]);

  useEffect(() => {
    report(detector.current.setMode(mode));
    publish();
  }, [mode, report, publish]);

  const status: Record<CameraSlot, boolean> = { primary: camera.status === "on", secondary: secondary?.status === "on" };
  useEffect(() => {
    for (const slot of ["primary", "secondary"] as const) {
      if (!status[slot]) {
        lastFrame.current[slot] = -1;
        seesHand.current[slot] = false;
      }
      report(detector.current.setSlotRunning(slot, status[slot], performance.now()));
    }
    tracker?.setHandInView(performance.now(), seesHand.current.primary || seesHand.current.secondary);
    publish();
    // `status` is rebuilt every render; its two values are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.primary, status.secondary, report, publish, tracker]);

  const feed = useCallback(
    (slot: CameraSlot, frame: CameraSnapshot["frame"]) => {
      if (!frame || frame.frameIndex === lastFrame.current[slot]) return;
      lastFrame.current[slot] = frame.frameIndex;
      seesHand.current[slot] = frame.hands.length > 0;
      report(detector.current.update(slot, frame.captureMs, frame.hands));
      tracker?.setHandInView(frame.captureMs, seesHand.current.primary || seesHand.current.secondary);
      publish();
    },
    [report, publish, tracker],
  );
  useEffect(() => feed("primary", camera.frame), [camera.frame, feed]);
  useEffect(() => feed("secondary", secondary?.frame ?? null), [secondary?.frame, feed]);

  return states;
}
