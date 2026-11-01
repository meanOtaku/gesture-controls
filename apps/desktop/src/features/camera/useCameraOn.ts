import { useEffect, useState } from "react";
import { getCameraController } from "./cameraService";

/**
 * Whether either camera is on. Re-renders only when that changes, not on every camera frame, so it is cheap to use high
 * in the tree (the navigation's Recorder marker).
 */
export function useCameraOn(): boolean {
  const read = () => [getCameraController("primary"), getCameraController("secondary")].some((camera) => camera.getSnapshot().status === "on");
  const [on, setOn] = useState(read);
  useEffect(() => {
    const update = () => setOn(read());
    const stops = [getCameraController("primary"), getCameraController("secondary")].map((camera) => camera.subscribe(update));
    update();
    return () => stops.forEach((stop) => stop());
  }, []);
  return on;
}
