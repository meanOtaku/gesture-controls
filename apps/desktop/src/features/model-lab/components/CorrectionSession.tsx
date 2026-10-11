import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { BarChart } from "../../../components/charts/BarChart";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Label } from "../../../components/ui/label";
import { getCameraController } from "../../camera/cameraService";
import { AgreementTracker, LAG_MS, type LabelAgreement } from "../../gestureLibrary/agreement";
import { AgreementPanel } from "../../gestureLibrary/AgreementPanel";
import { cameraAssist } from "../../gestureLibrary/cameraAssist";
import { definitionsForLabel, type GestureDefinition } from "../../gestureLibrary/definition";
import { listGestureDefinitions } from "../../gestureLibrary/gestureLibraryApi";
import { useCameraMarking } from "../../gestureLibrary/useCameraMarking";
import { useLiveGestures } from "../../gestureLibrary/useLiveGestures";
import { useTelemetryExport } from "../../telemetry/hooks/useTelemetryExport";
import { telemetryStore } from "../../telemetry/store/telemetryStore";
import type { LabelModel, LabelRuntimeStatus } from "../labelModels";
import type { DatasetLabel, DatasetSummary } from "../types";
import type { ModelTrainingInfo } from "./FineTuneModel";

/** How a model did against the camera over a round (see `correction_rounds.rs`). */
export interface Tally { modelId: string; holds: number; found: number; missed: number; falseAlarms: number }
/** A round of correcting, as the desktop keeps it. */
export interface CorrectionRound {
  id: string;
  label: string;
  savedAt: string;
  recordingId: string | null;
  active: Tally;
  candidate: Tally | null;
}

/** The labels the rest of a correction recording can be given: any label but the one being taught. The ones the model already treats as "something else" come first, background labels next. */
export function restChoices(info: Pick<ModelTrainingInfo, "label" | "negatives">, labels: DatasetLabel[]): DatasetLabel[] {
  const rank = (label: DatasetLabel) =>
    info.negatives.includes(label.id) && label.role === "negativeBackground" ? 0 : label.role === "negativeBackground" ? 1 : info.negatives.includes(label.id) ? 2 : 3;
  return labels
    .filter((label) => label.archivedAt === null && label.id !== info.label)
    .sort((a, b) => rank(a) - rank(b) || a.displayName.localeCompare(b.displayName));
}

const tallyOf = (modelId: string, summary: LabelAgreement): Tally => ({ modelId, holds: summary.holds, found: summary.found, missed: summary.missed, falseAlarms: summary.falseAlarms });

/**
 * Correcting a model with the camera, round by round. Each round: record a short session while the camera marks what
 * really happened (the Model against camera tally shows live how the active model, and a candidate run beside it, are
 * doing); stop, and the recording is added to the training data and offered below as an extra recording; fine-tune on it
 * (the confirm step is the Start button below); then run the new draft beside the active model and compare before
 * promoting it. The rounds are kept, so improvement can be seen.
 */
