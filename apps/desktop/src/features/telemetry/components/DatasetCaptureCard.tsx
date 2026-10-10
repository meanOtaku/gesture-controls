import { useEffect, useRef, useState, type FormEvent } from "react";
import { CatalogueLabelPicker } from "../../labels/CatalogueLabelPicker";
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
import { NumberField } from "../../../components/app/NumberField";
import { parseNumber, type NumberSpec } from "../../../shared/forms/numberField";
import type { FieldState } from "../../../shared/forms/useNumberDrafts";
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
  normalizeDatasetLabel,
} from "../store/telemetryStore";

/** Timeline Capture's timed-recording duration must stay well under the ~6,666s
 * (200,000-row `MAX_CSV_ROWS` at 30Hz) capture buffer limit, while still allowing
 * long sessions: 1 second to 1 hour (3,600 seconds). */
export const TIMELINE_DURATION_SECONDS_MIN = 1;
export const TIMELINE_DURATION_SECONDS_MAX = 3600;
const DEFAULT_TIMELINE_DURATION_SECONDS = 30;
const DURATION_SPEC: NumberSpec = {
  label: "Recording duration",
  unit: "s",
  min: TIMELINE_DURATION_SECONDS_MIN,
  max: TIMELINE_DURATION_SECONDS_MAX,
  step: 1,
  integer: true,
  defaultValue: DEFAULT_TIMELINE_DURATION_SECONDS,
  description: "Stops by itself after this long, counted from the first sample",
};

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
  /** Camera marking is still adding marks to the recording just stopped; exporting now would miss them. */
  exportBusy?: boolean;
  /** Buffered session rows/intervals, for the pre-export data-quality review gate. Empty when there is nothing buffered yet. */
  datasetRows?: DatasetRow[];
  /**
   * Lazy alternative to `datasetRows`: called only when Export is pressed. Prefer it for a
   * live session, whose row buffer holds up to 200,000 rows; passing `datasetRows` makes the
   * parent copy the whole buffer on every render (about 1.3 ms and 1.6 MB each time, at the
   * 15 Hz publish rate) to serve a click that happens once.
   */
  getDatasetRows?: () => DatasetRow[];
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
  exportBusy = false,
  datasetRows = [],
  getDatasetRows,
  timelineIntervals = [],
}: DatasetCaptureCardProps) {
  const [customLabel, setCustomLabel] = useState("");
  const [exportReviewOpen, setExportReviewOpen] = useState(false);
  const [exportReviewSummary, setExportReviewSummary] = useState<RecordingQualitySummary | null>(null);
  const [exportReviewError, setExportReviewError] = useState<string | null>(null);
  const [durationText, setDurationText] = useState(String(DEFAULT_TIMELINE_DURATION_SECONDS));
  const [durationTouched, setDurationTouched] = useState(false);
  const [labelTouched, setLabelTouched] = useState(false);
  const labelInputRef = useRef<HTMLInputElement>(null);
  const duration = parseNumber(durationText, DURATION_SPEC);
  const timelineDurationValid = duration.ok;
  const timelineDurationSeconds = duration.ok ? duration.value : DEFAULT_TIMELINE_DURATION_SECONDS;
  const durationDefaultText = String(DEFAULT_TIMELINE_DURATION_SECONDS);
  const durationState: FieldState = {
    text: durationText,
    dirty: durationText !== durationDefaultText,
    // An out-of-range number is wrong however it was typed; an empty or half-typed one waits for the field to be left.
    error: !duration.ok && (durationTouched || durationText.trim() !== "") ? duration.message : null,
    differsFromDefault: durationText !== durationDefaultText,
  };
  const normalizedLabel = normalizeDatasetLabel(customLabel);
  const labelProblem = customLabel.trim() !== "" && normalizedLabel === null
    ? "Start with a letter, then use letters, numbers or underscores, up to 64 characters."
    : null;
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
    const reviewRows = getDatasetRows ? getDatasetRows() : datasetRows;
    if (reviewRows.length === 0) {
      await onExport();
      return;
    }
    try {
      setExportReviewSummary(computeLiveQualitySummary(reviewRows, timelineIntervals));
      setExportReviewError(null);
    } catch {
      setExportReviewSummary(null);
      setExportReviewError("Data-quality review is unavailable for this session; export will proceed without it.");
    }
    setExportReviewOpen(true);
  };

  const exportReviewHasWarnings = (exportReviewSummary?.warnings.length ?? 0) > 0;

  const applyCustomLabel = (event?: FormEvent) => {
    event?.preventDefault();
    if (onSelectLabel(customLabel)) {
      setCustomLabel("");
      setLabelTouched(false);
    } else {
      setLabelTouched(true);
      labelInputRef.current?.focus();
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
          <form className="field" noValidate onSubmit={applyCustomLabel} data-invalid={(labelTouched || customLabel !== "") && labelProblem ? true : undefined}>
            <div className="field-head">
              <Label htmlFor="dataset-custom-label" required>Dataset label</Label>
              <HelpTooltip label="About labels">
                A label names what you are about to record. It is saved in lower case with underscores in place of anything else, so
                "Wrist Flick" becomes wrist_flick. It must start with a letter and be at most 64 characters.
              </HelpTooltip>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="dataset-custom-label"
                ref={labelInputRef}
                value={customLabel}
                disabled={datasetRecording}
                placeholder="e.g. wrist flick"
                aria-invalid={labelProblem !== null}
                aria-describedby="dataset-custom-label-message"
                autoComplete="off"
                className="min-w-0 flex-1"
                onChange={(event) => setCustomLabel(event.target.value)}
                onBlur={() => setLabelTouched(true)}
              />
              <Button type="submit" variant="outline" disabled={datasetRecording || customLabel.trim().length === 0}>
                Apply label
              </Button>
            </div>
            <p
              id="dataset-custom-label-message"
              className={labelProblem ? "field-error" : "field-hint"}
              role={labelProblem ? "alert" : undefined}
              aria-live={labelProblem ? undefined : "polite"}
            >
              {labelProblem
                ?? (normalizedLabel
                  ? <>Will be saved as <strong>{normalizedLabel}</strong>. Press Enter to apply.</>
                  : "Name what you are about to record, then press Enter.")}
            </p>
          </form>
          {desktopAvailable && <CatalogueLabelPicker selectedLabel={selectedLabel} onSelect={onSelectLabel} disabled={datasetRecording} />}
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
          <div className="max-w-xs">
            <NumberField
              id="timeline-duration-seconds"
              spec={DURATION_SPEC}
              state={durationState}
              disabled={datasetRecording}
              showEdited={false}
              onChange={setDurationText}
              onBlur={() => setDurationTouched(true)}
              onResetToDefault={() => {
                setDurationText(durationDefaultText);
                setDurationTouched(true);
              }}
            />
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
            disabled={datasetRowCount === 0 || exportBusy || (desktopAvailable && !datasetExportFolder)}
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
      </CardContent>
    </Card>
  );
}
