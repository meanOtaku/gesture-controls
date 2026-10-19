import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import type { useTrainingRun } from "../hooks/useTrainingRun";
import { describeEvents, describeMetrics, thresholdNote } from "../training";

/** The progress of a training run: whether it runs (with Cancel), the log and the result. */
export function TrainingRunView({ run }: { run: ReturnType<typeof useTrainingRun> }) {
  const { running, log, result } = run;
  const [error, setError] = useState<string | null>(null);
  const cancel = async () => {
    try {
      await invoke("cancel_label_training");
    } catch (err) {
      setError(String(err));
    }
  };
  return (
    <>
      {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
      {running !== null && (
        <div className="flex flex-wrap items-center gap-2" role="status" aria-label="Training in progress">
          <Badge>Training…</Badge>
          <Button type="button" variant="outline" onClick={() => void cancel()}>Cancel</Button>
        </div>
      )}

      {log.length > 0 && <pre className="model-lab-log" aria-label="Training log">{log.join("\n")}</pre>}

      {result && (
        <Alert variant={result.outcome === "deployable" || result.outcome === "monitorOnly" ? "default" : "destructive"} role="status" aria-label="Training result">
          <AlertTitle>
            {result.outcome === "deployable"
              ? `A model for ${result.label} was added as a draft`
              : result.outcome === "monitorOnly"
                ? `A model for ${result.label} was added as a draft that can only run in Monitor`
                : result.outcome === "cancelled"
                  ? "Training was cancelled"
                  : "Training did not produce a model"}
          </AlertTitle>
          <AlertDescription>
            {(result.outcome === "deployable" || result.outcome === "monitorOnly") && result.metrics ? (
              <>
                {result.outcome === "monitorOnly" && <p>It did not pass the checks for going live: {result.message}. You can still approve and activate it: it will score and show what it detects, but never start a recipe.</p>}
                <p>{describeMetrics(result.metrics)}</p>
                {result.metrics.events && <p>{describeEvents(result.metrics.events)}</p>}
                <p>{thresholdNote(result.metrics)}</p>
                <p>Review it under Label models: mark it evaluated, approve it, then activate it.{result.outcome === "deployable" ? " Check it in Monitor before Live." : ""}</p>
              </>
            ) : (
              <p>{result.message}</p>
            )}
          </AlertDescription>
        </Alert>
      )}
    </>
  );
}
