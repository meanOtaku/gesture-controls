import { useState } from "react";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { HelpTooltip } from "../../../components/app/HelpTooltip";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../components/ui/select";
import type { CurationStatus } from "../../../shared/tauri/recordingBundle";
import type { LiveInterval } from "../annotations/timeline";
import type { DatasetRow, GestureDatasetLabel } from "../store/telemetryStore";

type Gap = { startRawRow: number; endRawRow: number };

type RecordingTimelineEditorProps = {
  intervals: LiveInterval[];
  rows: DatasetRow[];
  sessionLabels: GestureDatasetLabel[];
  onRelabel: (intervalId: string, label: GestureDatasetLabel) => boolean;
  onSetCurationStatus: (intervalId: string, status: CurationStatus) => boolean;
  onMoveBoundary: (intervalId: string, edge: "start" | "end", newRawRow: number) => boolean;
  onSplit: (intervalId: string, atRawRow: number) => boolean;
  onCreate: (label: GestureDatasetLabel, startRawRow: number, endRawRow: number) => boolean;
  onDelete: (intervalId: string) => boolean;
};

const CURATION_STATUSES: CurationStatus[] = ["unreviewed", "approved", "excluded"];

function elapsedSeconds(rows: DatasetRow[], rawRow: number): number {
  const first = rows[0];
  const at = rows[Math.min(rawRow, rows.length - 1)];
  if (!first || !at) return 0;
  return (Number(at.timestampNs) - Number(first.timestampNs)) / 1_000_000_000;
}

/** Nearest row index whose elapsed time is closest to `seconds`, clamped to the captured row range. */
function rowFromSeconds(rows: DatasetRow[], seconds: number): number {
  if (rows.length === 0) return 0;
  const targetNs = Number(rows[0].timestampNs) + Math.round(seconds * 1_000_000_000);
  let closest = 0;
  let closestDelta = Number.POSITIVE_INFINITY;
  rows.forEach((row, index) => {
    const delta = Math.abs(Number(row.timestampNs) - targetNs);
    if (delta < closestDelta) {
      closestDelta = delta;
      closest = index;
    }
  });
  return closest;
}

function computeGaps(intervals: LiveInterval[], totalRows: number): Gap[] {
  const closed = intervals
    .filter((interval) => interval.endRawRow !== null)
    .sort((a, b) => a.startRawRow - b.startRawRow);
  const gaps: Gap[] = [];
  let cursor = 0;
  closed.forEach((interval) => {
    if (interval.startRawRow > cursor) gaps.push({ startRawRow: cursor, endRawRow: interval.startRawRow });
    cursor = Math.max(cursor, interval.endRawRow as number);
  });
  if (cursor < totalRows) gaps.push({ startRawRow: cursor, endRawRow: totalRows });
  return gaps;
}

