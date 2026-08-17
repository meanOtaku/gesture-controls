import { useRef } from "react";
import type {
  CalibrationState,
  CalibrationTarget,
  HeadTrackerStatus,
  WatchStatus,
} from "../protocol/events";

interface DashboardProps {
  status: HeadTrackerStatus | null;
  calibration?: CalibrationState | null;
  calibrationError?: string | null;
  watchStatus?: WatchStatus | null;
  onCaptureTarget?: (target: CalibrationTarget) => void;
  onUpdateCalibration?: (activationThresholdDegrees: number, dwellMs: number) => void;
}

const number = (value: number, digits = 2) => value.toFixed(digits);
const vector = (values: readonly number[] | null, digits = 3) =>
  values ? `[${values.map((value) => number(value, digits)).join(", ")}]` : "Unavailable";

export function Dashboard({
  status,
  calibration,
  calibrationError,
  watchStatus,
  onCaptureTarget = () => undefined,
  onUpdateCalibration = () => undefined,
}: DashboardProps) {
  const connected = status?.connected === true;
  const thresholdInput = useRef<HTMLInputElement>(null);
  const dwellInput = useRef<HTMLInputElement>(null);
  const calibrationState = calibration ?? {
    centerCalibrated: false,
    topRightCalibrated: false,
    requiresRecalibration: true,
    activationThresholdDegrees: 12,
    dwellMs: 400,
    activeTarget: null,
  };
  const commitCalibrationSettings = () => {
    const threshold = Number(thresholdInput.current?.value);
    const dwell = Number(dwellInput.current?.value);
    if (Number.isFinite(threshold) && threshold >= 1 && threshold <= 180
      && Number.isInteger(dwell) && dwell >= 50 && dwell <= 5000) {
      onUpdateCalibration(threshold, dwell);
    }
  };
  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Spatial Gesture Control</p>
          <h1>Head tracker</h1>
          <p className="subtitle">Sony CLI bridge data, received locally and ready for calibration.</p>
        </div>
        <div className={`connection ${connected ? "online" : "offline"}`}>
          <span className="pulse" />
          {connected ? "Bridge connected" : "Waiting for Sony bridge"}
        </div>
      </header>

      <section className="device-card">
        <div>
          <span className="label">Active device</span>
          <strong>{status?.device ?? "No device detected"}</strong>
        </div>
        <div className="rate">
          <span>{status ? number(status.packetsPerSecond, 1) : "—"}</span>
          <small>packets / sec</small>
        </div>
      </section>

      <section className="metric-grid" aria-label="Sony telemetry">
        <Metric label="Yaw" value={status ? `${number(status.yawDeg)}°` : "—"} accent="cyan" />
        <Metric label="Pitch" value={status ? `${number(status.pitchDeg)}°` : "—"} accent="violet" />
        <Metric label="Roll" value={status ? `${number(status.rollDeg)}°` : "—"} accent="amber" />
        <Metric label="Packet rate" value={status ? `${number(status.packetsPerSecond, 1)} Hz` : "—"} />
        <Metric label="Receive latency" value={status ? `${number(status.receiveLatencyMs, 1)} ms` : "—"} />
        <Metric label="Reset counter" value={status ? String(status.resetCounter) : "—"} />
      </section>

      <section className="vectors">
        <VectorRow label="Quaternion" value={vector(status?.quaternion ?? null)} />
        <VectorRow label="Gyroscope" value={vector(status?.gyroscope ?? null)} />
      </section>

      <section className="calibration-card" aria-label="Head calibration">
        <div className="calibration-heading">
          <div>
            <p className="eyebrow">Head calibration</p>
            <h2>{calibrationState.requiresRecalibration ? "Calibration required" : "Calibration ready"}</h2>
          </div>
          <strong className={`target-state ${calibrationState.activeTarget ? "active" : ""}`}>
            {calibrationState.activeTarget === "topRight"
              ? "Top-right active"
              : calibrationState.activeTarget === "center"
                ? "Center active"
                : "No active target"}
          </strong>
        </div>
        {calibrationState.requiresRecalibration && (
          <p className="calibration-warning">
            Face the screen center, capture it, then look at the top-right corner and capture again.
            A tracker reset clears both targets.
          </p>
        )}
        {calibrationError && <p className="calibration-error" role="alert">{calibrationError}</p>}
        <div className="calibration-actions">
          <button disabled={!connected} onClick={() => onCaptureTarget("center")}>
            Capture center
            <small>{calibrationState.centerCalibrated ? "Saved" : "Not saved"}</small>
          </button>
          <button disabled={!connected} onClick={() => onCaptureTarget("topRight")}>
            Capture top-right
            <small>{calibrationState.topRightCalibrated ? "Saved" : "Not saved"}</small>
          </button>
          <label>
            Threshold
            <input
              aria-label="Activation threshold degrees"
              type="number"
              min="1"
              max="180"
              step="1"
              ref={thresholdInput}
              key={`threshold-${calibrationState.activationThresholdDegrees}`}
              defaultValue={calibrationState.activationThresholdDegrees}
              onBlur={commitCalibrationSettings}
            />
            <small>degrees</small>
          </label>
          <label>
            Dwell
            <input
              aria-label="Activation dwell milliseconds"
              type="number"
              min="50"
              max="5000"
              step="50"
              ref={dwellInput}
              key={`dwell-${calibrationState.dwellMs}`}
              defaultValue={calibrationState.dwellMs}
              onBlur={commitCalibrationSettings}
            />
            <small>milliseconds</small>
          </label>
        </div>
      </section>

      <section className="watch-card" aria-label="Watch connection">
        <div className="calibration-heading">
          <div>
            <p className="eyebrow">Galaxy Watch</p>
            <h2>{watchStatus?.connected ? "Watch connected" : "Waiting for watch"}</h2>
          </div>
          <div className={`connection ${watchStatus?.connected ? "online" : "offline"}`}>
            <span className="pulse" />
            {watchStatus?.connected ? "Streaming" : "Disconnected"}
          </div>
        </div>
        <section className="metric-grid" aria-label="Watch telemetry">
          <Metric
            label="Battery"
            value={watchStatus?.lastHeartbeat ? `${number(watchStatus.lastHeartbeat.batteryPercent ?? 0, 0)}%` : "—"}
          />
          <Metric
            label="Sequence"
            value={watchStatus?.lastOrientation ? String(watchStatus.lastOrientation.sequence) : "—"}
          />
          <Metric
            label="Clock offset"
            value={watchStatus?.clockOffsetNs != null ? `${number(watchStatus.clockOffsetNs / 1_000_000, 2)} ms` : "—"}
          />
          <Metric
            label="Round trip"
            value={watchStatus?.roundTripNs != null ? `${number(watchStatus.roundTripNs / 1_000_000, 2)} ms` : "—"}
          />
        </section>
        <div className="vectors">
          <VectorRow label="Quaternion" value={vector(watchStatus?.lastOrientation?.quaternion ?? null)} />
          <VectorRow label="Accelerometer" value={vector(watchStatus?.lastOrientation?.accelerometer ?? null)} />
          <VectorRow label="Gyroscope" value={vector(watchStatus?.lastOrientation?.gyroscope ?? null)} />
        </div>
      </section>

      <section className="settings">
        <div>
          <p className="eyebrow">Settings</p>
          <h2>Sony UDP input</h2>
        </div>
        <label>Host<input value="127.0.0.1" readOnly /></label>
        <label>JSON port<input value="4243" readOnly /></label>
        <label>Watch WebSocket<input value="0.0.0.0:8766/ws/watch" readOnly /></label>
        <p className="hint">Loopback-only by design. On macOS, use the arrow or +/- keys to change system volume while the knob is visible.</p>
      </section>
    </main>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return <article className={`metric ${accent ?? ""}`}><span className="label">{label}</span><strong>{value}</strong></article>;
}

function VectorRow({ label, value }: { label: string; value: string }) {
  return <div className="vector-row"><span className="label">{label}</span><code>{value}</code></div>;
}
