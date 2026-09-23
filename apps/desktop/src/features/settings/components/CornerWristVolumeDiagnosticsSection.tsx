import { useEffect, useReducer, useRef } from "react";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Metric, VectorRow } from "../../dashboard/components/MetricRow";
import { number } from "../../dashboard/format";
import type { CornerWristVolumeDemoPhase, OverlayState, WatchStatus } from "../../../shared/protocol/events";

type CornerWristVolumeDiagnosticsSectionProps = {
  overlay: OverlayState;
  watchStatus: WatchStatus | null;
  invertDirection: boolean;
};

const CORNER_GATE_LABEL: Record<CornerWristVolumeDemoPhase, string> = {
  targeting: "Targeting",
  ready: "Ready",
  adjusting: "Adjusting",
  unavailableNoOrientation: "Unavailable — no orientation",
  unavailableVolumeUnsupported: "Unavailable — volume unsupported",
};

/**
 * A live sample is expected roughly every 20ms (50Hz); 500ms is generous
 * headroom before treating the Watch orientation feed as stale, so brief
 * scheduling jitter never flickers "live" to "stale" and back.
 */
const ORIENTATION_STALE_THRESHOLD_MS = 500;
const ORIENTATION_STALE_POLL_MS = 250;

/**
 * Compact, throttled diagnostic for bringing up the macOS `osascript` volume
 * backend and the corner-gated wrist-volume demo: never renders the raw
 * quaternion/orientation stream or writes to any recording, only a handful
 * of low-rate status readouts already carried on `OverlayState` and
 * `WatchStatus`.
 */
export function CornerWristVolumeDiagnosticsSection({
  overlay,
  watchStatus,
  invertDirection,
}: CornerWristVolumeDiagnosticsSectionProps) {
  const lastOrientation = watchStatus?.lastOrientation ?? null;
  const lastOrientationSequence = lastOrientation?.sequence ?? null;
  const receivedAtRef = useRef<number | null>(null);
  const seenSequenceRef = useRef<number | null>(null);
  const [, forceTick] = useReducer((tick: number) => tick + 1, 0);

  useEffect(() => {
    if (lastOrientationSequence !== null && lastOrientationSequence !== seenSequenceRef.current) {
      seenSequenceRef.current = lastOrientationSequence;
      receivedAtRef.current = Date.now();
    }
  }, [lastOrientationSequence]);

  // Re-renders periodically so "live" ages into "stale" without a new
  // orientation sample arriving to trigger it.
  useEffect(() => {
    const id = window.setInterval(forceTick, ORIENTATION_STALE_POLL_MS);
    return () => window.clearInterval(id);
  }, []);

  const orientationStatus: "absent" | "stale" | "live" =
    lastOrientation === null ? "absent"
      : receivedAtRef.current !== null && Date.now() - receivedAtRef.current > ORIENTATION_STALE_THRESHOLD_MS ? "stale"
        : "live";

  return (
    <Card role="region" aria-label="Corner wrist volume diagnostics">
      <CardHeader>
        <SectionHeader
          title="Corner wrist volume diagnostics"
          description="Live macOS bring-up status for the corner-gated demo"
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <section className="metric-grid" aria-label="Corner wrist volume diagnostic metrics">
          <Metric
            label="Corner gate"
            value={overlay.cornerDemoPhase ? CORNER_GATE_LABEL[overlay.cornerDemoPhase] : "Inactive"}
          />
          <Metric
            label="Watch orientation"
            value={orientationStatus === "absent" ? "Absent" : orientationStatus === "stale" ? "Stale" : "Live"}
          />
          <Metric
            label="Relative roll delta"
            value={overlay.lastRelativeRollDegrees != null ? `${number(overlay.lastRelativeRollDegrees, 1)}°` : "—"}
          />
          <Metric label="Direction" value={invertDirection ? "Inverted" : "Normal"} />
          <Metric
            label="Native volume"
            value={overlay.lastNativeVolumeError ? "Error" : `${number(overlay.volume, 0)}%`}
          />
        </section>
        <VectorRow
          label="Last native volume error"
          value={overlay.lastNativeVolumeError ?? "None"}
        />
      </CardContent>
    </Card>
  );
}
