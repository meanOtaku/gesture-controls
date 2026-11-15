import { Alert, AlertDescription } from "../../../components/ui/alert";
import { AdvancedSection } from "../../../components/app/AdvancedSection";
import { AnimatedWord } from "../../../components/app/AnimatedNumber";
import { Card, CardContent } from "../../../components/ui/card";
import type {
  AutomationState,
  CalibrationState,
  CalibrationTarget,
  HeadTrackerDiagnostic,
  HeadTrackerStatus,
  WatchStatus,
} from "../../../shared/protocol/events";
import { CalibrationPanel } from "./CalibrationPanel";
import { RecipesCard } from "./RecipesCard";
import { HeadphoneTelemetryPanel } from "./HeadphoneTelemetryPanel";
import { ModelWorkflowCard } from "./ModelWorkflowCard";
import { WatchPowerCard } from "./WatchPowerCard";
import { OverviewSection } from "./OverviewSection";
import { WatchSensorsOffNote } from "./WatchSensorsOffNote";
import { LinkHealthCard } from "./LinkHealthCard";
import { WatchTelemetryPanel } from "./WatchTelemetryPanel";
import { WatchWellnessPanel } from "./WatchWellnessPanel";
import { WellnessCaptures } from "../../telemetry/components/LiveGraphs";

interface DashboardProps {
  view?: "main" | "headphone" | "watch";
  status: HeadTrackerStatus | null;
  /** Native-provider-only readiness state (scanning, permission denied, etc). `null` when there's nothing to report. */
  headDiagnostic?: HeadTrackerDiagnostic | null;
  /** Which head-pose provider this session selected; see `get_head_tracker_provider`. `null` before the first response arrives. */
  headTrackerProvider?: "native" | "external" | null;
  calibration?: CalibrationState | null;
  calibrationError?: string | null;
  watchStatus?: WatchStatus | null;
  /** Reports whether the operation for the given key (e.g. `capture:center`, `sensor:orientation`) is in flight. */
  isPending?: (key: string) => boolean;
  onNavigate?: (view: "headphone" | "watch") => void;
  onCaptureTarget?: (target: CalibrationTarget) => void;
  onUpdateCalibration?: (activationThresholdDegrees: number, dwellMs: number) => void;
  onAddLocation?: (name: string) => void;
  onRemoveLocation?: (target: CalibrationTarget) => void;
  automation?: AutomationState | null;
  onSetRecipeEnabled?: (id: string, enabled: boolean) => void;
}

const DEFAULT_CALIBRATION: CalibrationState = {
  targets: [
    { id: "center", name: "Screen center", calibrated: false, builtin: true },
    { id: "topRight", name: "Top right", calibrated: false, builtin: false },
  ],
  requiresRecalibration: true,
  activationThresholdDegrees: 12,
  dwellMs: 400,
  activeTarget: null,
};

