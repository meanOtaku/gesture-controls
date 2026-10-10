import { useEffect, useId } from "react";
import { Label } from "../../../components/ui/label";
import type { CameraController, CameraSnapshot } from "../cameraController";

/**
 * Chooses which camera to use, when the computer has more than one (a built-in and a USB or phone camera, say). Picking
 * while the camera is on switches to it at once; picking while it is off is used the next time it is turned on.
 */
export function CameraPicker({
  camera,
  state,
  label = "Camera",
  exclude = null,
  minimum = 2,
}: {
  camera: CameraController;
  state: CameraSnapshot;
  label?: string;
  /** A camera to leave out of the list, such as the one another slot is using. */
  exclude?: string | null;
  /** The fewest choices worth showing a dropdown for. */
  minimum?: number;
}) {
  const id = useId();
  // The list is read when this opens, so a camera plugged in since then is offered.
  useEffect(() => {
    void camera.refreshDevices();
  }, [camera]);
  const devices = state.devices.filter((device) => device.deviceId !== exclude);
  if (devices.length < minimum) return null;
  return (
    <div className="field">
      <div className="field-head"><Label htmlFor={id}>{label}</Label></div>
      <select id={id} className="recipe-select" value={devices.some((device) => device.deviceId === state.deviceId) ? (state.deviceId ?? "") : ""} onChange={(event) => event.target.value !== "" && camera.selectDevice(event.target.value)}>
        {(state.deviceId === null || !devices.some((device) => device.deviceId === state.deviceId)) && <option value="">{minimum > 1 ? "Default camera" : "Choose a camera…"}</option>}
        {devices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
      </select>
    </div>
  );
}
