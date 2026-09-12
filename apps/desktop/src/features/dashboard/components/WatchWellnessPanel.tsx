import { HelpTooltip } from "../../../components/app/HelpTooltip";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import type { WatchStatus } from "../../../shared/protocol/events";
import { number, ppgStateLabel } from "../format";
import { Metric, VectorRow } from "./MetricRow";

type WatchWellnessPanelProps = {
  watchStatus: WatchStatus | null;
};

/** Raw PPG stream and Samsung Health Sensor SDK wellness readings; not diagnostic measurements. */
export function WatchWellnessPanel({ watchStatus }: WatchWellnessPanelProps) {
  const medicalStatus = watchStatus?.medicalStatus ?? {};

  return (
    <>
      <Card role="region" aria-label="Watch PPG">
        <CardHeader>
          <SectionHeader
            title={ppgStateLabel(watchStatus?.ppgState ?? null)}
            description="Raw PPG · 25Hz continuous · wellness only, not a medical measurement"
            help={{
              label: "About raw PPG",
              content: "Galaxy Watch 4+ on Samsung Wear OS only (Samsung Health Sensor SDK). Streams at 25Hz while the watch requests a desktop connection. These are raw sensor channels, not a clinical measurement.",
            }}
          />
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <section className="metric-grid" aria-label="PPG telemetry">
            <Metric label="Rate" value={watchStatus?.ppgRateHz != null ? `${number(watchStatus.ppgRateHz, 1)} Hz` : "—"} />
            <Metric label="Green" value={watchStatus?.ppgLastSample ? String(watchStatus.ppgLastSample.green) : "—"} />
            <Metric label="Red" value={watchStatus?.ppgLastSample ? String(watchStatus.ppgLastSample.red) : "—"} />
            <Metric label="IR" value={watchStatus?.ppgLastSample ? String(watchStatus.ppgLastSample.ir) : "—"} />
          </section>
          <div className="vectors">
            <VectorRow
              label="Channel status (green/red/ir)"
              value={
                watchStatus?.ppgLastSample
                  ? `[${watchStatus.ppgLastSample.greenStatus}, ${watchStatus.ppgLastSample.redStatus}, ${watchStatus.ppgLastSample.irStatus}]`
                  : "Unavailable"
              }
            />
          </div>
        </CardContent>
      </Card>

      <Card role="region" aria-label="Watch health sensors">
        <CardHeader>
          <div className="flex items-center gap-2">
            <SectionHeader title="Health sensors" description="Samsung Health Sensor SDK" />
            <HelpTooltip label="About health SDK limitations">
              SpO₂, ECG, and body composition (BIA) are on-demand only: they run one at a time, only while
              the app is in the foreground, and depend on watch hardware and Samsung Health permissions.
              None of these are diagnostic or clinical measurements.
            </HelpTooltip>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <section className="metric-grid" aria-label="Health sensor telemetry">
            <Metric label="Heart rate" value={watchStatus?.heartRateLast ? `${number(watchStatus.heartRateLast.heartRate, 0)} bpm` : "—"} />
            <Metric label="Skin temperature" value={watchStatus?.skinTemperatureLast ? `${number(watchStatus.skinTemperatureLast.objectTemperatureCelsius, 1)} °C` : "—"} />
            <Metric label="EDA" value={watchStatus?.edaLast ? `${number(watchStatus.edaLast.skinConductanceMicrosiemens, 2)} µS` : "—"} />
            <Metric label="SpO₂" value={watchStatus?.spo2Last ? `${number(watchStatus.spo2Last.spo2, 1)}%` : "On-demand"} />
            <Metric label="ECG" value={watchStatus?.ecgLast ? "Session received" : "On-demand"} />
            <Metric label="BIA" value={watchStatus?.biaLast?.bodyFatRatio != null ? `${number(watchStatus.biaLast.bodyFatRatio * 100, 1)}% fat` : "On-demand"} />
          </section>
          <div className="vectors">
            {Object.entries(medicalStatus).map(([tracker, state]) => <VectorRow key={tracker} label={tracker.replaceAll("_", " ")} value={state} />)}
            {Object.keys(medicalStatus).length === 0 && <VectorRow label="SDK capability" value="Waiting for watch sensor status" />}
          </div>
        </CardContent>
      </Card>
    </>
  );
}
