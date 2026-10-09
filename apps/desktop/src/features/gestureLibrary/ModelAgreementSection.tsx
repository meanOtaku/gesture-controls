import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getCameraController } from "../camera/cameraService";
import type { LabelRuntimeStatus } from "../model-lab/labelModels";
import { AgreementTracker } from "./agreement";
import { AgreementPanel } from "./AgreementPanel";
import type { GestureDefinition } from "./definition";
import { listGestureDefinitions } from "./gestureLibraryApi";
import { useLiveGestures } from "./useLiveGestures";

/**
 * The model-against-camera check, for pages that show deployed models. Kept in its own component so the camera's
 * frame-by-frame updates re-render only this card, not the page around it.
 */
export function ModelAgreementSection({ status }: { status: LabelRuntimeStatus | null }) {
  const desktopAvailable = "__TAURI_INTERNALS__" in window;
  const camera = getCameraController();
  const cam = useSyncExternalStore(camera.subscribe, camera.getSnapshot, camera.getSnapshot);
  const tracker = useRef(new AgreementTracker()).current;
  const [definitions, setDefinitions] = useState<GestureDefinition[]>([]);
  useLiveGestures(definitions, cam, tracker);

  useEffect(() => {
    if (!desktopAvailable) return;
    void listGestureDefinitions().then(setDefinitions).catch(() => setDefinitions([]));
  }, [desktopAvailable]);

  return (
    <AgreementPanel
      tracker={tracker}
      definitions={definitions}
      status={status}
      cameraOn={cam.status === "on"}
      onTurnCameraOn={cam.status === "off" || cam.status === "error" ? () => void camera.enable() : undefined}
    />
  );
}
