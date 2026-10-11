import { invoke } from "@tauri-apps/api/core";
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Label } from "../../../components/ui/label";
import { getCameraController } from "../../camera/cameraService";
import { AgreementTracker } from "../../gestureLibrary/agreement";
import { AgreementPanel } from "../../gestureLibrary/AgreementPanel";
import { cameraAssist } from "../../gestureLibrary/cameraAssist";
import { definitionsForLabel, type GestureDefinition } from "../../gestureLibrary/definition";
import { listGestureDefinitions } from "../../gestureLibrary/gestureLibraryApi";
import { useCameraMarking } from "../../gestureLibrary/useCameraMarking";
import { useLiveGestures } from "../../gestureLibrary/useLiveGestures";
import { useTelemetryExport } from "../../telemetry/hooks/useTelemetryExport";
import { telemetryStore } from "../../telemetry/store/telemetryStore";
import type { LabelRuntimeStatus } from "../labelModels";
import type { DatasetLabel, DatasetSummary } from "../types";
import type { ModelTrainingInfo } from "./FineTuneModel";

/** The labels a correction session can fill the rest of the recording with: ones the model was trained to treat as "something else". */
export function backgroundChoices(info: Pick<ModelTrainingInfo, "negatives">, labels: DatasetLabel[]): DatasetLabel[] {
  return labels.filter((label) => label.archivedAt === null && label.role === "negativeBackground" && info.negatives.includes(label.id));
}

/**
 * Records corrections for a model: it runs the Model against camera check live, and while you perform (and while you do
 * nothing, to catch false alarms) the camera writes what really happened into a recording, as the Recorder does with camera
 * marking. When you stop, the recording is added to the training data (the part the camera did not see is the background
 * label) and offered to the fine-tune as an extra recording, where what the model got wrong in it counts for more.
 */
