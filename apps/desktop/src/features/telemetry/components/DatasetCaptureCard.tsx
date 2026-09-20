import { useState } from "react";
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
import {
  type DatasetCaptureMode,
  type DatasetRecordingState,
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
  captureMode: DatasetCaptureMode;
  onCaptureModeChange: (mode: DatasetCaptureMode) => void;
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
  /** Timeline Capture passes the chosen recording duration (seconds); Quick Capture ignores it. */
  onStart: (timelineDurationSeconds?: number) => void;
  onStop: () => void;
  onDiscard: () => void;
  onExport: () => Promise<void>;
};

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Labeled gesture-dataset recorder: pick or type a label, capture a session, then export it. Supports Quick Capture (one label per session) and Timeline Capture (a fixed-duration timed recording, auto-exported on completion). */
export function DatasetCaptureCard({
  captureMode,
  onCaptureModeChange,
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
  onStart,
  onStop,
  onDiscard,
  onExport,
}: DatasetCaptureCardProps) {
  const [customLabel, setCustomLabel] = useState("");
  const [labelError, setLabelError] = useState<string | null>(null);
  const [timelineDurationSeconds, setTimelineDurationSeconds] = useState(DEFAULT_TIMELINE_DURATION_SECONDS);
  const isTimeline = captureMode === "timeline";
  const timelineDurationValid = Number.isInteger(timelineDurationSeconds)
    && timelineDurationSeconds >= TIMELINE_DURATION_SECONDS_MIN
    && timelineDurationSeconds <= TIMELINE_DURATION_SECONDS_MAX;

  const applyCustomLabel = () => {
    if (onSelectLabel(customLabel)) {
      setCustomLabel("");
      setLabelError(null);
    } else {
      setLabelError("Use a label beginning with a letter, followed by letters, numbers, or underscores (up to 64 characters).");
    }
  };

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
            Quick Capture tags the whole session with one label; Timeline Capture runs for a fixed
            duration you set and then automatically exports the unlabeled CSV to the export folder
            below. Either way, raw samples are never rewritten once captured.
          </HelpTooltip>
        </CardTitle>
        <CardDescription>
          {datasetRecordingState === "arming" && (isTimeline ? "Arming — waiting for the first sample" : `Arming "${datasetSession?.label}" — waiting for the first sample`)}
          {datasetRecordingState === "recording" && (isTimeline
            ? `Recording · ${formatElapsed(datasetElapsedMs)} of ${timelineDurationSeconds}s`
            : `Recording "${datasetSession?.label}" · ${formatElapsed(datasetElapsedMs)}`)}
          {datasetRecordingState === "saved" && (isTimeline
            ? `Stopped — ${datasetRowCount.toLocaleString()} rows captured`
            : `Saved "${datasetSession?.label}" — ready to export`)}
          {datasetRecordingState === "discarded" && "Session discarded"}
          {datasetRecordingState === "idle" && (isTimeline
            ? "Ready — set a duration, then Start"
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
          {!isTimeline && (
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
          )}
          {sessionLabels.length > 0 && !isTimeline && (
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
                      disabled={datasetRecording}
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
          {selectedLabel && !isTimeline && (
            <p className="text-xs text-foreground">
              Selected label: <span className="font-semibold">{selectedLabel.replaceAll("_", " ")}</span>
            </p>
          )}
          {isTimeline && (
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
                Timeline Capture runs for exactly this many seconds once the first sample lands, then
                stops and automatically writes the CSV to the export folder below. Must be between
                {" "}{TIMELINE_DURATION_SECONDS_MIN} and {TIMELINE_DURATION_SECONDS_MAX} seconds.
              </HelpTooltip>
            </div>
          )}
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
            disabled={!datasetRecording && (isTimeline ? !timelineDurationValid : !selectedLabel)}
            onClick={datasetRecording ? onStop : () => onStart(isTimeline ? timelineDurationSeconds : undefined)}
          >
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

          <AsyncActionButton
            disabled={datasetRowCount === 0 || (desktopAvailable && !datasetExportFolder)}
            onPress={onExport}
            pendingLabel="Exporting…"
          >
            Export Dataset CSV
          </AsyncActionButton>
          <HelpTooltip label="About exporting the dataset">
            {desktopAvailable
              ? "Saves the buffered labeled rows straight into the export folder above, under an auto-generated timestamped file name — choose a folder first, then Export writes there directly with no save dialog."
              : "Browser preview has no native folder picker, so this downloads the CSV directly instead."}
          </HelpTooltip>
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
