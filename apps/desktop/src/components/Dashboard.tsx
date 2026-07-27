import type { HeadTrackerStatus } from "../protocol/events";

interface DashboardProps {
  status: HeadTrackerStatus | null;
}

const number = (value: number, digits = 2) => value.toFixed(digits);
const vector = (values: readonly number[] | null, digits = 3) =>
  values ? `[${values.map((value) => number(value, digits)).join(", ")}]` : "Unavailable";

export function Dashboard({ status }: DashboardProps) {
  const connected = status?.connected === true;
  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Spatial Gesture Control</p>
          <h1>Head tracker telemetry</h1>
          <p className="subtitle">Sony orientation data, received locally and ready for calibration.</p>
        </div>
        <div className={`connection ${connected ? "online" : "offline"}`}>
          <span className="pulse" />
          {connected ? "Connected" : "Waiting for Sony tracker"}
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

      <section className="settings">
        <div>
          <p className="eyebrow">Settings</p>
          <h2>Sony UDP input</h2>
        </div>
        <label>Host<input value="127.0.0.1" readOnly /></label>
        <label>JSON port<input value="4243" readOnly /></label>
        <p className="hint">Loopback-only by design. Start sony-head-tracker with JSON output enabled.</p>
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
