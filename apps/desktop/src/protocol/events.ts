export type Vector3 = [number, number, number];
export type Quaternion = [number, number, number, number];

/** Converts Android's [w, x, y, z] rotation-vector quaternion to yaw/pitch/roll degrees. */
export function quaternionToEulerDegrees([w, x, y, z]: Quaternion): Vector3 {
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x))));
  const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
  const degrees = 180 / Math.PI;
  return [yaw * degrees, pitch * degrees, roll * degrees];
}

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

export interface WatchOrientationSample {
  deviceId: string;
  sequence: number;
  timestampNs: number;
  quaternion: Quaternion;
  accelerometer: Vector3 | null;
  gyroscope: Vector3 | null;
}

export interface WatchHeartbeatSample {
  deviceId: string;
  sequence: number;
  timestampNs: number;
  batteryPercent: number | null;
}

/**
 * Watch-reported `PpgCollector` state (see docs/watch-websocket-protocol.md).
 * Distinct from the WebSocket connection: the watch can be connected with PPG
 * unavailable (non–Galaxy Watch 4+ hardware) or awaiting the Samsung Health
 * permission grant.
 */
export type PpgState =
  | "idle"
  | "permission_required"
  | "connecting"
  | "streaming"
  | "unavailable"
  | "error";

export interface PpgSampleSnapshot {
  timestampNs: number;
  green: number;
  greenStatus: number;
  red: number;
  redStatus: number;
  ir: number;
  irStatus: number;
}

export interface HeartRateSampleSnapshot { timestampNs: number; heartRate: number; heartRateStatus: number; ibiMs: number[]; ibiStatus: number[]; }
export interface SkinTemperatureSampleSnapshot { timestampNs: number; objectTemperatureCelsius: number; ambientTemperatureCelsius: number; status: number; }
export interface EdaSampleSnapshot { timestampNs: number; skinConductanceMicrosiemens: number; status: number; }
export interface Spo2SampleSnapshot { timestampNs: number; spo2: number; heartRate: number; accuracyFlag: number; status: number; }
export interface EcgSampleSnapshot { timestampNs: number; ecgMillivolts: number; leadOff: number; sequenceNumber: number; maxThresholdMillivolts: number; minThresholdMillivolts: number; }
export interface BiaResultSnapshot { progressPercent: number; status: number; bodyFatRatio: number | null; bodyFatMassKg: number | null; totalBodyWaterKg: number | null; skeletalMuscleRatio: number | null; skeletalMuscleMassKg: number | null; basalMetabolicRateKcal: number | null; fatFreeRatio: number | null; fatFreeMassKg: number | null; bodyImpedanceMagnitudeOhm: number | null; bodyImpedanceDegreeDeg: number | null; }
export interface SweatLossSampleSnapshot { timestampNs: number; sweatLossMilliliters: number; status: number; }

export interface WatchStatus {
  connected: boolean;
  lastOrientation: WatchOrientationSample | null;
  lastHeartbeat: WatchHeartbeatSample | null;
  clockOffsetNs: number | null;
  roundTripNs: number | null;
  ppgState: PpgState | null;
  ppgLastSample: PpgSampleSnapshot | null;
  ppgRateHz: number | null;
  /** Latest `watch.button` state ("down"/"up") for the STEM button that grabs the volume overlay. */
  lastButtonState: "down" | "up" | null;
  medicalStatus: Record<string, string>;
  sensorStatus: Record<string, boolean>;
  heartRateLast: HeartRateSampleSnapshot | null;
  heartRateRateHz: number | null;
  skinTemperatureLast: SkinTemperatureSampleSnapshot | null;
  skinTemperatureRateHz: number | null;
  edaLast: EdaSampleSnapshot | null;
  edaRateHz: number | null;
  spo2Last: Spo2SampleSnapshot | null;
  ecgLast: EcgSampleSnapshot | null;
  biaLast: BiaResultSnapshot | null;
  sweatLossLast: SweatLossSampleSnapshot | null;
}

export const HEAD_POSE_EVENT = "head-pose-updated";
export const HEAD_TRACKER_CONNECTION_EVENT = "head-tracker-connection";
export const HEAD_TRACKER_RESET_EVENT = "head-tracker-reset";
export const CALIBRATION_STATE_EVENT = "head-calibration-state";
export const HEAD_TARGET_ENTERED_EVENT = "head-target-entered";
export const HEAD_TARGET_EXITED_EVENT = "head-target-exited";
export const OVERLAY_STATE_EVENT = "overlay-state";
export interface WatchPpgBatch {
  sequence: number;
  timestampsNs: number[];
  green: number[];
  red: number[];
  ir: number[];
}

export const WATCH_PPG_BATCH_EVENT = "watch-ppg-batch";
export const WATCH_STATUS_EVENT = "watch-status";