export function Dashboard({
  view = "main",
  status,
  headDiagnostic = null,
  headTrackerProvider = null,
  calibration,
  calibrationError,
  watchStatus,
  isPending = () => false,
  onNavigate,
  onCaptureTarget = () => undefined,
  onUpdateCalibration = () => undefined,
  onAddLocation = () => undefined,
  onRemoveLocation = () => undefined,
  automation = null,
  onSetRecipeEnabled = () => undefined,
}: DashboardProps) {
  const connected = status?.connected === true;
  const calibrationState = calibration ?? DEFAULT_CALIBRATION;
  const calibrated = !calibrationState.requiresRecalibration;
  const watchConnected = watchStatus?.connected === true;
  const gestureReady = connected && calibrated && watchConnected;

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <h1>{view === "main" ? "Control center" : view === "headphone" ? "Headphones" : "Galaxy Watch"}</h1>
          <p className="subtitle">{view === "main" ? "Your devices and gestures at a glance." : view === "headphone" ? "Head tracking and calibration." : "Connection, battery and sensors."}</p>
        </div>
        <div className={`connection ${view === "watch" ? (watchConnected ? "online" : "offline") : (connected ? "online" : "offline")}`}>
          <span className="pulse" />
          <AnimatedWord>{view === "watch"
            ? (watchConnected ? "Watch connected" : "Waiting for watch")
            : (connected ? "Bridge connected" : "Waiting for Sony bridge")}</AnimatedWord>
        </div>
      </header>

      {calibrationError && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{calibrationError}</AlertDescription>
        </Alert>
      )}

      {view === "main" && (
        <OverviewSection
          connected={connected}
          calibrated={calibrated}
          watchConnected={watchConnected}
          gestureReady={gestureReady}
          deviceName={status?.device ?? null}
          onNavigate={onNavigate}
        />
      )}

      {view === "main" && <ModelWorkflowCard />}

      {view === "headphone" && !connected && headDiagnostic && (
        <aside className="connection-help" aria-label="Headphone connection help">
          <Card><CardContent className="flex flex-col gap-2">
            <h2>{headDiagnostic.title}</h2>
            <p>{headDiagnostic.detail}</p>
            {headDiagnostic.action && <p className="hint">{headDiagnostic.action}</p>}
          </CardContent></Card>
        </aside>
      )}
      {view === "headphone" && !connected && !headDiagnostic && (
        <aside className="connection-help" aria-label="Headphone connection help">
          <Card><CardContent className="flex flex-col gap-2">
            <h2>Waiting for head-tracking data</h2>
            <p>Pairing alone does not confirm that the headset’s tracking sensor is connected.</p>
            <ol>
              <li>Connect the headset in your computer’s Bluetooth settings.</li>
              {headTrackerProvider === "external"
                ? <li>Allow the Sony tracker executable through your OS device-access prompt (macOS: Privacy &amp; Security → Input Monitoring).</li>
                : <li>Allow Spatial Gesture Control through your OS device-access prompt (macOS: Privacy &amp; Security → Input Monitoring; Windows: Bluetooth &amp; devices).</li>}
              <li>Stop and restart the project after changing permissions.</li>
            </ol>
          </CardContent></Card>
        </aside>
      )}
      {view === "watch" && !watchConnected && (
        <aside className="connection-help">
          <Card><CardContent className="flex flex-col gap-2">
            <h2>Connect your Watch</h2>
            <p>Open the Watch app and enable streaming. Over Bluetooth (the default) keep the watch near this computer; over Wi-Fi keep both on the same network, and note that guest networks may block discovery. Choose which under Settings → Watch.</p>
          </CardContent></Card>
        </aside>
      )}

      {view === "main" && automation && (
        <RecipesCard
          automation={automation}
          calibration={calibration ?? null}
          isPending={isPending}
          onSetRecipeEnabled={onSetRecipeEnabled}
        />
      )}

      {view === "headphone" && <HeadphoneTelemetryPanel status={status} />}
      {view === "headphone" && (
        <CalibrationPanel
          connected={connected}
          calibration={calibrationState}
          isPending={isPending}
          onCaptureTarget={onCaptureTarget}
          onUpdateCalibration={onUpdateCalibration}
          onAddLocation={onAddLocation}
          onRemoveLocation={onRemoveLocation}
        />
      )}

      {view === "watch" && <WatchSensorsOffNote watchStatus={watchStatus ?? null} />}
      {view === "watch" && <WatchTelemetryPanel watchStatus={watchStatus ?? null} />}
      {view === "watch" && (
        <AdvancedSection storageKey="watch" title="Diagnostics" summary="Link health, power measurement, the pulse and health sensors, and on-demand captures">
          <LinkHealthCard />
          <WatchPowerCard />
          <WatchWellnessPanel watchStatus={watchStatus ?? null} />
          <WellnessCaptures />
        </AdvancedSection>
      )}

    </main>
  );
}
