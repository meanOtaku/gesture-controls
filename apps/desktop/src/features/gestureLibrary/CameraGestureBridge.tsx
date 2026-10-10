import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { getCameraController } from "../camera/cameraService";
import { CameraGestureReporter } from "./cameraGestureReporter";
import { dualCameraMode, subscribeDualCameraMode } from "./dualCamera";
import { GESTURE_LIBRARY_CHANGED, listGestureDefinitions } from "./gestureLibraryApi";

/**
 * Always mounted, renders nothing: runs the library's gestures over the camera's frames and reports them to the desktop,
 * where recipes can use them. It keeps working whichever tab is open, as long as the camera is on.
 */
export function CameraGestureBridge() {
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const camera = getCameraController();
    const reporter = new CameraGestureReporter(
      (report) => void invoke("report_camera_gestures", { known: report.known, held: report.held, risen: report.risen }).catch(() => undefined),
      () => performance.now(),
    );
    const reload = () => void listGestureDefinitions().then((all) => reporter.setDefinitions(all)).catch(() => undefined);
    reload();
    window.addEventListener(GESTURE_LIBRARY_CHANGED, reload);
    let lastFrame = -1;
    const follow = () => {
      const snapshot = camera.getSnapshot();
      reporter.setCameraOn(snapshot.status === "on");
      if (snapshot.frame && snapshot.frame.frameIndex !== lastFrame) {
        lastFrame = snapshot.frame.frameIndex;
        reporter.onFrame(snapshot.frame);
      }
    };
    const unsubscribe = camera.subscribe(follow);
    follow();
    // The optional second camera is a separate source; its decisions are merged with the first one's.
    const second = getCameraController("secondary");
    let lastSecondFrame = -1;
    const followSecond = () => {
      const snapshot = second.getSnapshot();
      reporter.setCameraOn(snapshot.status === "on", "secondary");
      if (snapshot.frame && snapshot.frame.frameIndex !== lastSecondFrame) {
        lastSecondFrame = snapshot.frame.frameIndex;
        reporter.onFrame(snapshot.frame, "secondary");
      }
    };
    const unsubscribeSecond = second.subscribe(followSecond);
    followSecond();
    reporter.setMode(dualCameraMode());
    const unsubscribeMode = subscribeDualCameraMode(() => reporter.setMode(dualCameraMode()));
    return () => {
      unsubscribe();
      unsubscribeSecond();
      unsubscribeMode();
      window.removeEventListener(GESTURE_LIBRARY_CHANGED, reload);
      reporter.setCameraOn(false);
      reporter.setCameraOn(false, "secondary");
    };
  }, []);
  return null;
}
