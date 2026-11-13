import { useSyncExternalStore } from "react";
import { AnimatedWord } from "../../../components/app/AnimatedNumber";
import { CameraCapturePanel } from "../../camera/components/CameraCapturePanel";
import { CoverageCard } from "./CoverageCard";
import { EverydayNoiseCard } from "./EverydayNoiseCard";
import { GestureRecordingCard } from "./GestureRecordingCard";
import { JustRecordedCard } from "./JustRecordedCard";
import { PinchSessionCard } from "./PinchSessionCard";
import { SessionDetailsCard } from "./SessionDetailsCard";
import { SignalHealthStrip } from "./SignalHealthStrip";
import { StreamStatus } from "./StreamStatus";
import { useTelemetryExport } from "../hooks/useTelemetryExport";
import { telemetryStore } from "../store/telemetryStore";

/**
 * Records a session: pinch in / out, everyday noise, or any other gesture, with the camera beside them so you see what it
 * sees while you record. A recording is saved by itself when it stops; a timed one is ended by `RecordingTimer`, which
 * lives outside this page so leaving it does not cancel the timer.
 */
export function RecorderPage() {
  const desktopAvailable = "__TAURI_INTERNALS__" in window;
  useSyncExternalStore(telemetryStore.subscribe, telemetryStore.getVersion, telemetryStore.getVersion);
  const { saveDatasetRecording } = useTelemetryExport();
  const datasetRecording = telemetryStore.getDatasetRecording();
  const watchConnected = telemetryStore.getWatchStatus()?.connected === true;
  const stop = () => {
    telemetryStore.stopDatasetRecording();
    void saveDatasetRecording();
  };

  return <main className="shell telemetry-shell">
    <header className="hero">
      <div><p className="eyebrow">Spatial Gesture Control</p><h1>Recorder</h1><p className="subtitle">Record a labelled session from the watch. It is saved automatically; add it to the training data from Model Lab.</p></div>
      <div className={`connection ${datasetRecording ? "online" : "offline"}`}><span className="pulse" /><AnimatedWord>{datasetRecording ? "Recording" : "Not recording"}</AnimatedWord></div>
    </header>
    <StreamStatus />
    <SignalHealthStrip recording={datasetRecording} />
    <div className="recorder-layout">
      <div className="card-stack recorder-sessions">
        <PinchSessionCard recording={datasetRecording} watchConnected={watchConnected} desktopAvailable={desktopAvailable} onStop={stop} />
        <EverydayNoiseCard recording={datasetRecording} watchConnected={watchConnected} onStop={stop} />
        <GestureRecordingCard desktopAvailable={desktopAvailable} onStop={stop} />
        <JustRecordedCard recording={datasetRecording} />
        <SessionDetailsCard context={telemetryStore.getSessionContext()} onChange={(context) => telemetryStore.setSessionContext(context)} recording={datasetRecording} />
        <CoverageCard />
      </div>
      <aside className="recorder-camera" aria-label="Camera">
        <CameraCapturePanel />
      </aside>
    </div>
  </main>;
}