export function CorrectionSession({
  info, labels, status, onSaved,
}: {
  info: ModelTrainingInfo;
  labels: DatasetLabel[];
  status: LabelRuntimeStatus | null;
  /** The training-data recording the session became. */
  onSaved: (dataset: DatasetSummary) => void;
}) {
  const uid = useId();
  const desktopAvailable = "__TAURI_INTERNALS__" in window;
  const camera = getCameraController();
  const cam = useSyncExternalStore(camera.subscribe, camera.getSnapshot, camera.getSnapshot);
  const camera2 = getCameraController("secondary");
  const cam2 = useSyncExternalStore(camera2.subscribe, camera2.getSnapshot, camera2.getSnapshot);
  useSyncExternalStore(telemetryStore.subscribe, telemetryStore.getVersion, telemetryStore.getVersion);
  const recordingState = telemetryStore.getDatasetRecordingState();
  const busyElsewhere = telemetryStore.getDatasetRecording();
  const { saveDatasetRecording } = useTelemetryExport();

  const [definitions, setDefinitions] = useState<GestureDefinition[]>([]);
  const mine = useMemo(() => definitionsForLabel(definitions, info.label), [definitions, info.label]);
  const tracker = useRef(new AgreementTracker()).current;
  const states = useLiveGestures(mine, cam, tracker, cam2);
  const heldNow = mine.map((definition) => states.get(definition.id)).filter((state) => state?.held);
  const seen = heldNow.length > 0;
  const sinceMs = seen ? Math.min(...heldNow.map((state) => state?.sinceMs ?? Infinity)) : null;

  const [started, setStarted] = useState(false); // this component started the recording now under way
  const [phase, setPhase] = useState<"idle" | "saving">("idle");
  const background = backgroundChoices(info, labels);
  const [restLabel, setRestLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!desktopAvailable) return;
    void listGestureDefinitions().then(setDefinitions).catch(() => setDefinitions([]));
  }, [desktopAvailable]);
  useEffect(() => {
    setRestLabel((current) => (background.some((l) => l.id === current) ? current : background[0]?.id ?? ""));
    // `background` is rebuilt every render; its content is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [background.map((l) => l.id).join(",")]);

  const recording = started && busyElsewhere;
  useCameraMarking(recording ? info.label : null, recordingState, seen, sinceMs);
  // If the recording was ended elsewhere (or discarded), this session is over.
  useEffect(() => {
    if (started && !busyElsewhere && phase === "idle") setStarted(false);
  }, [started, busyElsewhere, phase]);

  const loaded = (status?.loadedLabels ?? []).includes(info.label);
  const mode = status?.mode ?? "off";
  const camOn = cam.status === "on" || cam2.status === "on";
  const blocker = !desktopAvailable
    ? "Needs the desktop app."
    : mine.length === 0
      ? `No gesture in the Gesture library uses “${info.label.replaceAll("_", " ")}”: the camera has nothing to compare the model with. Make one in the Gesture library.`
      : background.length === 0
        ? `This model was not trained with a background label (one of ${info.negatives.join(", ") || "none"}) that can fill the parts of a recording where the gesture is not happening.`
        : !camOn
          ? "Turn the camera on (Recorder or Gestures tab) so it can see your hand."
          : busyElsewhere && !started
            ? "A recording is already in progress in the Recorder. Finish it first."
            : null;

  const start = () => {
    setError(null);
    setMessage(null);
    telemetryStore.selectDatasetLabel(info.label);
    telemetryStore.setDatasetCaptureMode("timeline");
    if (!telemetryStore.startDatasetRecording()) {
      setError("The recording could not start.");
      return;
    }
    cameraAssist.arm(info.label);
    tracker.reset();
    setStarted(true);
  };

  const stop = async () => {
    setPhase("saving");
    setError(null);
    try {
      telemetryStore.stopDatasetRecording();
      const result = await saveDatasetRecording();
      if (!result || result.status !== "saved") {
        setError(result?.status === "error" ? result.message : "Nothing was recorded: is the watch streaming?");
        return;
      }
      const made = await invoke<DatasetSummary>("add_recording_to_training_data", { recordingId: result.recordingId, filter: "notExcluded", restLabel });
      setMessage(`Added as ${made.originalFilename} (${made.rowCount.toLocaleString()} rows) and ticked below as an extra recording.`);
      onSaved(made);
    } catch (err) {
      setError(String(err));
    } finally {
      setPhase("idle");
      setStarted(false);
    }
  };

  const discard = () => {
    cameraAssist.disarm();
    telemetryStore.discardDatasetRecording();
    setStarted(false);
  };

  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border border-input p-3" aria-label="Record corrections">
      <legend className="label">Record corrections</legend>
      <p className="field-hint">
        Where the model misfires, show it. Record a short session with the watch on the hand the camera sees: perform the gesture, and also stay still or move about without it, so the false alarms and the misses both happen. The camera marks what really happened. When you stop, the recording becomes an extra recording for this fine-tune.
      </p>
      {blocker && <p className="hint" role="status">{blocker}</p>}
      {!blocker && !loaded && <p className="hint" role="status">This model is not the active one, so there is no live check of it below; the recording is still made.{mode === "off" ? " The model runtime is Off." : ""}</p>}
      {!blocker && (
        <div className="field">
          <div className="field-head"><Label htmlFor={`${uid}-rest`}>Label for the rest of the recording</Label></div>
          <select id={`${uid}-rest`} className="recipe-select" value={restLabel} disabled={recording || phase === "saving"} onChange={(event) => setRestLabel(event.target.value)}>
            {background.map((label) => <option key={label.id} value={label.id}>{label.displayName}</option>)}
          </select>
          <p className="field-hint">Whatever the camera did not see as the gesture is labelled this, so the model also learns from the moments it fired when it should not have.</p>
        </div>
      )}
      {!blocker && (
        <div className="flex flex-wrap items-center gap-2">
          {!recording && <Button type="button" disabled={phase === "saving" || restLabel === ""} onClick={start}>Start recording corrections</Button>}
          {recording && (
            <>
              <Badge>Recording</Badge>
              <Badge variant={seen ? "default" : "secondary"}>{seen ? "Camera sees the gesture" : "Camera does not see it"}</Badge>
              <Button type="button" disabled={phase === "saving"} onClick={() => void stop()}>{phase === "saving" ? "Saving…" : "Stop and use it"}</Button>
              <Button type="button" variant="outline" disabled={phase === "saving"} onClick={discard}>Discard</Button>
            </>
          )}
        </div>
      )}
      {recording && <p className="field-hint">Stay on this page while recording: leaving it stops the camera from marking.</p>}
      {message && <Alert role="status"><AlertDescription>{message}</AlertDescription></Alert>}
      {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
      <AgreementPanel tracker={tracker} definitions={mine} status={status} cameraOn={camOn} />
    </fieldset>
  );
}
