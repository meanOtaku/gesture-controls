import { useRef } from "react";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { CONTROLLABLE_SENSORS, type AppSettings, type OverlayState, type WatchStatus } from "../../../shared/protocol/events";
import { ApplySettingsFooter } from "./ApplySettingsFooter";
import { CornerWristVolumeDemoSection } from "./CornerWristVolumeDemoSection";
import { CornerWristVolumeDiagnosticsSection } from "./CornerWristVolumeDiagnosticsSection";
import { HeadphonesSettingsSection } from "./HeadphonesSettingsSection";
import { RecordingGraphSettingsSection } from "./RecordingGraphSettingsSection";
import { WatchHealthDeliverySettingsSection } from "./WatchHealthDeliverySettingsSection";
import { WatchRateSettingsSection } from "./WatchRateSettingsSection";
import { WatchSensorSwitchSection } from "./WatchSensorSwitchSection";
import { WristRotationSettings } from "./WristRotationSettings";

const EMPTY_OVERLAY_STATE: OverlayState = {
  visible: false,
  grabbed: false,
  volume: 50,
  rotationAngle: 0,
  screenX: 0,
  screenY: 0,
  cornerDemoPhase: null,
  lastRelativeRollDegrees: null,
  lastNativeVolumeError: null,
};

interface SettingsProps {
  settings: AppSettings | null;
  error?: string | null;
  /** Reports whether the operation for the given key (`settings:apply`, `settings:reset`) is in flight. */
  isPending?: (key: string) => boolean;
  overlay?: OverlayState;
  watchStatus?: WatchStatus | null;
  onUpdate: (settings: AppSettings) => void;
  onReset: () => void;
}

/** Mirrors `AppSettings::default()` in `apps/desktop/src-tauri/src/settings.rs`, used only until the real settings load. */
const DEFAULT_SETTINGS: AppSettings = {
  headphonesEnabled: true,
  headphonesRateHz: 60,
  recordingRateHz: 30,
  graphRefreshRateHz: 15,
  watchOrientationRateHz: 50,
  watchAccelerationRateHz: 50,
  watchGyroscopeRateHz: 50,
  watchPpgFlushRateHz: 1,
  watchHeartRateAcceptanceRateHz: 200,
  watchSkinTemperatureAcceptanceRateHz: 200,
  watchEdaAcceptanceRateHz: 200,
  wristDeadZoneDegrees: 3,
  wristSmoothingAlpha: 0.2,
  wristVolumePointsPerDegree: 1 / 3,
  wristMaxAngularVelocityDegreesPerSecond: 360,
  wristMaxVolumePointsPerSecond: 30,
  watchSensorsEnabled: Object.fromEntries(CONTROLLABLE_SENSORS.map(({ id }) => [id, true])),
  cornerWristVolumeDemoEnabled: false,
  cornerWristVolumeInvertDirection: false,
};

