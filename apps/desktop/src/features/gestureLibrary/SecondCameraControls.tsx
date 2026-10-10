import { useSyncExternalStore } from "react";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Label } from "../../components/ui/label";
import type { CameraController, CameraSnapshot } from "../camera/cameraController";
import { dualCameraMode, setDualCameraMode, subscribeDualCameraMode } from "./dualCamera";
import type { CombineMode } from "./combinedDetector";

type Props = {
  primary: CameraController;
  primaryState: CameraSnapshot;
  secondary: CameraController;
  secondaryState: CameraSnapshot;
};

/**
 * The controls for an optional second camera, treated as a separate source: it has its own picture and hand detector, and
 * a gesture counts as seen when either camera sees it (or only when both do). Nothing is lined up between the two. Its
 * picture and camera choice are in `CameraPair`, beside the first camera's.
 */
export function SecondCameraControls({ primary, primaryState, secondary, secondaryState }: Props) {
  const mode = useSyncExternalStore(subscribeDualCameraMode, dualCameraMode, dualCameraMode);
  const on = secondaryState.status === "on";
  const starting = secondaryState.status === "starting";
  const others = primaryState.devices.filter((device) => device.deviceId !== primaryState.deviceId);
  const hands = secondaryState.frame?.hands.length ?? 0;

  const turnOn = () => {
    // The first camera that the primary is not using, unless one was already chosen.
    const chosen = secondaryState.deviceId !== null && secondaryState.deviceId !== primaryState.deviceId ? secondaryState.deviceId : others[0]?.deviceId;
    void secondary.enable(chosen);
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3" role="group" aria-label="Second camera">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <strong className="text-sm">Second camera <small className="text-muted-foreground">(optional)</small></strong>
          <small className="text-xs text-muted-foreground">
            {primaryState.status !== "on"
              ? "Turn the first camera on first."
              : others.length === 0
                ? "No other camera was found. Plug one in and it appears here."
                : "A separate view of your hand. A gesture can be seen by either camera."}
          </small>
        </div>
        <Button type="button" variant={on ? "outline" : "default"} disabled={starting || primaryState.status !== "on" || (!on && others.length === 0)} onClick={() => (on ? secondary.disable() : turnOn())}>
          {starting ? "Starting…" : on ? "Turn second camera off" : "Turn second camera on"}
        </Button>
      </div>
      {secondaryState.error && <Alert variant="destructive" role="alert"><AlertDescription>{secondaryState.error}</AlertDescription></Alert>}
      {on && (
        <>
          <ul className="flex flex-wrap items-center gap-2" aria-label="Second camera status">
            <li><Badge variant={hands > 0 ? "default" : "secondary"}>{hands === 0 ? "No hand in view" : hands === 1 ? "1 hand" : `${hands} hands`}</Badge></li>
            <li><Badge variant="outline">{secondaryState.fps > 0 ? `${secondaryState.fps.toFixed(0)} frames/s` : "waiting for frames"}</Badge></li>
            <li><Badge variant="outline">First camera: {primaryState.fps > 0 ? `${primaryState.fps.toFixed(0)} frames/s` : "waiting"}</Badge></li>
          </ul>
          <div className="field">
            <div className="field-head"><Label htmlFor="dual-mode">A gesture counts when</Label></div>
            <select id="dual-mode" className="recipe-select" value={mode} onChange={(event) => setDualCameraMode(event.target.value as CombineMode)}>
              <option value="either">either camera sees it</option>
              <option value="both">both cameras see it</option>
            </select>
            <p className="field-hint">
              “Either” misses fewer holds but can be fooled by one bad angle. “Both” is stricter. If the frame rates above fall well below 25, two cameras are too much for this computer.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