function formatMmSs(seconds: number): string {
  const totalSeconds = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

/**
 * Post-capture editor for a Timeline Capture session's saved intervals:
 * split, move boundaries, relabel, set curation status, delete, and fill an
 * unannotated gap with a new interval. Every edit is boundary/overlap-safe
 * (enforced in the store) and never touches raw rows or timestamps.
 */
export function RecordingTimelineEditor({
  intervals,
  rows,
  sessionLabels,
  onRelabel,
  onSetCurationStatus,
  onMoveBoundary,
  onSplit,
  onCreate,
  onDelete,
}: RecordingTimelineEditorProps) {
  const [error, setError] = useState<string | null>(null);
  const sorted = [...intervals].sort((a, b) => a.startRawRow - b.startRawRow);
  const gaps = computeGaps(intervals, rows.length);

  const guard = (label: string, ok: boolean) => {
    setError(ok ? null : `${label} failed: the edit would overlap another interval or fall outside the recording.`);
  };

  return (
    <div aria-label="Recording timeline editor" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="label">Timeline intervals</span>
        <HelpTooltip label="About editing the timeline">
          Split, move, relabel, exclude, or delete label intervals before exporting. Raw sensor data never
          changes — only this interval metadata. Unlabeled stretches stay unannotated on purpose.
        </HelpTooltip>
      </div>

      {rows.length === 0 && <p className="text-xs text-muted-foreground">No rows captured.</p>}

      <div className="flex flex-col gap-2">
        {sorted.map((interval) => (
          <div key={interval.intervalId} className="vector-row flex flex-wrap items-center gap-2">
            <Badge variant="outline">{interval.labelId.replaceAll("_", " ")}</Badge>
            <span className="text-xs text-muted-foreground">
              {formatMmSs(elapsedSeconds(rows, interval.startRawRow))} – {formatMmSs(elapsedSeconds(rows, (interval.endRawRow ?? interval.startRawRow) - 1))}
            </span>

            <Select value={interval.labelId} onValueChange={(label) => guard("Relabel", onRelabel(interval.intervalId, label))}>
              <SelectTrigger className="w-[140px]" aria-label={`Relabel interval starting at ${formatMmSs(elapsedSeconds(rows, interval.startRawRow))}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sessionLabels.map((label) => (
                  <SelectItem key={label} value={label}>{label.replaceAll("_", " ")}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={interval.curationStatus}
              onValueChange={(status) => guard("Curation status", onSetCurationStatus(interval.intervalId, status as CurationStatus))}
            >
              <SelectTrigger className="w-[120px]" aria-label={`Curation status for ${interval.labelId}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CURATION_STATUSES.map((status) => (
                  <SelectItem key={status} value={status}>{status}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <BoundaryEditor
              label="Start"
              seconds={elapsedSeconds(rows, interval.startRawRow)}
              onCommit={(seconds) => guard("Move start", onMoveBoundary(interval.intervalId, "start", rowFromSeconds(rows, seconds)))}
            />
            <BoundaryEditor
              label="End"
              seconds={elapsedSeconds(rows, (interval.endRawRow ?? interval.startRawRow))}
              onCommit={(seconds) => guard("Move end", onMoveBoundary(interval.intervalId, "end", rowFromSeconds(rows, seconds)))}
            />

            <SplitControl
              seconds={elapsedSeconds(rows, interval.startRawRow)}
              onSplit={(seconds) => guard("Split", onSplit(interval.intervalId, rowFromSeconds(rows, seconds)))}
            />

            <Button type="button" variant="outline" size="sm" onClick={() => onDelete(interval.intervalId)}>
              Delete
            </Button>
          </div>
        ))}
        {sorted.length === 0 && <p className="text-xs text-muted-foreground">No labeled intervals yet — the whole recording is unannotated.</p>}
      </div>

      {gaps.length > 0 && (
        <div className="flex flex-col gap-2">
          <Label className="text-xs text-muted-foreground w-full">Unannotated gaps</Label>
          {gaps.map((gap) => (
            <GapFiller
              key={`${gap.startRawRow}-${gap.endRawRow}`}
              gap={gap}
              rows={rows}
              sessionLabels={sessionLabels}
              onCreate={(label) => guard("Fill gap", onCreate(label, gap.startRawRow, gap.endRawRow))}
            />
          ))}
        </div>
      )}

      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
    </div>
  );
}

function BoundaryEditor({ label, seconds, onCommit }: { label: string; seconds: number; onCommit: (seconds: number) => void }) {
  const [value, setValue] = useState(seconds.toFixed(1));
  return (
    <div className="flex items-center gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Input
        aria-label={`${label} time in seconds`}
        className="w-20"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => {
          const parsed = Number(value);
          if (Number.isFinite(parsed)) onCommit(parsed);
        }}
      />
    </div>
  );
}

function SplitControl({ seconds, onSplit }: { seconds: number; onSplit: (seconds: number) => void }) {
  const [value, setValue] = useState((seconds + 1).toFixed(1));
  return (
    <div className="flex items-center gap-1">
      <Input aria-label="Split at time in seconds" className="w-20" value={value} onChange={(event) => setValue(event.target.value)} />
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          const parsed = Number(value);
          if (Number.isFinite(parsed)) onSplit(parsed);
        }}
      >
        Split
      </Button>
    </div>
  );
}

function GapFiller({
  gap,
  rows,
  sessionLabels,
  onCreate,
}: {
  gap: Gap;
  rows: DatasetRow[];
  sessionLabels: GestureDatasetLabel[];
  onCreate: (label: GestureDatasetLabel) => void;
}) {
  const [label, setLabel] = useState(sessionLabels[0] ?? "");
  return (
    <div className="vector-row flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">
        {formatMmSs(elapsedSeconds(rows, gap.startRawRow))} – {formatMmSs(elapsedSeconds(rows, gap.endRawRow - 1))} unannotated
      </span>
      {sessionLabels.length > 0 ? (
        <>
          <Select value={label} onValueChange={setLabel}>
            <SelectTrigger className="w-[140px]" aria-label="Label for new interval">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sessionLabels.map((entry) => (
                <SelectItem key={entry} value={entry}>{entry.replaceAll("_", " ")}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button type="button" variant="outline" size="sm" disabled={!label} onClick={() => onCreate(label)}>
            Fill gap
          </Button>
        </>
      ) : (
        <span className="text-xs text-muted-foreground">Create a label first to fill this gap.</span>
      )}
    </div>
  );
}
