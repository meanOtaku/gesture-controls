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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../components/ui/select";
import {
  GESTURE_DATASET_LABELS,
  type DatasetSessionMetadata,
  type GestureDatasetLabel,
} from "../store/telemetryStore";

type DatasetCaptureCardProps = {
  selectedLabel: GestureDatasetLabel;
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
          {datasetRecording ? `Recording "${datasetSession?.label}"` : "Select a label, then start a labeled capture"}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          {datasetRowCount.toLocaleString()} rows buffered
          {datasetSession ? ` · session label: ${datasetSession.label}` : ""}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="dataset-label-select" className="sr-only">Dataset label</Label>
          <Select
            value={selectedLabel}
            disabled={datasetRecording}
            onValueChange={(value) => onSelectLabel(value as GestureDatasetLabel)}
          >
            <SelectTrigger id="dataset-label-select" aria-label="Dataset label">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {!GESTURE_DATASET_LABELS.some((label) => label === selectedLabel) && (
                <SelectItem value={selectedLabel}>{selectedLabel.replaceAll("_", " ")}</SelectItem>
              )}
              {GESTURE_DATASET_LABELS.map((label) => (
                <SelectItem key={label} value={label}>{label.replaceAll("_", " ")}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Label htmlFor="dataset-custom-label" className="sr-only">Custom dataset label</Label>
          <Input
            id="dataset-custom-label"
            aria-label="Custom dataset label"
            value={customLabel}
            disabled={datasetRecording}
            placeholder="Custom label"
            className="w-36"
            onChange={(event) => setCustomLabel(event.target.value)}
          />
          <Button type="button" variant="outline" disabled={datasetRecording || customLabel.trim().length === 0} onClick={applyCustomLabel}>
            Use custom label
          </Button>
          <HelpTooltip label="About custom labels">
            Custom labels must start with a letter and contain only letters, numbers, or underscores (up to 64 characters).
          </HelpTooltip>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant={datasetRecording ? "destructive" : "default"} onClick={datasetRecording ? onStop : onStart}>
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
