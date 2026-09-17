import { useEffect, useRef, useState } from "react";
import { AsyncActionButton } from "../../../components/app/AsyncActionButton";
import { HelpTooltip } from "../../../components/app/HelpTooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../../../components/ui/alert-dialog";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import type { CurationStatus } from "../../../shared/tauri/recordingBundle";
import type { LiveInterval } from "../annotations/timeline";
import {
  type DatasetCaptureMode,
  type DatasetRecordingState,
  type DatasetRow,
  type DatasetSessionMetadata,
  type GestureDatasetLabel,
} from "../store/telemetryStore";
import { RecordingTimelineEditor } from "./RecordingTimelineEditor";

type DatasetCaptureCardProps = {
  captureMode: DatasetCaptureMode;
  onCaptureModeChange: (mode: DatasetCaptureMode) => void;
  selectedLabel: GestureDatasetLabel | null;
  sessionLabels?: GestureDatasetLabel[];
  datasetRecording: boolean;
  datasetRecordingState?: DatasetRecordingState;
  datasetSession: DatasetSessionMetadata | null;
  datasetRowCount: number;
  datasetElapsedMs?: number;
  datasetRows: DatasetRow[];
  timelineIntervals: LiveInterval[];
  activeTimelineLabel: GestureDatasetLabel | null;
  onSelectLabel: (label: GestureDatasetLabel) => boolean;
  onStart: () => void;
  onStop: () => void;
  onDiscard: () => void;
  onExport: () => Promise<void>;
  /** Timeline Capture only: persists the recording bundle after the user has reviewed/edited intervals in the "saved" state. Quick Capture saves automatically on Stop. */
  onSaveRecording: () => Promise<void>;
  onSetTimelineLabel: (label: GestureDatasetLabel | null, mechanism?: "hotkey_hold" | "hotkey_toggle") => boolean;
  onRelabelInterval: (intervalId: string, label: GestureDatasetLabel) => boolean;
  onSetIntervalCurationStatus: (intervalId: string, status: CurationStatus) => boolean;
  onMoveIntervalBoundary: (intervalId: string, edge: "start" | "end", newRawRow: number) => boolean;
  onSplitInterval: (intervalId: string, atRawRow: number) => boolean;
  onCreateInterval: (label: GestureDatasetLabel, startRawRow: number, endRawRow: number) => boolean;
  onDeleteInterval: (intervalId: string) => boolean;
};

/** Ignore label hotkeys while the user is typing anywhere in the app, matching App.tsx's focus-safe convention. */
function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName));
}

