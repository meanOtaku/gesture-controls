import { invoke } from "@tauri-apps/api/core";
import { useState, useSyncExternalStore } from "react";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Card, CardContent } from "../../../components/ui/card";
import { appNavigation } from "../../../shared/navigation/appNavigation";
import { notifyRecordingsChanged } from "../../../shared/tauri/recordingBundle";
import type { DatasetSummary } from "../../model-lab/types";
import { lastRecording } from "../recording/lastRecording";

/**
 * Right after a recording is saved: add it to Model Lab and open it on the Labelling page, to check its labels while the
 * session is fresh in mind. A recording already added is just opened.
 */
export function JustRecordedCard({ recording }: { recording: boolean }) {
  const last = useSyncExternalStore(lastRecording.subscribe, lastRecording.get, lastRecording.get);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!last || recording) return null;

  const review = async () => {
    setBusy(true);
    setError(null);
    try {
      let id: string;
      try {
        const made = await invoke<DatasetSummary>("add_recording_to_training_data", { recordingId: last.recordingId, filter: "notExcluded", restLabel: null });
        id = made.id;
        notifyRecordingsChanged();
      } catch (err) {
        // Already added (or the same data is there already): open what Model Lab has.
        const datasets = await invoke<DatasetSummary[]>("list_model_datasets");
        const existing = datasets.find((dataset) => dataset.sourceRecordingId === last.recordingId);
        if (!existing) throw err;
        id = existing.id;
      }
      appNavigation.openInLabelling({ datasetId: id, atMs: 0 });
      lastRecording.set(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card role="region" aria-label="Just recorded" className="min-w-0">
      <CardContent className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm">
            <strong>Saved:</strong> {last.rowCount.toLocaleString()} rows, {last.intervalCount} labelled stretch{last.intervalCount === 1 ? "" : "es"}. Check its labels now, while you remember the session.
          </span>
          <span className="flex gap-2">
            <Button type="button" onClick={() => void review()} disabled={busy} aria-busy={busy}>{busy ? "Opening…" : "Review it in Labelling"}</Button>
            <Button type="button" variant="ghost" onClick={() => lastRecording.set(null)}>Not now</Button>
          </span>
        </div>
        {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
      </CardContent>
    </Card>
  );
}
