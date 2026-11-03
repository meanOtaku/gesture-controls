import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { CameraAssistCard } from "../../gestureLibrary/CameraAssistCard";
import { cameraAssist } from "../../gestureLibrary/cameraAssist";
import type { DatasetLabel } from "../../model-lab/types";
import { timedCapture } from "../recording/timedCapture";
import { telemetryStore } from "../store/telemetryStore";

export const MIN_SECONDS = 5;
export const MAX_SECONDS = 3600;
const DEFAULT_SECONDS = 60;

const clock = (ms: number) => {
  const seconds = Math.ceil(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** How long the running timed capture has left, re-read four times a second while recording. */
function useRemaining(recording: boolean, chosenSeconds: number, elapsedMs: number): { remainingMs: number; totalSeconds: number } {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => tick((n) => n + 1), 250);
    return () => window.clearInterval(timer);
  }, [recording]);
  const running = timedCapture.running();
  if (running) return { remainingMs: Math.max(0, running.deadlineMs - Date.now()), totalSeconds: running.totalSeconds };
  return { remainingMs: Math.max(0, chosenSeconds * 1000 - elapsedMs), totalSeconds: chosenSeconds };
}

/**
 * Records any of your gestures (fist, thumbs up, …) for a set time. The camera marks it where it sees the gesture's
 * library gesture; otherwise hold the marker while you make it. Pinch in / out and everyday noise have their own cards.
 * The recording is saved by itself when it stops; add it to the training data from Model Lab, or review it straight away.
 */
