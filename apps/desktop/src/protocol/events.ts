export type Vector3 = [number, number, number];
export type Quaternion = [number, number, number, number];

export interface HeadPosePayload {
  device: string | null;
  quaternion: Quaternion;
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
  gyroscope: Vector3 | null;
  packetsPerSecond: number;
  receiveLatencyMs: number;
  resetCounter: number;
}

export interface HeadTrackerStatus extends HeadPosePayload {
  connected: boolean;
}

export type CalibrationTarget = "center" | "topRight";

export interface CalibrationState {
  centerCalibrated: boolean;
  topRightCalibrated: boolean;
  requiresRecalibration: boolean;
  activationThresholdDegrees: number;
  dwellMs: number;
  activeTarget: CalibrationTarget | null;
}

export interface OverlayState {
  visible: boolean;
  grabbed: boolean;
  volume: number;
  rotationAngle: number;
  screenX: number;
  screenY: number;
}

export const HEAD_POSE_EVENT = "head-pose-updated";
export const HEAD_TRACKER_CONNECTION_EVENT = "head-tracker-connection";
export const HEAD_TRACKER_RESET_EVENT = "head-tracker-reset";
export const CALIBRATION_STATE_EVENT = "head-calibration-state";
export const HEAD_TARGET_ENTERED_EVENT = "head-target-entered";
export const HEAD_TARGET_EXITED_EVENT = "head-target-exited";
export const OVERLAY_STATE_EVENT = "overlay-state";
