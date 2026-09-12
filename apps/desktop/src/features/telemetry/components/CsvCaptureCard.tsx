import { AsyncActionButton } from "../../../components/app/AsyncActionButton";
import { HelpTooltip } from "../../../components/app/HelpTooltip";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
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
  onToggleRecording: () => void;
  onSaveCsv: () => Promise<void>;
};

/** Ordinary (unlabeled) CSV capture: start/stop the buffer and save it via the native dialog. */
export function CsvCaptureCard({ recording, rowCount, savedCount, onToggleRecording, onSaveCsv }: CsvCaptureCardProps) {
  const bufferFull = rowCount >= MAX_CSV_ROWS;

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
      </CardContent>
    </Card>
  );
}
