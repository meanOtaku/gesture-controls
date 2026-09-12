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
  ppgPoints: SeriesPoint[];
};

/** Live signal charts plus the motion/optical filter that scopes which charts are shown. */
export function SignalMonitor({
  signalView,
  onSignalViewChange,
  orientationEnabled,
  headPoints,
  watchOrientationPoints,
  ppgPoints,
}: SignalMonitorProps) {
  return (
    <section aria-label="Signal monitor">
      <div className="signal-heading">
        <div><p className="eyebrow">Signal monitor</p><h2>Incoming signals</h2></div>
        <div className="signal-filters" role="group" aria-label="Signal filters">
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
          <TimeChart title="Headphone orientation" points={headPoints} labels={["Yaw", "Pitch", "Roll"]} unit="degrees" colors={["#65e6ff", "#b88cff", "#ffb45d"]} />
        )}
        {signalView !== "optical" && orientationEnabled && (
          <TimeChart title="Watch orientation" points={watchOrientationPoints} labels={["Yaw", "Pitch", "Roll"]} unit="degrees" colors={["#65e6ff", "#b88cff", "#ffb45d"]} />
        )}
        {signalView !== "motion" && (
          <TimeChart title="Raw PPG" points={ppgPoints} labels={["Green", "Red", "IR"]} unit="raw counts" emptyHint="Enable PPG on a supported Watch to see optical signals." colors={["#4ff0b7", "#ff7da5", "#b88cff"]} />
        )}
      </div>
    </section>
  );
}
