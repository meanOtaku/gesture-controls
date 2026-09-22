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
import type { RecordingQualitySummary } from "../../../shared/tauri/recordingBundle";
import type { LiveInterval } from "../annotations/timeline";
import { computeLiveQualitySummary } from "../quality/computeLiveQualitySummary";
import { RecordingQualitySummaryCard } from "./RecordingQualitySummaryCard";
import {
  type DatasetRecordingState,
  type DatasetRow,
  type DatasetSessionMetadata,
  type GestureDatasetLabel,
} from "../store/telemetryStore";

/** Timeline Capture's timed-recording duration must stay well under the ~6,666s
 * (200,000-row `MAX_CSV_ROWS` at 30Hz) capture buffer limit, while still allowing
 * long sessions: 1 second to 1 hour (3,600 seconds). */
export const TIMELINE_DURATION_SECONDS_MIN = 1;
export const TIMELINE_DURATION_SECONDS_MAX = 3600;
const DEFAULT_TIMELINE_DURATION_SECONDS = 30;

type DatasetCaptureCardProps = {
  selectedLabel: GestureDatasetLabel | null;
  sessionLabels?: GestureDatasetLabel[];
  onRemoveLabel: (label: GestureDatasetLabel) => boolean;
  getLabelRemovalBlockedReason: (label: GestureDatasetLabel) => string | null;
  /** True in the desktop app; false in browser preview, where there is no native folder picker. */
  desktopAvailable: boolean;
  datasetExportFolder: string | null;
  onChooseExportFolder: () => Promise<void>;
  datasetRecording: boolean;
  datasetRecordingState?: DatasetRecordingState;
  datasetSession: DatasetSessionMetadata | null;
  datasetRowCount: number;
  datasetElapsedMs?: number;
  onSelectLabel: (label: GestureDatasetLabel) => boolean;
  /** The label interval currently open on the timeline, if any. */
  activeMarkerLabel: GestureDatasetLabel | null;
  /** Opens a `selectedLabel` interval (hold-to-mark: called on press). */
  onMarkStart: () => void;
  /** Closes the open interval (hold-to-mark: called on release). */
  onMarkEnd: () => void;
  onStart: (timelineDurationSeconds: number) => void;
  onStop: () => void;
  onDiscard: () => void;
  onExport: () => Promise<void>;
  /** Buffered session rows/intervals, for the pre-export data-quality review gate. Empty when there is nothing buffered yet. */
  datasetRows?: DatasetRow[];
  timelineIntervals?: LiveInterval[];
};

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Timeline-oriented gesture-dataset recorder: pick or type a label, set a
 * duration, capture a timed session over the raw stream, mark which stretches
 * the user was performing the label during, then export the labeled dataset
 * CSV. Replaces the old ordinary CSV capture and Quick Capture forms.
 */
