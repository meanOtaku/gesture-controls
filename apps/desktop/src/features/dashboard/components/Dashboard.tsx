import { Alert, AlertDescription } from "../../../components/ui/alert";
import type {
  CalibrationState,
  CalibrationTarget,
  HeadTrackerStatus,
  WatchStatus,
} from "../../../shared/protocol/events";
import { CalibrationPanel } from "./CalibrationPanel";
import { HeadphoneTelemetryPanel } from "./HeadphoneTelemetryPanel";
import { OverviewSection } from "./OverviewSection";
import { WatchSensorControls } from "./WatchSensorControls";
import { WatchTelemetryPanel } from "./WatchTelemetryPanel";
import { WatchWellnessPanel } from "./WatchWellnessPanel";

interface DashboardProps {
  view?: "main" | "headphone" | "watch";
  status: HeadTrackerStatus | null;
  calibration?: CalibrationState | null;
  calibrationError?: string | null;
  watchStatus?: WatchStatus | null;
  /** Reports whether the operation for the given key (e.g. `capture:center`, `sensor:orientation`) is in flight. */
  isPending?: (key: string) => boolean;
  onNavigate?: (view: "headphone" | "watch") => void;
  onCaptureTarget?: (target: CalibrationTarget) => void;
  onUpdateCalibration?: (activationThresholdDegrees: number, dwellMs: number) => void;
  onSetSensorEnabled?: (sensor: string, enabled: boolean) => void;
}

const DEFAULT_CALIBRATION: CalibrationState = {
  centerCalibrated: false,
  topRightCalibrated: false,
  requiresRecalibration: true,
  activationThresholdDegrees: 12,
  dwellMs: 400,
  activeTarget: null,
};

export function Dashboard({
  view = "main",
  status,
  calibration,
  calibrationError,
  watchStatus,
  isPending = () => false,
  onNavigate,
  onCaptureTarget = () => undefined,
  onUpdateCalibration = () => undefined,
  onSetSensorEnabled = () => undefined,
}: DashboardProps) {
  const connected = status?.connected === true;
  const calibrationState = calibration ?? DEFAULT_CALIBRATION;
  const calibrated = calibrationState.centerCalibrated && calibrationState.topRightCalibrated && !calibrationState.requiresRecalibration;
  const watchConnected = watchStatus?.connected === true;
  const gestureReady = connected && calibrated && watchConnected;

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Spatial Gesture Control</p>
          <h1>{view === "main" ? "Control center" : view === "headphone" ? "Headphones" : "Galaxy Watch"}</h1>
          <p className="subtitle">{view === "main" ? "Connection status and controls for your gesture-control devices." : view === "headphone" ? "Sony head-tracker telemetry and calibration." : "Watch connection, sensor streams, and button status."}</p>
        </div>
        <div className={`connection ${view === "watch" ? (watchConnected ? "online" : "offline") : (connected ? "online" : "offline")}`}>
          <span className="pulse" />
          {view === "watch"
            ? (watchConnected ? "Watch connected" : "Waiting for watch")
            : (connected ? "Bridge connected" : "Waiting for Sony bridge")}
        </div>
      </header>

      {calibrationError && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{calibrationError}</AlertDescription>
        </Alert>
      )}

      {view === "main" && (
        <OverviewSection
          connected={connected}
          calibrated={calibrated}
          watchConnected={watchConnected}
          gestureReady={gestureReady}
          deviceName={status?.device ?? null}
          onNavigate={onNavigate}
        />
      )}

      {view === "headphone" && !connected && (
        <aside className="connection-help" aria-label="Headphone connection help">
          <h2>Waiting for head-tracking data</h2>
          <p>Pairing alone does not confirm that the headset’s tracking sensor is connected.</p>
          <ol><li>Connect the headset in your computer’s Bluetooth settings.</li><li>On macOS, allow the Sony tracker executable in Privacy &amp; Security → Input Monitoring.</li><li>Stop and restart the project after changing permissions.</li></ol>
        </aside>
      )}
      {view === "watch" && !watchConnected && (
        <aside className="connection-help"><h2>Connect your Watch</h2><p>Open the Watch app, enable streaming, and keep both devices on the same Wi-Fi network. Guest networks may block discovery.</p></aside>
      )}

      {view === "headphone" && <HeadphoneTelemetryPanel status={status} />}
      {view === "headphone" && (
        <CalibrationPanel
          connected={connected}
          calibration={calibrationState}
          isPending={isPending}
          onCaptureTarget={onCaptureTarget}
          onUpdateCalibration={onUpdateCalibration}
        />
      )}

      {view === "watch" && <WatchTelemetryPanel watchStatus={watchStatus ?? null} />}
      {view === "watch" && <WatchWellnessPanel watchStatus={watchStatus ?? null} />}
      {view === "watch" && (
        <WatchSensorControls
          watchStatus={watchStatus ?? null}
          isPending={isPending}
          onSetSensorEnabled={onSetSensorEnabled}
        />
      )}

      {view === "main" && <details className="connection-details"><summary>Connection details</summary><section className="settings">
        <div>
          <p className="eyebrow">Settings</p>
          <h2>Sony UDP input</h2>
        </div>
        <label>Host<input value="127.0.0.1" readOnly /></label>
        <label>JSON port<input value="4243" readOnly /></label>
        <label>Watch WebSocket<input value="0.0.0.0:8766/ws/watch" readOnly /></label>
        <p className="hint">Sony tracking stays on this computer; Watch data arrives over your local network. On macOS, use the arrow or +/- keys to change system volume while the knob is visible.</p>
      </section></details>}
    </main>
  );
}
