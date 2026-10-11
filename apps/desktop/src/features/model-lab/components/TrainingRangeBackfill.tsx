import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";

/** What happened to one model (see `BackfillResult` in range_backfill.rs). */
export interface BackfillResult {
  modelId: string;
  outcome: "added" | "none" | "skipped" | "failed";
  message: string;
}

const OUTCOME_TEXT: Record<BackfillResult["outcome"], string> = { added: "Done", none: "Nothing to record", skipped: "Left as it was", failed: "Failed" };

/**
 * Models trained before the app recorded what each input usually looks like cannot be watched for values they were never
 * trained on. This offers to work that out from the recordings each was trained on (checked to be exactly what they were),
 * without touching the model itself, and says what happened to each.
 */
export function TrainingRangeBackfill({ desktopAvailable, refreshKey }: { desktopAvailable: boolean; /** Changes when the models do. */ refreshKey: string }) {
  const [missing, setMissing] = useState<string[]>([]);
  const [working, setWorking] = useState(false);
  const [results, setResults] = useState<BackfillResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const look = useCallback(async () => {
    try {
      const list = await invoke<string[]>("list_models_without_range");
      setMissing(Array.isArray(list) ? list : []);
    } catch {
      setMissing([]);
    }
  }, []);
  useEffect(() => {
    if (desktopAvailable) void look();
  }, [desktopAvailable, refreshKey, look]);

  const work = async () => {
    setWorking(true);
    setError(null);
    try {
      const done = await invoke<BackfillResult[]>("backfill_model_ranges");
      setResults(Array.isArray(done) ? done : []);
      await look();
    } catch (err) {
      setError(String(err));
    } finally {
      setWorking(false);
    }
  };

  if (missing.length === 0 && results === null) return null;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-input p-3" role="group" aria-label="Training ranges of older models">
      {missing.length > 0 && (
        <>
          <p className="text-sm">
            <strong>{missing.length} trained model{missing.length === 1 ? "" : "s"} {missing.length === 1 ? "has" : "have"} no recorded training range</strong>, so the alert for values a model was never trained on cannot watch {missing.length === 1 ? "it" : "them"}.
            The range can be worked out from the recordings each model was trained on. The model itself is not changed.
          </p>
          <div><Button type="button" variant="outline" disabled={working} onClick={() => void work()}>{working ? "Working it out…" : "Work out their ranges"}</Button></div>
        </>
      )}
      {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
      {results !== null && results.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm" aria-label="Results">
          {results.map((result) => <li key={result.modelId}><code>{result.modelId}</code>: {OUTCOME_TEXT[result.outcome]}. <span className="text-muted-foreground">{result.message}</span></li>)}
        </ul>
      )}
    </div>
  );
}