export function DatasetCaptureCard({
  selectedLabel,
  sessionLabels = [],
  onRemoveLabel,
  getLabelRemovalBlockedReason,
  desktopAvailable,
  datasetExportFolder,
  onChooseExportFolder,
  datasetRecording,
  datasetRecordingState = "idle",
  datasetSession,
  datasetRowCount,
  datasetElapsedMs = 0,
  onSelectLabel,
  activeMarkerLabel,
  onMarkStart,
  onMarkEnd,
  onStart,
  onStop,
  onDiscard,
  onExport,
  datasetRows = [],
  timelineIntervals = [],
}: DatasetCaptureCardProps) {
  const [customLabel, setCustomLabel] = useState("");
  const [labelError, setLabelError] = useState<string | null>(null);
  const [exportReviewOpen, setExportReviewOpen] = useState(false);
  const [exportReviewSummary, setExportReviewSummary] = useState<RecordingQualitySummary | null>(null);
  const [exportReviewError, setExportReviewError] = useState<string | null>(null);
  const [timelineDurationSeconds, setTimelineDurationSeconds] = useState(DEFAULT_TIMELINE_DURATION_SECONDS);
  const timelineDurationValid = Number.isInteger(timelineDurationSeconds)
    && timelineDurationSeconds >= TIMELINE_DURATION_SECONDS_MIN
    && timelineDurationSeconds <= TIMELINE_DURATION_SECONDS_MAX;
  const isRecording = datasetRecordingState === "recording";
  const isMarking = isRecording && activeMarkerLabel !== null && activeMarkerLabel === selectedLabel;
  const canMark = isRecording && !!selectedLabel;

  const heldRef = useRef(false);
  const onMarkEndRef = useRef(onMarkEnd);
  onMarkEndRef.current = onMarkEnd;

  const beginHold = () => {
    if (heldRef.current || !canMark) return;
    heldRef.current = true;
    onMarkStart();
  };
  const endHold = () => {
    if (!heldRef.current) return;
    heldRef.current = false;
    onMarkEnd();
  };

  // Releases the hold whenever marking becomes unavailable (recording stops,
  // the label is cleared) or a different label is selected — a physically
  // held button must not silently keep marking the old or a new label.
  useEffect(() => {
    if (heldRef.current && !canMark) endHold();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canMark]);
  useEffect(() => {
    if (heldRef.current) endHold();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLabel]);

  // Recording stop/discard and unmount must never leave a marker open.
  useEffect(() => () => { if (heldRef.current) { heldRef.current = false; onMarkEndRef.current(); } }, []);

  /**
   * Data-quality review gate (M4): when a buffered session's rows are
   * available, review its M1 quality summary before exporting rather than
   * exporting straight away. No rows buffered (e.g. a historical/imported
   * flow with nothing in memory to summarize) exports exactly as before —
   * this never blocks or errors on a missing summary.
   */
  const handleExportPress = async () => {
    if (datasetRows.length === 0) {
      await onExport();
      return;
    }
    try {
      setExportReviewSummary(computeLiveQualitySummary(datasetRows, timelineIntervals));
      setExportReviewError(null);
    } catch {
      setExportReviewSummary(null);
      setExportReviewError("Data-quality review is unavailable for this session; export will proceed without it.");
    }
    setExportReviewOpen(true);
  };

  const exportReviewHasWarnings = (exportReviewSummary?.warnings.length ?? 0) > 0;

  const applyCustomLabel = () => {
    if (onSelectLabel(customLabel)) {
      setCustomLabel("");
      setLabelError(null);
    } else {
      setLabelError("Use a label beginning with a letter, followed by letters, numbers, or underscores (up to 64 characters).");
    }
  };

  return (
    <Card role="region" aria-label="Timeline recorder" className="min-w-0">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Timeline recorder
          <HelpTooltip label="About the Timeline recorder">
            Records one continuous raw session for a fixed duration you set. Start arms the
            recorder: data already visible in the graphs above is never included, and the first
            stored row is the first sample accepted after Start — the timer starts counting from
            that first sample too, not from the Start press. While recording, hold the marker
            button down to mark the stretch where you're performing the current label's action;
            release it to stop. Unmarked stretches stay unannotated. Raw samples are never
            rewritten once captured; the
            exported dataset CSV carries the label for every row from these marked intervals.
          </HelpTooltip>
        </CardTitle>
        <CardDescription>
          {datasetRecordingState === "arming" && "Arming — waiting for the first sample"}
          {datasetRecordingState === "recording" && (
            `Recording · ${formatElapsed(datasetElapsedMs)} of ${timelineDurationSeconds}s`
            + (activeMarkerLabel ? ` · marking "${activeMarkerLabel.replaceAll("_", " ")}"` : "")
          )}
          {datasetRecordingState === "saved" && `Stopped — ${datasetRowCount.toLocaleString()} rows captured`}
          {datasetRecordingState === "discarded" && "Session discarded"}
          {datasetRecordingState === "idle" && "Ready — set a label and duration, then Start"}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">{datasetRowCount.toLocaleString()} rows buffered</p>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="dataset-custom-label" className="sr-only">Dataset label</Label>
            <Input
              id="dataset-custom-label"
              aria-label="Dataset label"
              value={customLabel}
              disabled={datasetRecording}
              placeholder="Enter a label"
              onChange={(event) => setCustomLabel(event.target.value)}
            />
            <Button type="button" variant="outline" disabled={datasetRecording || customLabel.trim().length === 0} onClick={applyCustomLabel}>
              Apply label
            </Button>
            <HelpTooltip label="About labels">
              Labels must start with a letter and contain only letters, numbers, or underscores (up to 64 characters).
            </HelpTooltip>
          </div>
          {sessionLabels.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <Label className="text-xs text-muted-foreground w-full">Previously used labels</Label>
              {sessionLabels.map((label) => {
                const removalBlockedReason = datasetRecording
                  ? "Stop dataset capture before removing labels."
                  : getLabelRemovalBlockedReason(label);
                return (
                  <span key={label} className="inline-flex items-center gap-0.5">
                    <Button
                      type="button"
                      variant={selectedLabel === label ? "default" : "outline"}
                      size="sm"
                      onClick={() => onSelectLabel(label)}
                      className="text-xs"
                    >
                      {label.replaceAll("_", " ")}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Remove label ${label}`}
                      title={removalBlockedReason ?? "Remove this label"}
                      disabled={removalBlockedReason !== null}
                      onClick={() => onRemoveLabel(label)}
                    >
                      ×
                    </Button>
                  </span>
                );
              })}
            </div>
          )}
          {selectedLabel && (
            <p className="text-xs text-foreground">
              Selected label: <span className="font-semibold">{selectedLabel.replaceAll("_", " ")}</span>
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="timeline-duration-seconds" className="text-xs text-muted-foreground">
              Duration (seconds):
            </Label>
            <Input
              id="timeline-duration-seconds"
              type="number"
              aria-label="Recording duration in seconds"
              required
              min={TIMELINE_DURATION_SECONDS_MIN}
              max={TIMELINE_DURATION_SECONDS_MAX}
              step={1}
              value={timelineDurationSeconds}
              disabled={datasetRecording}
              className="w-24"
              onChange={(event) => setTimelineDurationSeconds(Number(event.target.value))}
            />
            <HelpTooltip label="About the recording duration">
              Runs for exactly this many seconds once the first sample lands, then stops. Must be
              between {TIMELINE_DURATION_SECONDS_MIN} and {TIMELINE_DURATION_SECONDS_MAX} seconds.
            </HelpTooltip>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Label className="text-xs text-muted-foreground">Export folder:</Label>
          {desktopAvailable ? (
            <>
              <span className="text-xs text-foreground truncate max-w-[16rem]" title={datasetExportFolder ?? undefined}>
                {datasetExportFolder ?? "Not set"}
              </span>
              <Button type="button" variant="outline" size="sm" onClick={() => void onChooseExportFolder()}>
                {datasetExportFolder ? "Change…" : "Browse…"}
              </Button>
            </>
          ) : (
            <span className="text-xs text-muted-foreground">Browser preview downloads the CSV directly.</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant={datasetRecording ? "destructive" : "default"}
            disabled={!datasetRecording && !timelineDurationValid}
            onClick={datasetRecording ? onStop : () => onStart(timelineDurationSeconds)}
          >
            {datasetRecording ? (datasetRecordingState === "arming" ? "Arming…" : "Stop dataset capture") : "Start dataset capture"}
          </Button>

          <Button
            type="button"
            variant={isMarking ? "destructive" : "outline"}
            disabled={!canMark}
            aria-pressed={isMarking}
            title={
              !isRecording
                ? "Start dataset capture before marking"
                : !selectedLabel
                  ? "Enter or select a label to mark"
                  : "Hold (mouse, touch, or Space/Enter) to mark; release to stop"
            }
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
            {!selectedLabel ? "Mark label" : isMarking ? `Marking "${selectedLabel}"…` : `Hold to mark "${selectedLabel}"`}
          </Button>
          <HelpTooltip label="About the marker">
            Enabled only while recording, and only once a valid label is entered or selected
            above. Press and hold (mouse, touch, or Space/Enter) to mark the current label on the
            raw timeline; release to end that interval. It never toggles — releasing, losing
            focus, or the pointer being cancelled all stop marking. Time left unmarked stays
            unannotated in the exported CSV. Hold for at least 300–500 ms per action, starting the
            hold just before the action begins and releasing just after it ends — the current model
            window is 500 ms, so a shorter mark gives it too little context; the quality summary
            below flags any saved interval under 150 ms as likely too brief.
          </HelpTooltip>

          <AlertDialog>
            <AlertDialogTrigger
              render={<Button type="button" variant="outline" disabled={!datasetSession}>Discard</Button>}
            />

            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Discard dataset session?</AlertDialogTitle>
                <AlertDialogDescription>
                  This clears the current unsaved session and its {datasetRowCount.toLocaleString()} buffered rows from memory.
                  This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep session</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={onDiscard}>Discard</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <AsyncActionButton
            disabled={datasetRowCount === 0 || (desktopAvailable && !datasetExportFolder)}
            onPress={handleExportPress}
            pendingLabel="Exporting…"
          >
            Export Dataset CSV
          </AsyncActionButton>
          <HelpTooltip label="About exporting the dataset">
            {desktopAvailable
              ? "Saves the buffered labeled rows straight into the export folder above, under an auto-generated timestamped file name — choose a folder first, then Export writes there directly with no save dialog."
              : "Browser preview has no native folder picker, so this downloads the CSV directly instead."}
          </HelpTooltip>

          <AlertDialog open={exportReviewOpen} onOpenChange={setExportReviewOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Review data quality before export</AlertDialogTitle>
                <AlertDialogDescription>
                  {exportReviewError
                    ? exportReviewError
                    : exportReviewHasWarnings
                      ? "This is a data-quality review of the buffered session, not model validation. Warnings below don't block export, but review them first."
                      : "This is a data-quality review of the buffered session, not model validation. No warnings were found."}
                </AlertDialogDescription>
              </AlertDialogHeader>
              {exportReviewSummary && <RecordingQualitySummaryCard summary={exportReviewSummary} />}
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => void onExport()}>
                  {exportReviewHasWarnings ? "Export anyway" : "Export"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        {labelError && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{labelError}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
