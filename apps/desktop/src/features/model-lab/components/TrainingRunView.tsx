import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import type { useTrainingRun } from "../hooks/useTrainingRun";
import { describeEvents, describeMetrics, thresholdNote, type EventMetrics, type TrainingMetrics } from "../training";
import { ConfusionMatrices } from "./ConfusionMatrices";

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
                {result.gestures && result.gestures.length > 1 && (
                  <>
                    <p>One network learnt {result.gestures.map((g) => g.label).join(", ")}. {result.gestures.map((g) => `${g.label}: ${g.outcome === "deployable" ? "added as a draft" : g.outcome === "monitorOnly" ? "added as a draft that can only run in Monitor" : `not added (${g.message})`}`).join("; ")}. The numbers above are {result.label}&apos;s; each model&apos;s are in its Inspect view.</p>
                    {result.confusion && <ConfusionMatrices confusion={result.confusion} />}
                  </>
                )}
                {result.metrics.startedFrom?.events && result.metrics.events && <StartComparison before={result.metrics.startedFrom} after={result.metrics.events} threshold={result.metrics.activationThreshold} />}
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

/** A continued model next to the one it began from, on the same held-out recordings, each at its own cut-off. */
function StartComparison({ before, after, threshold }: { before: NonNullable<TrainingMetrics["startedFrom"]>; after: EventMetrics; threshold: number }) {
  const events = before.events!;
  const caught = (e: EventMetrics) => (e.gestures > 0 ? `${e.caught} of ${e.gestures}` : "none to catch");
  const alarms = (e: EventMetrics) => `${e.falseActivations}${e.falseActivationsPerHour !== null ? ` (about ${Math.round(e.falseActivationsPerHour)} an hour)` : ""}`;
  const delay = (e: EventMetrics) => (e.medianLatencyMs !== null ? `${Math.round(e.medianLatencyMs)} ms` : "–");
  return (
    <table className="coverage-grid" aria-label={`The new model and ${before.name} on the same test recordings`}>
      <thead>
        <tr><th>Same test recordings</th><th>{before.name}</th><th>New model</th></tr>
      </thead>
      <tbody>
        <tr><th>Gestures caught</th><td>{caught(events)}</td><td>{caught(after)}</td></tr>
        <tr><th>False alarms</th><td>{alarms(events)}</td><td>{alarms(after)}</td></tr>
        <tr><th>Typical delay</th><td>{delay(events)}</td><td>{delay(after)}</td></tr>
        <tr><th>Cut-off</th><td>{before.threshold}</td><td>{threshold}</td></tr>
      </tbody>
    </table>
  );
}