function clamp(raw: string | undefined, min: number, max: number, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

export function Settings({
  settings,
  error,
  isPending = () => false,
  overlay = EMPTY_OVERLAY_STATE,
  watchStatus = null,
  onUpdate,
  onReset,
}: SettingsProps) {
  const current = settings ?? DEFAULT_SETTINGS;
  const headphonesRateInput = useRef<HTMLInputElement>(null);
  const recordingRateInput = useRef<HTMLInputElement>(null);
  const graphRefreshRateInput = useRef<HTMLInputElement>(null);
  const watchOrientationRateInput = useRef<HTMLInputElement>(null);
  const watchAccelerationRateInput = useRef<HTMLInputElement>(null);
  const watchGyroscopeRateInput = useRef<HTMLInputElement>(null);
  const watchPpgFlushRateInput = useRef<HTMLInputElement>(null);
  const watchHeartRateAcceptanceRateInput = useRef<HTMLInputElement>(null);
  const watchSkinTemperatureAcceptanceRateInput = useRef<HTMLInputElement>(null);
  const watchEdaAcceptanceRateInput = useRef<HTMLInputElement>(null);
  const wristDeadZoneInput = useRef<HTMLInputElement>(null);
  const wristSmoothingInput = useRef<HTMLInputElement>(null);
  const wristSensitivityInput = useRef<HTMLInputElement>(null);
  const wristVelocityInput = useRef<HTMLInputElement>(null);
  const wristVolumeRateInput = useRef<HTMLInputElement>(null);

  const commitRates = () => {
    onUpdate({
      ...current,
      headphonesRateHz: clamp(headphonesRateInput.current?.value, 1, 200, current.headphonesRateHz),
      recordingRateHz: clamp(recordingRateInput.current?.value, 1, 200, current.recordingRateHz),
      graphRefreshRateHz: clamp(graphRefreshRateInput.current?.value, 1, 60, current.graphRefreshRateHz),
      watchOrientationRateHz: clamp(watchOrientationRateInput.current?.value, 1, 200, current.watchOrientationRateHz),
      watchAccelerationRateHz: clamp(watchAccelerationRateInput.current?.value, 1, 200, current.watchAccelerationRateHz),
      watchGyroscopeRateHz: clamp(watchGyroscopeRateInput.current?.value, 1, 200, current.watchGyroscopeRateHz),
      watchPpgFlushRateHz: clamp(watchPpgFlushRateInput.current?.value, 0.1, 10, current.watchPpgFlushRateHz),
      watchHeartRateAcceptanceRateHz: clamp(watchHeartRateAcceptanceRateInput.current?.value, 0.1, 200, current.watchHeartRateAcceptanceRateHz),
      watchSkinTemperatureAcceptanceRateHz: clamp(watchSkinTemperatureAcceptanceRateInput.current?.value, 0.1, 200, current.watchSkinTemperatureAcceptanceRateHz),
      watchEdaAcceptanceRateHz: clamp(watchEdaAcceptanceRateInput.current?.value, 0.1, 200, current.watchEdaAcceptanceRateHz),
      wristDeadZoneDegrees: clamp(wristDeadZoneInput.current?.value, 0, 45, current.wristDeadZoneDegrees),
      wristSmoothingAlpha: clamp(wristSmoothingInput.current?.value, 0.01, 1, current.wristSmoothingAlpha),
      wristVolumePointsPerDegree: clamp(wristSensitivityInput.current?.value, 0.01, 5, current.wristVolumePointsPerDegree),
      wristMaxAngularVelocityDegreesPerSecond: clamp(wristVelocityInput.current?.value, 1, 2000, current.wristMaxAngularVelocityDegreesPerSecond),
      wristMaxVolumePointsPerSecond: clamp(wristVolumeRateInput.current?.value, 1, 100, current.wristMaxVolumePointsPerSecond),
    });
  };

  const toggleHeadphonesEnabled = () => onUpdate({ ...current, headphonesEnabled: !current.headphonesEnabled });
  const toggleCornerWristVolumeDemoEnabled = () =>
    onUpdate({ ...current, cornerWristVolumeDemoEnabled: !current.cornerWristVolumeDemoEnabled });
  const toggleCornerWristVolumeInvertDirection = () =>
    onUpdate({ ...current, cornerWristVolumeInvertDirection: !current.cornerWristVolumeInvertDirection });
  const toggleWatchSensor = (id: string) =>
    onUpdate({
      ...current,
      watchSensorsEnabled: { ...current.watchSensorsEnabled, [id]: !(current.watchSensorsEnabled[id] ?? true) },
    });

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Spatial Gesture Control</p>
          <h1>Settings</h1>
          <p className="subtitle">Edit acceptance, recording, and sampling rates, then apply them together without restarting. Sensor switches remain immediate.</p>
        </div>
      </header>

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <HeadphonesSettingsSection
        enabled={current.headphonesEnabled}
        rateHz={current.headphonesRateHz}
        rateInputRef={headphonesRateInput}
        onToggleEnabled={toggleHeadphonesEnabled}
      />

      <WristRotationSettings
        deadZoneDegrees={current.wristDeadZoneDegrees}
        smoothingAlpha={current.wristSmoothingAlpha}
        volumePointsPerDegree={current.wristVolumePointsPerDegree}
        maxAngularVelocityDegreesPerSecond={current.wristMaxAngularVelocityDegreesPerSecond}
        maxVolumePointsPerSecond={current.wristMaxVolumePointsPerSecond}
        deadZoneInputRef={wristDeadZoneInput}
        smoothingInputRef={wristSmoothingInput}
        sensitivityInputRef={wristSensitivityInput}
        velocityInputRef={wristVelocityInput}
        volumeRateInputRef={wristVolumeRateInput}
      />

      <RecordingGraphSettingsSection
        recordingRateHz={current.recordingRateHz}
        graphRefreshRateHz={current.graphRefreshRateHz}
        recordingRateInputRef={recordingRateInput}
        graphRefreshRateInputRef={graphRefreshRateInput}
      />

      <WatchRateSettingsSection
        orientationRateHz={current.watchOrientationRateHz}
        accelerationRateHz={current.watchAccelerationRateHz}
        gyroscopeRateHz={current.watchGyroscopeRateHz}
        orientationRateInputRef={watchOrientationRateInput}
        accelerationRateInputRef={watchAccelerationRateInput}
        gyroscopeRateInputRef={watchGyroscopeRateInput}
      />

      <WatchHealthDeliverySettingsSection
        ppgFlushRateHz={current.watchPpgFlushRateHz}
        heartRateAcceptanceRateHz={current.watchHeartRateAcceptanceRateHz}
        skinTemperatureAcceptanceRateHz={current.watchSkinTemperatureAcceptanceRateHz}
        edaAcceptanceRateHz={current.watchEdaAcceptanceRateHz}
        ppgFlushRateInputRef={watchPpgFlushRateInput}
        heartRateAcceptanceRateInputRef={watchHeartRateAcceptanceRateInput}
        skinTemperatureAcceptanceRateInputRef={watchSkinTemperatureAcceptanceRateInput}
        edaAcceptanceRateInputRef={watchEdaAcceptanceRateInput}
      />

      <WatchSensorSwitchSection watchSensorsEnabled={current.watchSensorsEnabled} onToggle={toggleWatchSensor} />

      <CornerWristVolumeDemoSection
        enabled={current.cornerWristVolumeDemoEnabled}
        invertDirection={current.cornerWristVolumeInvertDirection}
        onToggleEnabled={toggleCornerWristVolumeDemoEnabled}
        onToggleInvertDirection={toggleCornerWristVolumeInvertDirection}
      />

      {current.cornerWristVolumeDemoEnabled && (
        <CornerWristVolumeDiagnosticsSection
          overlay={overlay}
          watchStatus={watchStatus}
          invertDirection={current.cornerWristVolumeInvertDirection}
        />
      )}

      <ApplySettingsFooter
        applyPending={isPending("settings:apply")}
        resetPending={isPending("settings:reset")}
        onApply={commitRates}
        onReset={onReset}
      />
    </main>
  );
}
