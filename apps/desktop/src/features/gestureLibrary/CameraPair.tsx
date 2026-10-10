import type { CameraController, CameraSnapshot } from "../camera/cameraController";
import { CameraPicker } from "../camera/components/CameraPicker";
import { CameraPreview } from "../camera/components/CameraPreview";

type Props = {
  primary: CameraController;
  primaryState: CameraSnapshot;
  secondary: CameraController;
  secondaryState: CameraSnapshot;
};

/**
 * The cameras' pictures side by side, each with its own camera choice above it. The second column appears once the first
 * camera is on (it needs the camera list, which the system only gives after permission), and shows a picture once the
 * second camera is turned on. On a narrow window the two stack.
 */
export function CameraPair({ primary, primaryState, secondary, secondaryState }: Props) {
  const primaryOn = primaryState.status === "on";
  return (
    <div className="camera-pair">
      <div className="camera-pair-item">
        <CameraPicker camera={primary} state={primaryState} label={secondaryState.status === "on" ? "First camera" : "Camera"} />
        <CameraPreview camera={primary} state={primaryState} hidden={!primaryOn} />
      </div>
      {primaryOn && (
        <div className="camera-pair-item">
          <CameraPicker camera={secondary} state={secondaryState} label="Second camera" exclude={primaryState.deviceId} minimum={1} />
          <CameraPreview camera={secondary} state={secondaryState} hidden={secondaryState.status !== "on"} />
        </div>
      )}
    </div>
  );
}