export function GestureRecordingCard({ desktopAvailable, onStop }: {
  desktopAvailable: boolean;
  /** Stops the recording and saves it. */
  onStop: () => void;
}) {
  useSyncExternalStore(telemetryStore.subscribe, telemetryStore.getVersion, telemetryStore.getVersion);
  const [labels, setLabels] = useState<DatasetLabel[]>([]);
  const [secondsText, setSecondsText] = useState(String(DEFAULT_SECONDS));
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!desktopAvailable) return;
    invoke<DatasetLabel[]>("list_model_labels")
      .then((all) => setLabels((Array.isArray(all) ? all : []).filter((label) => label.archivedAt === null && label.role === "positiveGesture" && !label.standard)))
      .catch(() => setLabels([]));
  }, [desktopAvailable]);
  useEffect(load, [load]);

  const state = telemetryStore.getDatasetRecordingState();
  const recording = telemetryStore.getDatasetRecording();
  const isRecording = state === "recording";
  const selected = telemetryStore.getSelectedLabel();
  const extraLabels = telemetryStore.getExtraLabels();
  const active = telemetryStore.getActiveTimelineLabel();
  const seconds = Number(secondsText);
  const secondsOk = Number.isInteger(seconds) && seconds >= MIN_SECONDS && seconds <= MAX_SECONDS;
  const remaining = useRemaining(isRecording, secondsOk ? seconds : DEFAULT_SECONDS, telemetryStore.getDatasetRecordingElapsedMs());
  // Whether the camera marks this recording; when it does not, the gesture is marked by hand.
  const cameraMarks = cameraAssist.willMark(telemetryStore.getMarkLabels());
  const marking = isRecording && selected !== null && active === selected;

  const start = () => {
    setError(null);
    const markLabels = telemetryStore.getMarkLabels();
    const assisted = cameraAssist.willMark(markLabels);
    telemetryStore.setDatasetCaptureMode("timeline");
    timedCapture.request(seconds);
    if (!telemetryStore.startDatasetRecording()) {
      timedCapture.take();
      setError("Could not start: stop the recording under way first.");
      return;
    }
    if (assisted && markLabels.length > 0) cameraAssist.arm(markLabels);
  };
  const discard = () => {
    cameraAssist.disarm();
    telemetryStore.discardDatasetRecording();
  };

  // Hold to mark: pressed opens an interval of the gesture, released closes it.
  const held = useRef(false);
  const beginHold = () => {
    if (held.current || !isRecording || !selected) return;
    held.current = true;
    telemetryStore.setTimelineLabel(selected, "hotkey_hold");
  };
  const endHold = () => {
    if (!held.current) return;
    held.current = false;
    telemetryStore.setTimelineLabel(null);
  };
  useEffect(() => {
    if (!isRecording && held.current) endHold();
  }, [isRecording]);

  const status = state === "arming"
    ? "Waiting for the watch's first sample…"
    : isRecording
      ? `Recording · ${clock(remaining.remainingMs)} left of ${remaining.totalSeconds}s${active ? ` · marking "${active.replaceAll("_", " ")}"` : ""}`
      : null;

  return (
    <Card role="region" aria-label="Record a gesture" className="min-w-0">
      <CardHeader>
        <SectionHeader
          title="Record a gesture"
          description="Any of your gestures, for a set time, marked by the camera or by hand."
          help={{
            label: "About recording a gesture",
            content: "Choose one of your gestures (make them on the Labels tab) and how long to record, then Start. Make the gesture now and then, with the watch hand in view of the camera and still in between. If the Gesture library has a gesture for it and the camera is on, the camera marks it where it sees it; otherwise hold Hold to mark (or Space) while you make it. Stretches you do not mark are left out of training. The recording stops and is saved by itself at the end, or with Stop and save. For pinch in and pinch out, and for everyday noise, use their own cards above.",
          }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="field">
            <Label htmlFor="gesture-recording-label" required>Gesture</Label>
            <select
              id="gesture-recording-label"
              className="recipe-select"
              value={selected ?? ""}
              disabled={recording}
              onChange={(event) => {
                if (event.target.value) telemetryStore.selectDatasetLabel(event.target.value);
              }}
            >
              <option value="">Choose…</option>
              {labels.map((label) => <option key={label.id} value={label.id}>{label.displayName}</option>)}
              {selected && !labels.some((label) => label.id === selected) && <option value={selected}>{selected.replaceAll("_", " ")}</option>}
            </select>
            {desktopAvailable && labels.length === 0 && <p className="field-hint">Add your gestures on the Labels tab.</p>}
          </div>
          <div className="field">
            <Label htmlFor="gesture-recording-seconds">Recording duration (s)</Label>
            <Input id="gesture-recording-seconds" aria-label="Recording duration" type="number" min={MIN_SECONDS} max={MAX_SECONDS} value={secondsText} disabled={recording} onChange={(event) => setSecondsText(event.target.value)} />
            {!secondsOk && <p className="field-error" role="alert">{MIN_SECONDS} to {MAX_SECONDS} seconds.</p>}
          </div>
        </div>
        <CameraAssistCard
          embedded
          selectedLabel={selected}
          extraLabels={extraLabels}
          onToggleExtraLabel={(label) => telemetryStore.toggleExtraLabel(label)}
          recording={recording}
          desktopAvailable={desktopAvailable}
        />
        {status && <p className="text-sm" role="status">{status}</p>}
        {isRecording && (
          <div className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs text-muted-foreground">Time remaining</span>
              <span role="timer" aria-label="Time remaining" aria-live="off" className="text-2xl font-semibold tabular-nums">{clock(remaining.remainingMs)}</span>
            </div>
            <div className="gesture-meter" role="progressbar" aria-label="Recording progress" aria-valuemin={0} aria-valuemax={remaining.totalSeconds} aria-valuenow={Math.round(remaining.totalSeconds - remaining.remainingMs / 1000)}>
              <div className="gesture-meter-fill" style={{ width: `${remaining.totalSeconds > 0 ? Math.min(100, 100 - remaining.remainingMs / (remaining.totalSeconds * 10)) : 0}%` }} />
            </div>
          </div>
        )}
        {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
        <div className="flex flex-wrap items-center gap-2">
          {!recording ? (
            <Button type="button" disabled={!secondsOk || selected === null} onClick={start}>Start recording</Button>
          ) : (
            <>
              <Button type="button" variant="destructive" onClick={onStop}>{state === "arming" ? "Cancel" : "Stop and save"}</Button>
              {isRecording && !cameraMarks && (
                <Button
                  type="button"
                  variant={marking ? "destructive" : "outline"}
                  aria-pressed={marking}
                  disabled={!selected}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    beginHold();
                    event.currentTarget.setPointerCapture?.(event.pointerId);
                  }}
                  onPointerUp={endHold}
                  onPointerCancel={endHold}
                  onLostPointerCapture={endHold}
                  onBlur={endHold}
                  onKeyDown={(event) => {
                    if ((event.key === " " || event.key === "Enter") && !event.repeat) {
                      event.preventDefault();
                      beginHold();
                    }
                  }}
                  onKeyUp={(event) => {
                    if (event.key === " " || event.key === "Enter") {
                      event.preventDefault();
                      endHold();
                    }
                  }}
                >
                  {marking ? `Marking "${selected}"…` : `Hold to mark "${selected}"`}
                </Button>
              )}
              <Button type="button" variant="ghost" onClick={discard}>Discard</Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
