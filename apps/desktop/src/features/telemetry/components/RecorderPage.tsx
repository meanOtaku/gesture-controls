import { useId, useState, useSyncExternalStore } from "react";
import { SegmentedControl } from "../../../components/app/SegmentedControl";
import { guidedRunner } from "../recording/guidedRunner";
import { AnimatedWord } from "../../../components/app/AnimatedNumber";
import { AdvancedSection } from "../../../components/app/AdvancedSection";
import { CameraCapturePanel } from "../../camera/components/CameraCapturePanel";
import { CoverageCard } from "./CoverageCard";
import { EverydayNoiseCard } from "./EverydayNoiseCard";
import { GestureRecordingCard } from "./GestureRecordingCard";
import { JustRecordedCard } from "./JustRecordedCard";
import { LiveGraphs } from "./LiveGraphs";
import { GestureSessionCard } from "./GestureSessionCard";
import { SessionDetailsCard } from "./SessionDetailsCard";
import { SignalHealthStrip } from "./SignalHealthStrip";
import { StreamStatus } from "./StreamStatus";
import { useTelemetryExport } from "../hooks/useTelemetryExport";
import { telemetryStore } from "../store/telemetryStore";

type SessionKind = "session" | "noise" | "free";
const KIND_KEY = "recorderSessionKind";
const KINDS: { value: SessionKind; label: string }[] = [
  { value: "session", label: "Gesture session" },
  { value: "noise", label: "Everyday noise" },
  { value: "free", label: "Free recording" },
];

/** The kind of session chosen last time, remembered between visits (the old "pinch" and "gesture" are the session and
 *  the free recording); a gesture session when the browser will not say. */
function readKind(): SessionKind {
  try {
    const stored = window.localStorage.getItem(KIND_KEY);
    return stored === "noise" ? "noise" : stored === "free" || stored === "gesture" ? "free" : "session";
  } catch {
    return "session";
  }
}

/**
 * Records a session, one kind at a time (chosen at the top, and remembered): a guided session of one or more gestures, everyday noise, or a free recording of any gesture, with the camera beside them so you see what it
 * sees while you record. A recording is saved by itself when it stops; a timed one is ended by `RecordingTimer`, which
 * lives outside this page so leaving it does not cancel the timer.
 */
export function RecorderPage() {
  const desktopAvailable = "__TAURI_INTERNALS__" in window;
  useSyncExternalStore(telemetryStore.subscribe, telemetryStore.getVersion, telemetryStore.getVersion);
  const { saveDatasetRecording } = useTelemetryExport();
  const datasetRecording = telemetryStore.getDatasetRecording();
  const watchConnected = telemetryStore.getWatchStatus()?.connected === true;
  const kindLabel = useId();
  const [kind, setKind] = useState<SessionKind>(readKind);
  const guided = useSyncExternalStore(guidedRunner.subscribe, guidedRunner.snapshot, guidedRunner.snapshot);
  // A session under way always shows its own card, whatever was chosen: its prompts and its Stop are there.
  const shown: SessionKind = guided?.source === "gesture" ? "session" : guided?.source === "noise" ? "noise" : datasetRecording ? (guided ? kind : "free") : kind;
  const choose = (next: SessionKind) => {
    setKind(next);
    try {
      window.localStorage.setItem(KIND_KEY, next);
    } catch {
      // Remembering is a convenience.
    }
  };
  const stop = () => {
    telemetryStore.stopDatasetRecording();
    void saveDatasetRecording();
  };

  return <main className="shell telemetry-shell">
    <header className="hero">
      <div><h1>Recorder</h1><p className="subtitle">Record a session from the watch. It joins Recordings by itself.</p></div>
      <div className={`connection ${datasetRecording ? "online" : "offline"}`}><span className="pulse" /><AnimatedWord>{datasetRecording ? "Recording" : "Not recording"}</AnimatedWord></div>
    </header>
    <StreamStatus />
    <SignalHealthStrip recording={datasetRecording} />
    <div className="recorder-layout">
      {/* First in the page, so it is numbered and read first; beside the sessions on a wide page. */}
      <aside className="recorder-camera" aria-label="Camera">
        <CameraCapturePanel />
      </aside>
      <div className="card-stack recorder-sessions">
        <div className="field">
          <span id={kindLabel} className="label">What to record</span>
          <SegmentedControl labelledBy={kindLabel} value={shown} disabled={datasetRecording} options={KINDS} onValueChange={choose} />
        </div>
        {shown === "session" && <GestureSessionCard recording={datasetRecording} watchConnected={watchConnected} desktopAvailable={desktopAvailable} onStop={stop} />}
        {shown === "noise" && <EverydayNoiseCard recording={datasetRecording} watchConnected={watchConnected} onStop={stop} />}
        {shown === "free" && <GestureRecordingCard desktopAvailable={desktopAvailable} onStop={stop} />}
        <JustRecordedCard recording={datasetRecording} />
        <SessionDetailsCard context={telemetryStore.getSessionContext()} onChange={(context) => telemetryStore.setSessionContext(context)} recording={datasetRecording} />
        <CoverageCard />
      </div>
    </div>
    {/* Folded by default: the graphs redraw many times a second, and draw nothing while folded. */}
    <AdvancedSection storageKey="recorderGraphs" title="Live graphs" summary="What the sensors send right now: head and watch orientation, motion and pulse">
      <LiveGraphs />
    </AdvancedSection>
  </main>;
}
