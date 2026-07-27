export type Vector3 = [number, number, number];
export type Quaternion = [number, number, number, number];

export interface HeadPosePayload {
  timestampNs: number;
  device: string | null;
  quaternion: Quaternion;
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
  gyroscope: Vector3 | null;
  angularVelocity: Vector3 | null;
  accelerometer: Vector3 | null;
  packetsPerSecond: number;
  receiveLatencyMs: number;
  resetCounter: number;
}

export interface HeadTrackerStatus extends HeadPosePayload {
  connected: boolean;
}

export type HeadTrackerRuntimeState =
  | "starting"
  | "searching"
  | "connected"
  | "reconnecting"
  | "permissionRequired"
  | "unsupported"
  | "error"
  | "stopped";

export interface HeadTrackerRuntimeStatus {
  state: HeadTrackerRuntimeState;
  message: string;
  device: string | null;
  revision: number;
  canRecenter: boolean;
}

export interface HeadTrackerResetPayload {
  previous: number;
  current: number;
}

export function newestRuntimeStatus(
  current: HeadTrackerRuntimeStatus,
  incoming: HeadTrackerRuntimeStatus,
): HeadTrackerRuntimeStatus {
  return incoming.revision >= current.revision ? incoming : current;
}

export const HEAD_POSE_EVENT = "head-pose-updated";
export const HEAD_TRACKER_CONNECTION_EVENT = "head-tracker-connection";
export const HEAD_TRACKER_STATUS_EVENT = "head-tracker-status";
export const HEAD_TRACKER_RESET_EVENT = "head-tracker-reset";
