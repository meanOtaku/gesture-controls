import { useEffect, useRef, useState } from "react";
import type { CameraSnapshot } from "../camera/cameraController";
import type { GestureDefinition } from "./definition";
import { GestureDetector, type GestureState } from "./detector";

/** Runs the saved gestures over the camera's frames and reports which are held now and how many times each has started. */
export function useLiveGestures(definitions: GestureDefinition[], camera: CameraSnapshot): Map<string, GestureState> {
  const detector = useRef(new GestureDetector(definitions));
  const [states, setStates] = useState<Map<string, GestureState>>(() => detector.current.states());
  const lastFrame = useRef(-1);

  useEffect(() => {
    detector.current.setDefinitions(definitions);
    setStates(detector.current.states());
  }, [definitions]);

  useEffect(() => {
    if (camera.status !== "on") {
      detector.current.reset();
      lastFrame.current = -1;
      setStates(detector.current.states());
    }
  }, [camera.status]);

  useEffect(() => {
    const frame = camera.frame;
    if (!frame || frame.frameIndex === lastFrame.current) return;
    lastFrame.current = frame.frameIndex;
    detector.current.update(frame.captureMs, frame.hands);
    const next = detector.current.states();
    setStates((previous) => {
      for (const [id, state] of next) {
        const before = previous.get(id);
        if (!before || before.held !== state.held || before.count !== state.count) return next;
      }
      return previous.size === next.size ? previous : next;
    });
  }, [camera.frame]);

  return states;
}