export function CorrectionSession({
  info, modelId, models = [], labels, status, onSaved,
}: {
  info: ModelTrainingInfo;
  modelId: string;
  /** Every model, to pick a candidate to run beside the active one. */
  models?: LabelModel[];
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
  const choices = restChoices(info, labels);
  const [restLabel, setRestLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [rounds, setRounds] = useState<CorrectionRound[]>([]);
  const [candidate, setCandidate] = useState<string | null>(null);

  const activeModel = models.find((model) => model.label === info.label && model.active) ?? null;
  const candidates = models.filter((model) => model.label === info.label && !model.active && model.deployable && model.state !== "archived");

  const loadRounds = useCallback(async () => {
    try {
      const list = await invoke<CorrectionRound[]>("list_correction_rounds", { label: info.label });
      setRounds(Array.isArray(list) ? list : []);
    } catch {
      setRounds([]);
    }
  }, [info.label]);

  useEffect(() => {
    if (!desktopAvailable) return;
    void listGestureDefinitions().then(setDefinitions).catch(() => setDefinitions([]));
    void loadRounds();
    void Promise.resolve(invoke<[string, string] | null>("get_shadow_model")).then((found) => setCandidate(found && found[1] === info.label ? found[0] : null)).catch(() => undefined);
    // A model run beside the active one is only for as long as this panel is open.
    return () => { void Promise.resolve(invoke("stop_shadow_model")).catch(() => undefined); };
  }, [desktopAvailable, loadRounds, info.label]);
  useEffect(() => {
    setRestLabel((current) => (choices.some((l) => l.id === current) ? current : choices[0]?.id ?? ""));
    // `choices` is rebuilt every render; its content is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choices.map((l) => l.id).join(",")]);

  const recording = started && busyElsewhere;
  useCameraMarking(recording ? info.label : null, recordingState, seen, sinceMs);
  // If the recording was ended elsewhere (or discarded), this session is over.
  useEffect(() => {
    if (started && !busyElsewhere && phase === "idle") setStarted(false);
  }, [started, busyElsewhere, phase]);

  const mode = status?.mode ?? "off";
  const camOn = cam.status === "on" || cam2.status === "on";
  const chosenRest = choices.find((l) => l.id === restLabel) ?? null;
  const restIsNew = chosenRest !== null && !info.negatives.includes(chosenRest.id) && !info.excludes.includes(chosenRest.id);
  const checklist: { ok: boolean; text: string; action?: React.ReactNode }[] = [
    { ok: camOn, text: "Camera on", action: !camOn ? <Button type="button" variant="outline" size="sm" onClick={() => void camera.enable()}>Turn camera on</Button> : undefined },
    { ok: mine.length > 0, text: mine.length > 0 ? `A gesture in the Gesture library for “${info.label.replaceAll("_", " ")}”` : `A gesture in the Gesture library for “${info.label.replaceAll("_", " ")}”: none yet, make one in the Gesture library` },
    { ok: mode !== "off" && activeModel !== null, text: activeModel === null ? "An active model for this label, to check live (the recording works without one)" : mode === "off" ? "Model runtime set to Monitor in Model Lab (it is Off)" : `Active model ${activeModel.id} running` },
    { ok: choices.length > 0, text: choices.length > 0 ? "A label for the rest of the recording" : "A label for the rest of the recording: make one under Labels" },
  ];
  const blocker = !desktopAvailable ? "Needs the desktop app." : mine.length === 0 || !camOn || choices.length === 0 ? "Finish the checks above to record." : busyElsewhere && !started ? "A recording is already in progress in the Recorder. Finish it first." : null;

  const chooseCandidate = async (id: string) => {
    setError(null);
    try {
      if (id === "") await invoke("stop_shadow_model");
      else await invoke("start_shadow_model", { id });
      setCandidate(id === "" ? null : id);
      tracker.reset();
    } catch (err) {
      setError(String(err));
    }
  };

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
      const judged = performance.now() + LAG_MS; // judge every hold, including the last
      const active = activeModel ? tallyOf(activeModel.id, tracker.summarize(info.label, judged)) : null;
      const beside = candidate ? tallyOf(candidate, tracker.summarize(info.label, judged, "candidate")) : null;
      telemetryStore.stopDatasetRecording();
      const result = await saveDatasetRecording();
      if (!result || result.status !== "saved") {
        setError(result?.status === "error" ? result.message : "Nothing was recorded: is the watch streaming?");
        return;
      }
      const made = await invoke<DatasetSummary>("add_recording_to_training_data", { recordingId: result.recordingId, filter: "notExcluded", restLabel });
      if (active) {
        await Promise.resolve(invoke("save_correction_round", { round: { label: info.label, recordingId: made.id, active, candidate: beside } })).catch(() => undefined);
        void loadRounds();
      }
      setMessage(`Added as ${made.originalFilename} (${made.rowCount.toLocaleString()} rows) and ticked below as an extra recording. Review the plan, then start the fine-tune.`);
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
      <legend className="label">Correct this model with the camera</legend>
      <p className="field-hint">
        Where the model misfires, show it. Each round: record a short session with the watch on the hand the camera sees (perform the gesture, and also stay still or move about without it, so the misses and the false alarms both happen); the camera marks what really happened. Stop, and the recording becomes an extra recording for the fine-tune below. Then run the new model beside the active one and compare before you switch to it.
      </p>

      <ul className="flex flex-col gap-1" aria-label="What a round needs">
        {checklist.map((item) => (
          <li key={item.text} className="flex flex-wrap items-center gap-2 text-sm">
            <span aria-hidden="true">{item.ok ? "✓" : "○"}</span>
            <span className={item.ok ? "" : "text-muted-foreground"}>{item.text}</span>
            {item.action}
          </li>
        ))}
      </ul>

      <div className="field">
        <div className="field-head"><Label htmlFor={`${uid}-rest`}>Label for the rest of the recording</Label></div>
        <select id={`${uid}-rest`} className="recipe-select" value={restLabel} disabled={recording || phase === "saving" || choices.length === 0} onChange={(event) => setRestLabel(event.target.value)}>
          {choices.map((label) => <option key={label.id} value={label.id}>{label.displayName}{info.negatives.includes(label.id) ? " (already something else for this model)" : ""}</option>)}
        </select>
        <p className="field-hint">
          Whatever the camera did not see as the gesture is given this label, so the model also learns from the moments it fired when it should not have.
          {restIsNew ? ` This model was not trained with a role for “${chosenRest?.displayName}”: you will be asked what it means (normally “something else”) when you start the fine-tune.` : ""}
        </p>
      </div>

      <div className="field">
        <div className="field-head"><Label htmlFor={`${uid}-candidate`}>Run beside the active model</Label></div>
        <select id={`${uid}-candidate`} className="recipe-select" value={candidate ?? ""} disabled={!desktopAvailable || candidates.length === 0} onChange={(event) => void chooseCandidate(event.target.value)}>
          <option value="">None</option>
          {candidates.map((model) => <option key={model.id} value={model.id}>{model.id} ({model.state})</option>)}
        </select>
        <p className="field-hint">{candidates.length === 0 ? "No other model for this label to compare yet: fine-tune one, then come back." : "The chosen model watches the same live data in Monitor, so it can only report, never act, and is compared with the camera next to the active model. Nothing is switched on until you approve and activate it under Label models."}</p>
      </div>

      {blocker && <p className="hint" role="status">{blocker}</p>}
      {!blocker && (
        <div className="flex flex-wrap items-center gap-2">
          {!recording && <Button type="button" disabled={phase === "saving" || restLabel === ""} onClick={start}>Start recording a round</Button>}
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
      <AgreementPanel tracker={tracker} definitions={mine} status={status} cameraOn={camOn} candidateId={candidate} hideUntilReady />

      {rounds.length > 0 && (
        <section className="flex flex-col gap-2" aria-label="Rounds so far">
          <h4 className="text-sm font-semibold">Rounds so far</h4>
          <BarChart
            title="Misses and false alarms by round" exportName={`${modelId}-correction-rounds`} xLabel="Round" yLabel="Count"
            bins={rounds.map((_, i) => `${i + 1}`)}
            series={[
              { name: "Missed", color: "#3b82f6", values: rounds.map((r) => r.active.missed) },
              { name: "False alarms", color: "#ff6f91", values: rounds.map((r) => r.active.falseAlarms) },
            ]}
            summary={`${rounds.length} round${rounds.length === 1 ? "" : "s"} for the active model: ${rounds.map((r, i) => `round ${i + 1} missed ${r.active.missed} of ${r.active.holds}, ${r.active.falseAlarms} false alarms`).join("; ")}.`}
          />
          <div className="max-w-full overflow-auto">
            <table className="w-full text-sm" aria-label="Correction rounds">
              <thead><tr className="text-left"><th>Round</th><th>Active model</th><th>Found</th><th>Missed</th><th>False alarms</th><th>Beside it</th></tr></thead>
              <tbody>
                {rounds.map((round, index) => (
                  <tr key={round.id}>
                    <th scope="row" className="text-left font-normal">{index + 1} <small className="text-muted-foreground">{round.savedAt.slice(0, 16).replace("T", " ")}</small></th>
                    <td><code>{round.active.modelId}</code></td>
                    <td>{round.active.found}/{round.active.holds}</td>
                    <td>{round.active.missed}</td>
                    <td>{round.active.falseAlarms}</td>
                    <td>{round.candidate ? `${round.candidate.modelId}: found ${round.candidate.found}/${round.candidate.holds}, ${round.candidate.falseAlarms} false alarms` : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </fieldset>
  );
}
