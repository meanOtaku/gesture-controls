import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getCameraController } from "../camera/cameraService";
import type { LabelRuntimeStatus } from "../model-lab/labelModels";
import { AgreementTracker } from "./agreement";
import { AgreementPanel } from "./AgreementPanel";
import type { GestureDefinition } from "./definition";
import { listGestureDefinitions } from "./gestureLibraryApi";
import { useLiveGestures } from "./useLiveGestures";

/**
 * The model-against-camera check, under Model Lab's detection activity (its one place: it was on the Gestures page and in
 * the Gesture library too). It shows only once it can run: the camera on, a model running, and a library gesture linked
 * to its label; the activity card above it has the camera. Kept in its own component so the camera's frame-by-frame
 * updates re-render only this card, not the page around it.
 */
export function ModelAgreementSection({ status }: { status: LabelRuntimeStatus | null }) {
  const desktopAvailable = "__TAURI_INTERNALS__" in window;
  const camera = getCameraController();
  const cam = useSyncExternalStore(camera.subscribe, camera.getSnapshot, camera.getSnapshot);
  const camera2 = getCameraController("secondary");
  const cam2 = useSyncExternalStore(camera2.subscribe, camera2.getSnapshot, camera2.getSnapshot);
  const tracker = useRef(new AgreementTracker()).current;
  const [definitions, setDefinitions] = useState<GestureDefinition[]>([]);
  useLiveGestures(definitions, cam, tracker, cam2);

  useEffect(() => {
    if (!desktopAvailable) return;
    // Anything but a list (an older desktop, a failed read) means no gestures: Model Lab around it must keep working.
    void listGestureDefinitions().then((all) => setDefinitions(Array.isArray(all) ? all : [])).catch(() => setDefinitions([]));
  }, [desktopAvailable]);

  return (
    <AgreementPanel
      tracker={tracker}
      definitions={definitions}
      status={status}
      cameraOn={cam.status === "on"}
      hideUntilReady
    />
  );
}
