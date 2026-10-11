import { useState, useSyncExternalStore } from "react";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { telemetryStore } from "../../telemetry/store/telemetryStore";
import { speedLabel } from "../cameraController";
import { getCameraController } from "../cameraService";
import { CameraPreview } from "./CameraPreview";

/**
 * Turn the camera on, see that it is running, look at what it sees, and turn it off, from wherever a page needs the camera.
 * The camera belongs to the app, so this is the same switch as on the Recorder and Gesture library pages. It cannot be
 * turned off while a recording is being made, because the recording would lose its hand landmarks.
 */
export function CameraQuickControl({ preview = true, compact = false }: { /** Offer a small preview of the picture. */ preview?: boolean; compact?: boolean }) {
  const camera = getCameraController();
  const state = useSyncExternalStore(camera.subscribe, camera.getSnapshot, camera.getSnapshot);
  useSyncExternalStore(telemetryStore.subscribe, telemetryStore.getVersion, telemetryStore.getVersion);
  const recording = telemetryStore.getDatasetRecording();
  const [showing, setShowing] = useState(false);
  const on = state.status === "on";
  const starting = state.status === "starting";

  return (
    <div className="flex flex-col gap-2" role="group" aria-label="Camera">
      <div className="flex flex-wrap items-center gap-2">
        {(on || starting) && <Badge variant={on ? "default" : "secondary"}>{starting ? "Camera starting…" : `Camera on · ${speedLabel(state)}`}</Badge>}
        {preview && on && (
          <Button type="button" variant="outline" size="sm" aria-pressed={showing} onClick={() => setShowing((value) => !value)}>{showing ? "Hide preview" : "Show preview"}</Button>
        )}
        <Button
          type="button"
          variant={on ? "outline" : "default"}
          size={compact ? "sm" : "default"}
          disabled={starting || (on && recording)}
          onClick={() => (on ? camera.disable() : void camera.enable())}
        >
          {starting ? "Starting…" : on ? "Turn camera off" : "Turn camera on"}
        </Button>
        {on && recording && <small className="text-muted-foreground">A recording is in progress, so the camera stays on.</small>}
      </div>
      {state.error && <p className="field-error" role="alert">{state.error}</p>}
      {preview && on && showing && (
        <div className="max-w-sm">
          <CameraPreview camera={camera} state={state} hidden={false} />
        </div>
      )}
    </div>
  );
}
