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

/** A location id: a short slug such as "center", "topRight" or "leftEdge". Center always exists. */
export type CalibrationTarget = string;

export const CENTER_TARGET: CalibrationTarget = "center";
export const MAX_LOCATION_NAME_CHARS = 32;
export const MAX_LOCATIONS = 12;

export interface CalibrationLocation {
  id: CalibrationTarget;
  name: string;
  calibrated: boolean;
  /** Center: the reference every other location is judged against; it cannot be removed. */
  builtin: boolean;
}

export interface CalibrationState {
  targets: CalibrationLocation[];
  requiresRecalibration: boolean;
  activationThresholdDegrees: number;
  dwellMs: number;
  activeTarget: CalibrationTarget | null;
}

export type HoldGesture = "pinch" | "stemButton" | "shake" | "swipeLeft" | "swipeRight" | "swipeUp" | "swipeDown" | "tap" | "doubleTap" | "rotateClockwise" | "rotateCounterClockwise";
export type RotateDirection = "clockwise" | "counterClockwise";
export type TapKind = "single" | "double";
export type SwipeDirection = "left" | "right" | "up" | "down";
export type WatchWrist = "left" | "right";

export type RecipeAction = "volume" | "brightness" | "scroll" | "playPause" | "nextTrack" | "previousTrack" | "mute";

/** One step of a recipe's chain. A recipe ends with a `drive` stage, which supplies the continuous value. */
export type RecipeStage =
  | { kind: "headAt"; location: CalibrationTarget }
  | { kind: "hold"; hold: HoldGesture }
  | { kind: "drive"; axis: "roll" | "pitch" | "yaw"; deadZoneDegrees: number; invert: boolean };

export interface Recipe {
  id: string;
  name: string;
  enabled: boolean;
  stages: RecipeStage[];
  device: { kind: "rotationKnob" | "horizontalFader" | "verticalFader" | "stepKnob" } & Record<string, number | string>;
  action: RecipeAction;
}

/** Two enabled recipes driving the same resource; both are held off until one is disabled. */
export interface RecipeConflict {
  resource: string;
  first: string;
  second: string;
}

export interface AutomationState {
  recipes: Recipe[];
  blocked: string[];
  conflicts: RecipeConflict[];
}