/** Which modifier distinguishes a hold-to-label press from a plain toggle press. Change this single constant to remap. */
const HOLD_MODIFIER: "altKey" | "shiftKey" | "ctrlKey" | "metaKey" = "altKey";

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Labeled gesture-dataset recorder: pick or type a label, capture a session, then export it. Supports Quick Capture (one label per session) and Timeline Capture (multiple live-annotated intervals). */
export function DatasetCaptureCard({
  captureMode,
  onCaptureModeChange,
  selectedLabel,
  sessionLabels = [],
  datasetRecording,
  datasetRecordingState = "idle",
  datasetSession,
  datasetRowCount,
  datasetElapsedMs = 0,
  datasetRows,
  timelineIntervals,
  activeTimelineLabel,
  onSelectLabel,
  onStart,
  onStop,
  onDiscard,
  onExport,
  onSaveRecording,
  onSetTimelineLabel,
  onRelabelInterval,
  onSetIntervalCurationStatus,
  onMoveIntervalBoundary,
  onSplitInterval,
  onCreateInterval,
  onDeleteInterval,
}: DatasetCaptureCardProps) {
  const [customLabel, setCustomLabel] = useState("");
  const [labelError, setLabelError] = useState<string | null>(null);
  const isTimeline = captureMode === "timeline";

  const applyCustomLabel = () => {
    if (onSelectLabel(customLabel)) {
      setCustomLabel("");
      setLabelError(null);
    } else {
      setLabelError("Use a label beginning with a letter, followed by letters, numbers, or underscores (up to 64 characters).");
    }
  };

  // Keeps the hold-key effect's closures reading the current active label without re-subscribing listeners on every change.
  const activeTimelineLabelRef = useRef(activeTimelineLabel);
  useEffect(() => {
    activeTimelineLabelRef.current = activeTimelineLabel;
  }, [activeTimelineLabel]);

  // Number-key hotkeys (1-9) toggle the matching session label live; 0/Escape clears the active label,
  // leaving a gap. Holding the modifier (see HOLD_MODIFIER) while pressing a number instead opens the
  // label only for as long as the key is held: keydown begins the interval, keyup ends it. Only active
  // during a Timeline Capture that has actually started recording.
  useEffect(() => {
    if (!isTimeline || datasetRecordingState !== "recording") return;
    let heldKeyCode: string | null = null;
    let heldLabel: GestureDatasetLabel | null = null;

    const handleKeydown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;

      if (event[HOLD_MODIFIER]) {
        if (event.repeat || event.code === heldKeyCode) return;
        const index = Number(event.key) - 1;
        if (Number.isInteger(index) && index >= 0 && index < sessionLabels.length) {
          const label = sessionLabels[index];
          if (onSetTimelineLabel(label, "hotkey_hold")) {
            heldKeyCode = event.code;
            heldLabel = label;
          }
        }
        return;
      }

      if (event.key === "0" || event.key === "Escape") {
        onSetTimelineLabel(null, "hotkey_toggle");
        return;
      }
      const index = Number(event.key) - 1;
      if (Number.isInteger(index) && index >= 0 && index < sessionLabels.length) {
        onSetTimelineLabel(sessionLabels[index], "hotkey_toggle");
      }
    };

    const handleKeyup = (event: KeyboardEvent) => {
      if (event.code !== heldKeyCode) return;
      // Only close the interval this key opened — if another hotkey (hold or toggle) already
      // changed the active label since, this key's release must not clobber it.
      if (activeTimelineLabelRef.current === heldLabel) {
        onSetTimelineLabel(null, "hotkey_hold");
      }
      heldKeyCode = null;
      heldLabel = null;
    };

    window.addEventListener("keydown", handleKeydown);
    window.addEventListener("keyup", handleKeyup);
    return () => {
      window.removeEventListener("keydown", handleKeydown);
      window.removeEventListener("keyup", handleKeyup);
    };
  }, [isTimeline, datasetRecordingState, sessionLabels, onSetTimelineLabel]);

  return (
    <Card role="region" aria-label="Labeled dataset recorder" className="min-w-0">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Labeled dataset recorder
          <HelpTooltip label="About the labeled dataset recorder">
            Records a separate, labeled session used to train gesture models — distinct from the
            ordinary CSV capture above. Start arms the recorder: data already visible in the graphs
            above is never included, and the first stored row is the first sample accepted after
            Start. The timer starts counting from that first sample too, not from the Start press.
            Quick Capture tags the whole session with one label; Timeline Capture lets you switch
            labels live during a longer recording, leaving unlabeled stretches unannotated rather
            than a false negative. Either way, raw samples are never rewritten once captured — only
            label/interval metadata can change afterward.
          </HelpTooltip>
        </CardTitle>
        <CardDescription>
          {datasetRecordingState === "arming" && (isTimeline ? "Arming — waiting for the first sample" : `Arming "${datasetSession?.label}" — waiting for the first sample`)}
          {datasetRecordingState === "recording" && (isTimeline
            ? `Recording · ${formatElapsed(datasetElapsedMs)} · active label: ${activeTimelineLabel ? activeTimelineLabel.replaceAll("_", " ") : "none (unannotated)"}`
            : `Recording "${datasetSession?.label}" · ${formatElapsed(datasetElapsedMs)}`)}
          {datasetRecordingState === "saved" && (isTimeline
            ? `Saved · ${timelineIntervals.length} interval${timelineIntervals.length === 1 ? "" : "s"} — review below before exporting`
            : `Saved "${datasetSession?.label}" — ready to export`)}
          {datasetRecordingState === "discarded" && "Session discarded"}
          {datasetRecordingState === "idle" && (isTimeline
            ? "Ready — create labels below, then Start and switch labels live"
            : (selectedLabel ? `Ready to record "${selectedLabel.replaceAll("_", " ")}"` : "Enter or select a label to start"))}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Tabs
          value={captureMode}
          onValueChange={(value) => onCaptureModeChange(value as DatasetCaptureMode)}
          aria-label="Capture mode"
        >
          <TabsList>
            <TabsTrigger value="quick" disabled={datasetRecording}>Quick Capture</TabsTrigger>
            <TabsTrigger value="timeline" disabled={datasetRecording}>Timeline Capture</TabsTrigger>
          </TabsList>
        </Tabs>

        <p className="text-xs text-muted-foreground">
          {datasetRowCount.toLocaleString()} rows buffered
          {!isTimeline && datasetSession ? ` · session label: ${datasetSession.label}` : ""}
        </p>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="dataset-custom-label" className="sr-only">Dataset label</Label>
            <Input
              id="dataset-custom-label"
              aria-label="Dataset label"
              value={customLabel}
              disabled={datasetRecording && !isTimeline}
              placeholder="Enter a label"
              onChange={(event) => setCustomLabel(event.target.value)}
            />
            <Button type="button" variant="outline" disabled={(datasetRecording && !isTimeline) || customLabel.trim().length === 0} onClick={applyCustomLabel}>
              Apply label
            </Button>
            <HelpTooltip label="About labels">
              Labels must start with a letter and contain only letters, numbers, or underscores (up to 64 characters).
            </HelpTooltip>
          </div>
          {sessionLabels.length > 0 && !isTimeline && (
            <div className="flex flex-wrap gap-2">
              <Label className="text-xs text-muted-foreground w-full">Previously used labels</Label>
              {sessionLabels.map((label) => (
                <Button
                  key={label}
                  type="button"
                  variant={selectedLabel === label ? "default" : "outline"}
                  size="sm"
                  disabled={datasetRecording}
                  onClick={() => onSelectLabel(label)}
                  className="text-xs"
                >
                  {label.replaceAll("_", " ")}
                </Button>
              ))}
            </div>
          )}
          {selectedLabel && !isTimeline && (
            <p className="text-xs text-foreground">
              Selected label: <span className="font-semibold">{selectedLabel.replaceAll("_", " ")}</span>
            </p>
          )}
          {isTimeline && sessionLabels.length > 0 && datasetRecordingState === "recording" && (
            <div className="flex flex-wrap gap-2">
              <Label className="text-xs text-muted-foreground w-full">
                Live labels — click, or press 1-9 to toggle (0/Esc clears), or hold Alt+1-9 to label only while held
              </Label>
              {sessionLabels.map((label, index) => (
                <Button
                  key={label}
                  type="button"
                  variant={activeTimelineLabel === label ? "default" : "outline"}
                  size="sm"
                  onClick={() => onSetTimelineLabel(label, "hotkey_toggle")}
                  className="text-xs"
                >
                  {index < 9 ? `${index + 1}. ` : ""}{label.replaceAll("_", " ")}
                </Button>
              ))}
              <Button type="button" variant="ghost" size="sm" disabled={!activeTimelineLabel} onClick={() => onSetTimelineLabel(null)} className="text-xs">
                Clear (gap)
              </Button>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant={datasetRecording ? "destructive" : "default"} disabled={!datasetRecording && !isTimeline && !selectedLabel} onClick={datasetRecording ? onStop : onStart}>
            {datasetRecording ? (datasetRecordingState === "arming" ? "Arming…" : "Stop dataset capture") : "Start dataset capture"}
          </Button>

          <AlertDialog>
            <AlertDialogTrigger
              render={<Button type="button" variant="outline" disabled={!datasetSession}>Discard</Button>}
            />

            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Discard dataset session?</AlertDialogTitle>
                <AlertDialogDescription>
                  This clears the current labeled session and its {datasetRowCount.toLocaleString()} buffered rows from memory.
                  This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep session</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={onDiscard}>Discard</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <AsyncActionButton disabled={datasetRowCount === 0} onPress={onExport} pendingLabel="Exporting…">
            Export Dataset CSV
          </AsyncActionButton>
          <HelpTooltip label="About exporting the dataset">
            Saves the buffered labeled rows to a CSV file you choose, through the native save dialog.
          </HelpTooltip>
          {isTimeline && (
            <>
              <AsyncActionButton
                disabled={datasetRecordingState !== "saved" || datasetRowCount === 0}
                onPress={onSaveRecording}
                pendingLabel="Saving…"
              >
                Save recording bundle
              </AsyncActionButton>
              <HelpTooltip label="About saving the recording bundle">
                Persists the immutable raw.csv/recording.json/annotations.json bundle with your reviewed
                intervals. Review the timeline below first — this captures its current state.
              </HelpTooltip>
            </>
          )}
        </div>
        {labelError && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{labelError}</AlertDescription>
          </Alert>
        )}
        {isTimeline && datasetRecordingState === "saved" && (
          <RecordingTimelineEditor
            intervals={timelineIntervals}
            rows={datasetRows}
            sessionLabels={sessionLabels}
            onRelabel={onRelabelInterval}
            onSetCurationStatus={onSetIntervalCurationStatus}
            onMoveBoundary={onMoveIntervalBoundary}
            onSplit={onSplitInterval}
            onCreate={onCreateInterval}
            onDelete={onDeleteInterval}
          />
        )}
      </CardContent>
    </Card>
  );
}
