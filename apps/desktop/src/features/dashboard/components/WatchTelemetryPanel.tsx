import { Badge } from "../../../components/ui/badge";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { quaternionToEulerDegrees, type WatchStatus } from "../../../shared/protocol/events";
import { number, vector } from "../format";
import { Metric, VectorRow } from "./MetricRow";

type WatchTelemetryPanelProps = {
  watchStatus: WatchStatus | null;
};

/** Galaxy Watch connection state, clock sync, STEM button, and raw IMU telemetry. */
export function WatchTelemetryPanel({ watchStatus }: WatchTelemetryPanelProps) {
  const watchEuler = watchStatus?.lastOrientation
    ? quaternionToEulerDegrees(watchStatus.lastOrientation.quaternion)
    : null;

  return (
    <Card role="region" aria-label="Watch connection">
      <CardHeader>
        <SectionHeader
          title={watchStatus?.connected ? "Watch connected" : "Waiting for watch"}
          description="Galaxy Watch"
          status={<Badge variant={watchStatus?.connected ? "default" : "secondary"}>{watchStatus?.connected ? "Streaming" : "Disconnected"}</Badge>}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <section className="metric-grid" aria-label="Watch telemetry">
          <Metric
            label="Battery"
            value={watchStatus?.lastHeartbeat?.batteryPercent != null ? `${number(watchStatus.lastHeartbeat.batteryPercent, 0)}%` : "—"}
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
          <Metric
            label="STEM button"
            value={
              watchStatus?.lastButtonState === "down" ? "Held"
                : watchStatus?.lastButtonState === "up" ? "Released"
                  : "—"
            }
          />
        </section>
        <div className="vectors">
          <VectorRow label="Quaternion" value={vector(watchStatus?.lastOrientation?.quaternion ?? null)} />
          <VectorRow label="Yaw / pitch / roll" value={vector(watchEuler, 1)} />
          <VectorRow label="Accelerometer" value={vector(watchStatus?.lastOrientation?.accelerometer ?? null)} />
          <VectorRow label="Gyroscope" value={vector(watchStatus?.lastOrientation?.gyroscope ?? null)} />
        </div>
      </CardContent>
    </Card>
  );
}
