import { useState } from "react";
import { AsyncActionButton } from "../../../components/app/AsyncActionButton";
import { HelpTooltip } from "../../../components/app/HelpTooltip";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { Progress } from "../../../components/ui/progress";
import { ESTIMATED_BYTES_PER_CSV_ROW, MAX_CSV_ROWS } from "../store/telemetryStore";

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type CsvCaptureCardProps = {
  recording: boolean;
  rowCount: number;
  savedCount: number;
  appliedLabel: string;
  onToggleRecording: () => void;
  onSaveCsv: () => Promise<void>;
  onApplyLabel: (label: string) => boolean;
  onClearLabel: () => void;
};

/** Ordinary (unlabeled by default) CSV capture: start/stop the buffer, optionally apply a row label, and save it via the native dialog. */
export function CsvCaptureCard({ recording, rowCount, savedCount, appliedLabel, onToggleRecording, onSaveCsv, onApplyLabel, onClearLabel }: CsvCaptureCardProps) {
  const bufferFull = rowCount >= MAX_CSV_ROWS;
  const [labelDraft, setLabelDraft] = useState("");

  return (
    <Card role="region" aria-label="CSV capture" className="min-w-0">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          CSV capture
          <HelpTooltip label="About CSV capture">
            Captures raw incoming samples into a rolling buffer of the most recent {MAX_CSV_ROWS.toLocaleString()} rows.
            Once full, the oldest rows are dropped to make room for new ones.
          </HelpTooltip>
        </CardTitle>
        <CardDescription>
          {recording ? "Capturing incoming samples" : "Start a capture, then save it as a CSV"}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Progress value={Math.min(100, (rowCount / MAX_CSV_ROWS) * 100)} aria-label="CSV buffer usage">
          <p className="text-xs text-muted-foreground">
            {rowCount.toLocaleString()} / {MAX_CSV_ROWS.toLocaleString()} rows buffered (~{formatBytes(rowCount * ESTIMATED_BYTES_PER_CSV_ROW)} est.)
            {bufferFull ? " · buffer full, oldest rows dropping" : ""}
            {savedCount ? ` · ${savedCount} rows last saved` : ""}
          </p>
        </Progress>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant={recording ? "destructive" : "secondary"} onClick={onToggleRecording}>
            {recording ? "Stop recording" : "Start recording"}
          </Button>
          <AsyncActionButton disabled={rowCount === 0} onPress={onSaveCsv} pendingLabel="Saving…">Save CSV</AsyncActionButton>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="csv-row-label" className="sr-only">Row label</Label>
          <Input
            id="csv-row-label"
            aria-label="Row label"
            value={labelDraft}
            placeholder="Label for captured rows (optional)"
            onChange={(event) => setLabelDraft(event.target.value)}
          />
          <Button type="button" variant="outline" disabled={labelDraft.trim().length === 0} onClick={() => { if (onApplyLabel(labelDraft)) setLabelDraft(""); }}>
            Apply label
          </Button>
          <Button type="button" variant="outline" disabled={appliedLabel.length === 0} onClick={onClearLabel}>
            Clear label
          </Button>
          <HelpTooltip label="About row labels">
            Applying a label stamps it onto every row captured from then on, until cleared. Editing this field alone
            does not change already-buffered rows or the active label — use Apply/Clear.
          </HelpTooltip>
        </div>
        <p className="text-xs text-muted-foreground">
          {appliedLabel ? `Active row label: ${appliedLabel}` : "No row label applied"}
        </p>
      </CardContent>
    </Card>
  );
}
