import { Card, CardContent } from "../../../components/ui/card";
import type { HeadTrackerStatus } from "../../../shared/protocol/events";
import { number, vector } from "../format";
import { Metric, VectorRow } from "./MetricRow";

type HeadphoneTelemetryPanelProps = {
  status: HeadTrackerStatus | null;
};

/** Sony head-tracker device identity, packet rate, and raw orientation/gyroscope telemetry. */
export function HeadphoneTelemetryPanel({ status }: HeadphoneTelemetryPanelProps) {
  return (
    <>
      <Card role="region" aria-label="Sony device"><CardContent className="device-card">
        <div><span className="label">Active device</span><strong>{status?.device ?? "No device detected"}</strong></div>
        <div className="rate"><span>{status ? number(status.packetsPerSecond, 1) : "—"}</span><small>packets / sec</small></div>
      </CardContent></Card>

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
    </>
  );
}
