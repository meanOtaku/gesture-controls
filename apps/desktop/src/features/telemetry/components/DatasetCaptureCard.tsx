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
import {
  type DatasetSessionMetadata,
  type GestureDatasetLabel,
} from "../store/telemetryStore";

type DatasetCaptureCardProps = {
  selectedLabel: GestureDatasetLabel | null;
  sessionLabels: GestureDatasetLabel[];
  datasetRecording: boolean;
  datasetSession: DatasetSessionMetadata | null;
  datasetRowCount: number;
  onSelectLabel: (label: GestureDatasetLabel) => boolean;
  onStart: () => void;
  onStop: () => void;
  onDiscard: () => void;
  onExport: () => Promise<void>;
};

/** Labeled gesture-dataset recorder: pick or type a label, capture a session, then export it. */
export function DatasetCaptureCard({
  selectedLabel,
  sessionLabels,
  datasetRecording,
  datasetSession,
  datasetRowCount,
  onSelectLabel,
  onStart,
  onStop,
  onDiscard,
  onExport,
}: DatasetCaptureCardProps) {
  const [customLabel, setCustomLabel] = useState("");
  const [labelError, setLabelError] = useState<string | null>(null);

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
            ordinary CSV capture above. Each session is tagged with the label selected when it starts.
          </HelpTooltip>
        </CardTitle>
        <CardDescription>
          {datasetRecording ? `Recording "${datasetSession?.label}"` : selectedLabel ? `Ready to record "${selectedLabel.replaceAll("_", " ")}"` : "Enter or select a label to start"}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          {datasetRowCount.toLocaleString()} rows buffered
          {datasetSession ? ` · session label: ${datasetSession.label}` : ""}
        </p>
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
          {selectedLabel && (
            <p className="text-xs text-foreground">
              Selected label: <span className="font-semibold">{selectedLabel.replaceAll("_", " ")}</span>
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant={datasetRecording ? "destructive" : "default"} disabled={!datasetRecording && !selectedLabel} onClick={datasetRecording ? onStop : onStart}>
            {datasetRecording ? "Stop dataset capture" : "Start dataset capture"}
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
