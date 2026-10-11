import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import type { useTrainingRun } from "../hooks/useTrainingRun";
import { THRESHOLD_CAVEAT, describeMetrics } from "../training";
import { TrainingCurve } from "./TrainingCurve";

/** The progress of a training run: whether it runs (with Cancel), the learning curve, the log and the result. */
export function TrainingRunView({ run }: { run: ReturnType<typeof useTrainingRun> }) {
  const { running, curve, log, result } = run;
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

      <TrainingCurve points={curve} />

      {log.length > 0 && <pre className="model-lab-log" aria-label="Training log">{log.join("\n")}</pre>}

      {result && (
        <Alert variant={result.outcome === "deployable" ? "default" : "destructive"} role="status" aria-label="Training result">
          <AlertTitle>
            {result.outcome === "deployable"
              ? `A model for ${result.label} was added as a draft`
              : result.outcome === "evaluationOnly"
                ? "A model was trained but it is not good enough to keep"
                : result.outcome === "cancelled"
                  ? "Training was cancelled"
                  : "Training did not produce a model"}
          </AlertTitle>
          <AlertDescription>
            {result.outcome === "deployable" && result.metrics ? (
              <>
                <p>{describeMetrics(result.metrics)}</p>
                <p>{THRESHOLD_CAVEAT}</p>
                <p>Review it under Label models: mark it evaluated, approve it, then activate it. Check it in Monitor before Live.</p>
              </>
            ) : result.outcome === "evaluationOnly" ? (
              <>
                <p>{result.message}.</p>
                {result.metrics && <p>Its test score (AUC) was {result.metrics.rocAuc.toFixed(2)}, where 0.5 is chance. Nothing was added to your models.</p>}
                <p>Things to try: pick the data the gesture really changes (the pulse sensor for finger gestures), tick “Only how things change” in the design, or record more sessions of the gesture.</p>
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
