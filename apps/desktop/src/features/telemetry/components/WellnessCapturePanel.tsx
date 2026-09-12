import { ChevronDownIcon } from "lucide-react";
import { HelpTooltip } from "../../../components/app/HelpTooltip";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../../components/ui/collapsible";
import type { WatchStatus } from "../../../shared/protocol/events";
import type { SeriesPoint } from "../store/telemetryStore";
import { TimeChart } from "./TimeChart";

const MEASUREMENT_TRACKERS = [
  { id: "spo2_on_demand", label: "Blood oxygen" },
  { id: "ecg_on_demand", label: "ECG" },
  { id: "bia_on_demand", label: "Body composition" },
  { id: "sweat_loss_on_demand", label: "Sweat loss" },
] as const;

type WellnessCapturePanelProps = {
  desktopAvailable: boolean;
  watchStatus: WatchStatus | null;
  heartRateStreaming: boolean;
  skinTemperatureStreaming: boolean;
  edaStreaming: boolean;
  heartRatePoints: SeriesPoint[];
  ibiPoints: SeriesPoint[];
  temperaturePoints: SeriesPoint[];
  edaPoints: SeriesPoint[];
  spo2Points: SeriesPoint[];
  ecgPoints: SeriesPoint[];
  pendingMeasurement: string | null;
  measurementError: string | null;
  onRequestMeasurement: (tracker: string, measuring: boolean) => void;
};

/** Collapsible wellness/medical signal charts and on-demand measurement controls, gated by sensor availability. */
export function WellnessCapturePanel({
  desktopAvailable,
  watchStatus,
  heartRateStreaming,
  skinTemperatureStreaming,
  edaStreaming,
  heartRatePoints,
  ibiPoints,
  temperaturePoints,
  edaPoints,
  spo2Points,
  ecgPoints,
  pendingMeasurement,
  measurementError,
  onRequestMeasurement,
}: WellnessCapturePanelProps) {
  return (
    <Collapsible className="wellness-panel">
      <div className="flex w-full items-center justify-between gap-2">
        <CollapsibleTrigger
          render={<Button type="button" variant="ghost" className="justify-between px-0 hover:bg-transparent" />}
        >
          <span>Wellness signals &amp; on-demand captures</span>
          <ChevronDownIcon aria-hidden="true" />
        </CollapsibleTrigger>
        <HelpTooltip label="About wellness and on-demand measurements">
          Additional Watch sensors depend on device support and permissions. On-demand measurements
          (blood oxygen, ECG, body composition, sweat loss) run one at a time, only while the app is
          in the foreground, and are not diagnostic measurements.
        </HelpTooltip>
      </div>
      <CollapsibleContent className="hint">
        <p className="hint">Additional Watch sensors depend on device support and permissions. These readings are not diagnostic measurements.</p>
        <div className="signal-grid">
          {(heartRateStreaming || heartRatePoints.length > 0) && (
            <TimeChart title="Heart rate" points={heartRatePoints} labels={["BPM"]} colors={["#ff7da5"]} />
          )}
          {(heartRateStreaming || ibiPoints.length > 0) && (
            <TimeChart title="Heart rate IBI" points={ibiPoints} labels={["IBI ms"]} colors={["#4ff0b7"]} />
          )}
          {(skinTemperatureStreaming || temperaturePoints.length > 0) && (
            <TimeChart title="Skin temperature" points={temperaturePoints} labels={["Object °C", "Ambient °C"]} colors={["#ffb45d", "#65e6ff"]} />
          )}
          {(edaStreaming || edaPoints.length > 0) && (
            <TimeChart title="Electrodermal activity" points={edaPoints} labels={["µS"]} colors={["#b88cff"]} />
          )}
          <TimeChart title="Blood oxygen (on-demand)" points={spo2Points} labels={["SpO₂ %"]} emptyHint="Start a supported blood oxygen capture below." colors={["#4ff0b7"]} />
          {spo2Points.length > 0 && (
            <TimeChart title="Blood oxygen heart rate" points={spo2Points.map((point) => ({ ...point, values: [point.values[1]] }))} labels={["BPM"]} colors={["#ff7da5"]} />
          )}
          <TimeChart title="ECG (on-demand)" points={ecgPoints} labels={["mV"]} emptyHint="Start a supported ECG capture below." colors={["#ffb45d"]} />
        </div>
        <Card className="medical-controls">
          <CardHeader>
            <CardTitle>On-demand wellness captures</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-2">
            {MEASUREMENT_TRACKERS.map(({ id: tracker, label }) => {
              const state = watchStatus?.medicalStatus?.[tracker] ?? "unavailable";
              const measuring = state === "measuring";
              const anotherMeasurementActive = Object.entries(watchStatus?.medicalStatus ?? {})
                .some(([id, trackerState]) => id !== tracker && trackerState === "measuring");
              const disabled = !desktopAvailable || pendingMeasurement !== null || !watchStatus?.connected
                || anotherMeasurementActive || (state !== "idle" && !measuring);
              return (
                <Button
                  key={tracker}
                  type="button"
                  variant={measuring ? "destructive" : "outline"}
                  disabled={disabled}
                  onClick={() => onRequestMeasurement(tracker, measuring)}
                >
                  {pendingMeasurement === tracker ? "Requesting…" : measuring ? `Stop ${label}` : `${label} · ${state === "idle" ? "Start" : state}`}
                </Button>
              );
            })}
          </CardContent>
        </Card>
        {measurementError && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{measurementError}</AlertDescription>
          </Alert>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
