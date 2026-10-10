import { useEffect, useId } from "react";
import { Label } from "../../../components/ui/label";
import type { CameraController, CameraSnapshot } from "../cameraController";

/**
 * Chooses which camera to use, when the computer has more than one (a built-in and a USB or phone camera, say). Picking
 * while the camera is on switches to it at once; picking while it is off is used the next time it is turned on.
 */
export function CameraPicker({ camera, state }: { camera: CameraController; state: CameraSnapshot }) {
  const id = useId();
  // The list is read when this opens, so a camera plugged in since then is offered.
  useEffect(() => {
    void camera.refreshDevices();
  }, [camera]);
  if (state.devices.length < 2) return null;
  return (
    <div className="field">
      <div className="field-head"><Label htmlFor={id}>Camera</Label></div>
      <select id={id} className="recipe-select" value={state.deviceId ?? ""} onChange={(event) => camera.selectDevice(event.target.value)}>
        {state.deviceId === null && <option value="">Default camera</option>}
        {state.devices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
      </select>
    </div>
  );
}
