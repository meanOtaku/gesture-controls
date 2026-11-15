import { Badge } from "../../../components/ui/badge";
import { AnimatedWord } from "../../../components/app/AnimatedNumber";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { SectionHeader } from "../../../components/app/SectionHeader";
import type { WatchStatus } from "../../../shared/protocol/events";
import { number } from "../format";
import { Metric } from "./MetricRow";

type WatchTelemetryPanelProps = {
  watchStatus: WatchStatus | null;
};

/** Galaxy Watch connection, battery, wear and clock sync, and the STEM button. The motion itself is on the live graphs. */
export function WatchTelemetryPanel({ watchStatus }: WatchTelemetryPanelProps) {
  return (
    <Card role="region" aria-label="Watch connection">
      <CardHeader>
        <SectionHeader
          title={watchStatus?.connected ? "Watch connected" : "Waiting for watch"}
          description="Galaxy Watch"
          status={<Badge variant={watchStatus?.connected ? "default" : "secondary"}><AnimatedWord>{watchStatus?.connected ? "Streaming" : "Disconnected"}</AnimatedWord></Badge>}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <section className="metric-grid" aria-label="Watch telemetry">
          <Metric
            label="Battery"
            value={watchStatus?.lastHeartbeat?.batteryPercent != null ? `${number(watchStatus.lastHeartbeat.batteryPercent, 0)}%` : "—"}
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
            label="On wrist"
            value={watchStatus?.worn === true ? "Worn" : watchStatus?.worn === false ? "Not worn · sensors paused" : "—"}
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
      </CardContent>
    </Card>
  );
}
