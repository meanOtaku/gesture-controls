import type { HeadTrackerRuntimeStatus, HeadTrackerStatus } from "../protocol/events";

interface DashboardProps {
  status: HeadTrackerStatus | null;
  runtime: HeadTrackerRuntimeStatus;
  onRecenter: () => void;
}

const number = (value: number, digits = 2) => value.toFixed(digits);
const vector = (values: readonly number[] | null, digits = 3) =>
  values ? `[${values.map((value) => number(value, digits)).join(", ")}]` : "Unavailable";

export function Dashboard({ status, runtime, onRecenter }: DashboardProps) {
  const connected = status?.connected === true || runtime.state === "connected";
  const connectionLabel = connected ? "Connected" : runtime.message;
  const canRecenter = connected && runtime.canRecenter;

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Spatial Gesture Control</p>
          <h1>Head tracker telemetry</h1>
          <p className="subtitle">Sony orientation data, captured inside this app and ready for calibration.</p>
        </div>
        <div className={`connection ${connected ? "online" : "offline"}`}>
          <span className="pulse" />
          {connectionLabel}
        </div>
      </header>

      <section className="device-card">
        <div>
          <span className="label">Active device</span>
          <strong>{status?.device ?? runtime.device ?? "No device detected"}</strong>
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

      <section className="settings tracker-runtime">
        <div>
          <p className="eyebrow">Tracker runtime</p>
          <h2>Built-in Sony tracker</h2>
        </div>
        <div className="runtime-state">
          <span className="label">State</span>
          <strong>{runtime.state}</strong>
          <small>{runtime.message}</small>
        </div>
        <button type="button" onClick={onRecenter} disabled={!canRecenter}>Recenter</button>
        <p className="hint">Tauri discovers and manages the headset directly. No separate tracker application is required.</p>
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
