import { Button } from "../../../components/ui/button";
import type { SeriesPoint } from "../store/telemetryStore";
import { TimeChart } from "./TimeChart";

export type SignalView = "all" | "motion" | "optical";

const VIEWS: Array<{ id: SignalView; label: string }> = [
  { id: "all", label: "All signals" },
  { id: "motion", label: "Motion" },
  { id: "optical", label: "Optical" },
];

type SignalMonitorProps = {
  signalView: SignalView;
  onSignalViewChange: (view: SignalView) => void;
  orientationEnabled: boolean;
  headPoints: SeriesPoint[];
  watchOrientationPoints: SeriesPoint[];
  watchAccelerationPoints: SeriesPoint[];
  /** Whether the watch's acceleration sensor is on (`desktop.set_sensor`); the chart is hidden when it is off. */
  accelerationEnabled: boolean;
  /** Why the acceleration chart is empty, when something other than "no samples yet" explains it. */
  watchAccelerationHint?: string;
  ppgPoints: SeriesPoint[];
  /**
   * Distinguishes why the Watch orientation chart has no samples yet
   * (disconnected, transport never delivered one, or the backend has one but
   * the UI store isn't reflecting it) instead of always showing the generic
   * "connect your device" hint, which is misleading once the Watch is
   * already connected (GC-035 regression triage).
   */
  watchOrientationHint?: string;
  /** Why the PPG chart is empty when something other than "PPG is off" explains it, e.g. the watch is off the wrist. */
  ppgHint?: string;
};

/** Live signal charts plus the motion/optical filter that scopes which charts are shown. */
export function SignalMonitor({
  signalView,
  onSignalViewChange,
  orientationEnabled,
  headPoints,
  watchOrientationPoints,
  watchAccelerationPoints,
  accelerationEnabled,
  watchAccelerationHint,
  ppgPoints,
  watchOrientationHint,
  ppgHint,
}: SignalMonitorProps) {
  return (
    <section aria-label="Signal monitor">
      <div className="signal-heading">
        <div><p className="eyebrow">Signal monitor</p><h2>Incoming signals</h2></div>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Signal filters">
          {VIEWS.map(({ id, label }) => (
            <Button
              key={id}
              type="button"
              variant={signalView === id ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={signalView === id}
              onClick={() => onSignalViewChange(id)}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>
      <div className="signal-grid">
        {signalView !== "optical" && (
          <TimeChart title="Headphone orientation" points={headPoints} labels={["Yaw", "Pitch", "Roll"]} unit="degrees" colors={["#f2f200", "#00f2f2", "#ff9a3d"]} />
        )}
        {signalView !== "optical" && orientationEnabled && (
          <TimeChart
            title="Watch orientation"
            points={watchOrientationPoints}
            labels={["Yaw", "Pitch", "Roll"]}
            unit="degrees"
            colors={["#f2f200", "#00f2f2", "#ff9a3d"]}
            emptyHint={watchOrientationHint}
          />
        )}
        {signalView !== "optical" && accelerationEnabled && (
          <TimeChart
            title="Watch acceleration"
            points={watchAccelerationPoints}
            labels={["X", "Y", "Z"]}
            unit="m/s² · gravity removed"
            colors={["#f2f200", "#00f2f2", "#ff9a3d"]}
            emptyHint={watchAccelerationHint}
          />
        )}
        {signalView !== "motion" && (
          <TimeChart title="Raw PPG" points={ppgPoints} labels={["Green", "Red", "IR"]} unit="raw counts" emptyHint={ppgHint ?? "Enable PPG on a supported Watch to see optical signals."} colors={["#00f279", "#ff9d9d", "#f2f200"]} />
        )}
      </div>
    </section>
  );
}
