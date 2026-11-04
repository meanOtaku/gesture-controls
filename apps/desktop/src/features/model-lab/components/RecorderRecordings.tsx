import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useId, useState } from "react";
import { OperationFeedback } from "../../../components/app/OperationFeedback";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { Label } from "../../../components/ui/label";
import { listRecordingBundles, onRecordingsChanged, type RecordingBundleSummary } from "../../../shared/tauri/recordingBundle";
import type { DatasetLabel, DatasetSummary } from "../types";
import { recordingTag } from "../../../shared/tauri/recordingTag";

export type IntervalFilter = "notExcluded" | "approvedOnly";

type Props = {
  desktopAvailable: boolean;
  labels: DatasetLabel[];
  datasets: DatasetSummary[];
  /** Called after a recording was added, so the recordings list refreshes. */
  onAdded: () => void;
};

/** How many labelled intervals of a recording a filter keeps. */
export function eligibleIntervals(summary: Pick<RecordingBundleSummary, "approvedCount" | "unreviewedCount">, filter: IntervalFilter): number {
  return filter === "approvedOnly" ? summary.approvedCount : summary.approvedCount + summary.unreviewedCount;
}

/**
 * Recorder sessions not on the Datasets tab yet. Every session joins it as it is saved; this lists the ones that did not
 * (saved before that, or with nothing labelled then), and lets you add one again after changing its marks. The labelled
 * intervals of a recording become its labelled rows; you choose whether unreviewed ones count and whether everything
 * between the intervals is background.
 */
export function RecorderRecordings({ desktopAvailable, labels, datasets, onAdded }: Props) {
  const uid = useId();
  const [recordings, setRecordings] = useState<RecordingBundleSummary[]>([]);
  const [filter, setFilter] = useState<IntervalFilter>("notExcluded");
  const [restLabel, setRestLabel] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!desktopAvailable) return;
    const result = await listRecordingBundles();
    if (result.status === "ok") setRecordings(Array.isArray(result.value) ? result.value : []);
    else setError(result.message);
  }, [desktopAvailable]);
  useEffect(() => {
    void load();
    return onRecordingsChanged(() => void load());
  }, [load]);

  const backgrounds = labels.filter((label) => label.archivedAt === null && label.role === "negativeBackground");
  const addedCount = (id: string) => datasets.filter((dataset) => dataset.sourceRecordingId === id).length;
  const listed = showAll ? recordings : recordings.filter((summary) => addedCount(summary.recordingId) === 0);

  const add = async (summary: RecordingBundleSummary) => {
    setBusy(summary.recordingId);
    setError(null);
    try {
      const made = await invoke<DatasetSummary>("add_recording_to_training_data", { recordingId: summary.recordingId, filter, restLabel: restLabel || null });
      OperationFeedback.success("Add recording", `Added ${made.rowCount.toLocaleString()} labelled rows (${(made.labels ?? []).join(", ")}) to the training data.`);
      onAdded();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card id="lab-recorder" role="region" aria-label="Recordings from the Recorder" className="min-w-0">
      <CardHeader>
        <SectionHeader
          title="From the Recorder"
          description="Every Recorder session joins Datasets as it is saved. Here are the ones that have not, to add by hand."
          help={{
            label: "About adding recordings from the Recorder",
            content: "A session joins Datasets by itself when it is saved, unless nothing in it was labelled then. This lists the sessions not in Datasets: those saved before sessions joined by themselves, and those that could not. Show all of them to add one again after you changed its marks (it is added as a new recording beside the old one). Each labelled interval of a recording (marked by hand, or by the camera and then reviewed) becomes labelled rows. Choose whether intervals you have not reviewed yet count. Rows between intervals are normally left out; choose a background label to give them that label instead, which teaches the model what is not the gesture. Do that only if the gesture really did not happen in those stretches. Adding the same, unchanged recording twice is refused.",
          }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="field">
            <div className="field-head"><Label htmlFor={`${uid}-filter`}>Intervals to use</Label></div>
            <select id={`${uid}-filter`} className="recipe-select" value={filter} onChange={(event) => setFilter(event.target.value as IntervalFilter)}>
              <option value="notExcluded">Approved and not yet reviewed</option>
              <option value="approvedOnly">Approved only</option>
            </select>
          </div>
          <div className="field">
            <div className="field-head"><Label htmlFor={`${uid}-rest`}>Label everything else as</Label></div>
            <select id={`${uid}-rest`} className="recipe-select" value={restLabel} onChange={(event) => setRestLabel(event.target.value)}>
              <option value="">Leave it out</option>
              {backgrounds.map((label) => <option key={label.id} value={label.id}>{label.displayName}</option>)}
            </select>
            <p className="field-hint">{backgrounds.length === 0 ? "Add a label that is an everyday activity on the Labels tab to use this." : "Only if the gesture did not happen between the intervals."}</p>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} />
          Also those already in Datasets ({recordings.filter((summary) => addedCount(summary.recordingId) > 0).length})
        </label>
        {listed.length === 0 ? (
          <p className="hint">{recordings.length === 0 ? "No recordings from the Recorder yet." : "Every Recorder session is in Datasets."}</p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Recorder recordings">
            {listed.map((summary) => {
              const usable = eligibleIntervals(summary, filter);
              const added = addedCount(summary.recordingId);
              return (
                <li key={summary.recordingId} className="recipe-item">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-sm">{recordingTag(summary) ? <strong className="mr-2 font-mono">{recordingTag(summary)}</strong> : null}{summary.recordingId.slice(0, 8)} · {(summary.actualDurationMs / 1000).toFixed(0)} s {added > 0 && <Badge variant="outline">Added{added > 1 ? ` ${added}×` : ""}</Badge>}</span>
                    <small className="text-xs text-muted-foreground">
                      {summary.labelIds.length === 0 ? "No labelled intervals" : summary.labelIds.join(", ")} · {summary.approvedCount} approved, {summary.unreviewedCount} unreviewed, {summary.excludedCount} excluded
                    </small>
                  </div>
                  <div className="recipe-item-actions">
                    <Button type="button" variant="outline" disabled={usable === 0 || busy !== null} title={usable === 0 ? "No intervals match the choice above" : undefined} onClick={() => void add(summary)}>
                      {busy === summary.recordingId ? "Adding…" : "Add to training data"}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
