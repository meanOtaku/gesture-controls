import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { getCameraController } from "../camera/cameraService";
import { CameraGestureReporter } from "./cameraGestureReporter";
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
    const follow = () => reporter.setCameraOn(camera.getSnapshot().status === "on");
    const unsubscribe = camera.subscribe(follow);
    const unframes = camera.subscribeFrames((frame) => reporter.onFrame(frame));
    follow();
    // The optional second camera is a separate source; its decisions are merged with the first one's.
    const second = getCameraController("secondary");
    const followSecond = () => reporter.setCameraOn(second.getSnapshot().status === "on", "secondary");
    const unsubscribeSecond = second.subscribe(followSecond);
    const unframesSecond = second.subscribeFrames((frame) => reporter.onFrame(frame, "secondary"));
    followSecond();
    return () => {
      unsubscribe();
      unframes();
      unsubscribeSecond();
      unframesSecond();
      window.removeEventListener(GESTURE_LIBRARY_CHANGED, reload);
      reporter.setCameraOn(false);
      reporter.setCameraOn(false, "secondary");
    };
  }, []);
  return null;
}