export interface OverlayState {
  visible: boolean;
  grabbed: boolean;
  volume: number;
  rotationAngle: number;
  screenX: number;
  screenY: number;
  /** The most recent failed native volume read/write's error text; `null` once the last native volume operation succeeded. */
  lastNativeVolumeError: string | null;
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
 * Watch-reported `PpgCollector` state (see docs/protocols/watch-websocket-protocol.md).
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
  /** Watch off-body detector: true on a wrist, false when taken off (the watch then pauses its sensors on purpose), null until reported. */
  worn: boolean | null;
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
export const HEAD_TRACKER_DIAGNOSTIC_EVENT = "head-tracker-diagnostic";

/**
 * Mirrors `HeadTrackerDiagnosticPayload` in
 * `apps/desktop/src-tauri/src/head_pose.rs`. Native-provider-only statuses
 * with no session-event equivalent (scanning, permission denied, device not
 * found/verified, feature write failure, generic error). `null` over
 * `HEAD_TRACKER_DIAGNOSTIC_EVENT` means no active diagnostic.
 */
export interface HeadTrackerDiagnostic {
  id: string;
  title: string;
  detail: string;
  action: string | null;
}
export const AUTOMATION_STATE_EVENT = "automation-state";
/** Sent when brightness or scrolling could not be carried out (a missing permission, an unsupported platform). */
/** Sent each time a shake is recognised, whether or not a recipe uses it. */
export const SHAKE_DETECTED_EVENT = "automation-shake";
/** Sent with the direction each time a swipe is recognised. */
export const SWIPE_DETECTED_EVENT = "automation-swipe";
/** Sent with `single` or `double` each time a tap is recognised. */
export const TAP_DETECTED_EVENT = "automation-tap";
/** Sent with the direction each time a quick wrist twist is recognised. */
export const ROTATE_DETECTED_EVENT = "automation-rotate";
export const ACTION_ERROR_EVENT = "automation-action-error";
export interface ActionError {
  action: RecipeAction;
  message: string;
}
export const CALIBRATION_STATE_EVENT = "head-calibration-state";
export const HEAD_TARGET_ENTERED_EVENT = "head-target-entered";
export const HEAD_TARGET_EXITED_EVENT = "head-target-exited";
export const OVERLAY_STATE_EVENT = "overlay-state";
/** Mirrors `inference::GESTURE_POLICY_EVENT`; a Rust test fails if they differ. */
export const GESTURE_POLICY_EVENT = "gesture-policy-decision";
export interface WatchPpgBatch {
  sequence: number;
  /**
   * Envelope timestamp (watch `SystemClock.elapsedRealtimeNanos()` domain) —
   * the same clock domain `WatchOrientationSample.timestampNs` uses (the watch
   * verifies this per event and rebases orientation if a device's sensor clock
   * differs; see docs/protocols/watch-websocket-protocol.md). Distinct
   * from `timestampsNs` below, which are on the Samsung Health Sensor SDK's
   * own, incomparable per-sample clock (see
   * docs/protocols/watch-websocket-protocol.md).
   */
  timestampNs: number;
  timestampsNs: number[];
  green: number[];
  /** Samsung Health Sensor SDK per-sample PPG status (0 = good contact); used as the dataset "contact quality" signal. */
  greenStatus: number[];
  red: number[];
  redStatus: number[];
  ir: number[];
  irStatus: number[];
}

export const WATCH_PPG_BATCH_EVENT = "watch-ppg-batch";

export interface WatchHeartRateBatch {
  sequence: number;
  timestampsNs: number[];
  heartRate: number[];
  heartRateStatus: number[];
  ibiMs: number[][];
  ibiStatus: number[][];
}

export interface WatchSkinTemperatureBatch {
  sequence: number;
  timestampsNs: number[];
  objectTemperatureCelsius: number[];
  ambientTemperatureCelsius: number[];
  status: number[];
}

export interface WatchEdaBatch {
  sequence: number;
  timestampsNs: number[];
  skinConductanceMicrosiemens: number[];
  status: number[];
}

export const WATCH_HEART_RATE_BATCH_EVENT = "watch-heart-rate-batch";
export const WATCH_SKIN_TEMPERATURE_BATCH_EVENT = "watch-skin-temperature-batch";
export const WATCH_EDA_BATCH_EVENT = "watch-eda-batch";
export const WATCH_STATUS_EVENT = "watch-status";
export const WATCH_ORIENTATION_EVENT = "watch-orientation";

/**
 * Runtime-configurable settings, persisted by the desktop as JSON. Mirrors
 * `AppSettings` in `apps/desktop/src-tauri/src/settings.rs` field-for-field
 * (camelCase). Fetched via `get_settings`, changed via `update_settings`/
 * `reset_settings`, and pushed live on `SETTINGS_UPDATED_EVENT`.
 */
export interface AppSettings {
  headphonesEnabled: boolean;
  headphonesRateHz: number;
  recordingRateHz: number;
  graphRefreshRateHz: number;
  watchOrientationRateHz: number;
  watchAccelerationRateHz: number;
  watchGyroscopeRateHz: number;
  watchPpgFlushRateHz: number;
  watchHeartRateAcceptanceRateHz: number;
  watchSkinTemperatureAcceptanceRateHz: number;
  watchEdaAcceptanceRateHz: number;
  /** How far above the resting signal an acceleration peak must reach to count towards a shake (m/s²); lower is more sensitive. */
  shakePeakThreshold: number;
  /** How many quick strokes back and forth make a shake; fewer is more sensitive. */
  shakeStrokes: number;
  /** How hard a push must be to count as a swipe (m/s²); lower is more sensitive. */
  swipePeakThreshold: number;
  /** How hard a knock on the watch must be to count as a tap (m/s²); lower is more sensitive. */
  tapPeakThreshold: number;
  /** How far the wrist must twist, quickly, to count as a rotate gesture (degrees); smaller is more sensitive. */
  rotateAngleDegrees: number;
  /** Which wrist the watch is worn on: it decides which way along the forearm is left. */
  watchWrist: WatchWrist;
  wristMaxAngularVelocityDegreesPerSecond: number;
  wristMaxVolumePointsPerSecond: number;
  watchSensorsEnabled: Record<string, boolean>;
  /** Which link reaches the Watch. Defaults to Bluetooth, including for settings files written before the field existed. */
  watchTransport: WatchTransport;
}

/** Mirrors `watch_bridge::WatchTransport`. */
export type WatchTransport = "bluetooth" | "wifi";

/** Mirrors `watch_bridge::ble::BleStatus`; `detail` is only set on `failed`. */
export type WatchBleStatus = {
  state: "idle" | "scanning" | "connecting" | "awaitingWatchTrust" | "streaming" | "failed";
  detail?: string;
};

/** Mirrors `watch::WatchTransportStatus`, returned by `get_watch_transport_status`. */
export interface WatchTransportStatus {
  selected: WatchTransport;
  ble: WatchBleStatus;
}

export const SETTINGS_UPDATED_EVENT = "settings-updated";

/** Mirrors `spatial_protocol::IMU_SENSOR_IDS` / `CONTROLLABLE_SENSOR_IDS`. */
export const IMU_SENSOR_IDS = new Set(["orientation", "acceleration", "gyroscope"]);

/** Mirrors `spatial_protocol::CONTROLLABLE_SENSOR_IDS`. */
export const CONTROLLABLE_SENSORS: Array<{ id: string; label: string }> = [
  { id: "orientation", label: "Orientation (rotation vector)" },
  { id: "acceleration", label: "Accelerometer" },
  { id: "gyroscope", label: "Gyroscope" },
  { id: "heart_rate_continuous", label: "Heart rate" },
  { id: "skin_temperature_continuous", label: "Skin temperature" },
  { id: "eda_continuous", label: "EDA" },
];

/** Emitted once a second with the watch link's phase, counters and recent events. */
export const WATCH_LINK_DIAGNOSTICS_EVENT = "watch-link-diagnostics";

export type LinkPhase = "idle" | "scanning" | "connecting" | "awaiting_trust" | "streaming" | "failed" | "listening";

export interface LinkEvent { atUnixMs: number; level: "info" | "warn" | "error"; message: string; }

export interface LinkEnd {
  atUnixMs: number;
  /** `heartbeat_timeout`, `stream_closed`, `write_failed` or `cancelled`. */
  reason: string;
  detail: string;
  sessionSeconds: number;
}

/** Mirrors `watch_bridge::LinkDiagnostics`. */
export interface LinkDiagnostics {
  transport: "bluetooth" | "wifi" | null;
  /** The watch this link is about: a Wi-Fi address, or `watch <id>` for a Bluetooth watch. */
  peer: string | null;
  phase: LinkPhase;
  phaseDetail: string | null;
  sessions: number;
  drops: number;
  scanAttempts: number;
  connectedSinceUnixMs: number | null;
  lastMessageUnixMs: number | null;
  lastEnd: LinkEnd | null;
  messagesReceived: number;
  invalidMessages: number;
  outOfOrderMessages: number;
  writes: number;
  writeFailures: number;
  writeLastMs: number | null;
  writeMaxMs: number | null;
  maxGapMs: number | null;
  mtu: number | null;
  retryInMs: number | null;
  events: LinkEvent[];
}
