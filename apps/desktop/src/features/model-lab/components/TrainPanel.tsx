import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useId, useState } from "react";
import { OperationFeedback } from "../../../components/app/OperationFeedback";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Alert, AlertDescription, AlertTitle } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { Checkbox } from "../../../components/ui/checkbox";
import { Label } from "../../../components/ui/label";
import {
  DEFAULT_STREAMS,
  LABEL_TRAINING_EVENT,
  METHODS,
  STREAMS,
  appendLog,
  buildRequest,
  describeMetrics,
  hasLabel,
  otherLabels,
  type DataStream,
  type OtherRole,
  type TrainMethod,
  type TrainPlan,
  type TrainerEnvironment,
  type TrainingEvent,
  type TrainingStatus,
} from "../training";
import { datasetLabels, type DatasetLabel, type DatasetSummary } from "../types";

type TrainPanelProps = {
  desktopAvailable: boolean;
  labels: DatasetLabel[];
  datasets: DatasetSummary[];
};

const NATIVE_SELECT = "recipe-select";

/**
 * Train a model for one label from your recordings. You choose the label, the recordings, what each other label means,
 * the method and the data the model may read; the app then picks which recordings train and which test (never the same
 * one) and shows you that before anything runs. The result is a Draft you review before it can do anything.
 */
export function TrainPanel({ desktopAvailable, labels, datasets }: TrainPanelProps) {
  const uid = useId();
  const [target, setTarget] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [roles, setRoles] = useState<Record<string, OtherRole>>({});
  const [method, setMethod] = useState<TrainMethod>("logreg");
  const [sources, setSources] = useState<DataStream[]>(DEFAULT_STREAMS);
  const [plan, setPlan] = useState<TrainPlan | null>(null);
  const [environment, setEnvironment] = useState<TrainerEnvironment | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [result, setResult] = useState<Extract<TrainingEvent, { kind: "finished" }> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const usable = labels.filter((label) => label.archivedAt === null);
  const candidates = datasets.filter((dataset) => datasetLabels(dataset).length > 0);
  const others = otherLabels(datasets, selected, target);
  const request = target === "" ? null : buildRequest({ label: target, datasetIds: [...selected], others, roles, method, sources });
  const requestKey = JSON.stringify(request);

  useEffect(() => {
    if (!desktopAvailable) return;
    void invoke<TrainerEnvironment>("check_label_trainer").then(setEnvironment).catch(() => undefined);
    void invoke<TrainingStatus>("get_label_training_status")
      .then((status) => {
        if (status?.running) setRunning(status.running.runId);
        else if (status?.last?.kind === "finished") setResult(status.last);
      })
      .catch(() => undefined);
  }, [desktopAvailable]);

  useEffect(() => {
    if (!desktopAvailable) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void Promise.resolve(
      listen<TrainingEvent>(LABEL_TRAINING_EVENT, ({ payload }) => {
        if (disposed) return;
        if (payload.kind === "started") {
          setRunning(payload.runId);
          setLog([]);
          setResult(null);
        } else if (payload.kind === "log") {
          setLog((previous) => appendLog(previous, payload.message));
        } else {
          setRunning(null);
          setResult(payload);
          if (payload.outcome === "deployable") OperationFeedback.success("Training", `A model for ${payload.label} was added as a draft.`);
          else if (payload.outcome === "failed") OperationFeedback.error("Training", payload.message);
        }
      }),
    )
      .then((fn) => {
        if (disposed) fn?.();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [desktopAvailable]);

  // What the app would do with this choice, shown before anything runs.
  useEffect(() => {
    if (!desktopAvailable || request === null || selected.size === 0) {
      setPlan(null);
      return;
    }
    let stale = false;
    void invoke<TrainPlan>("plan_label_training", { request })
      .then((next) => { if (!stale) setPlan(next); })
      .catch((err) => { if (!stale) setPlan({ train: [], evaluation: [], problem: String(err) }); });
    return () => { stale = true; };
    // `requestKey` stands for every part of `request`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktopAvailable, requestKey]);

  const toggleRecording = (id: string) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleStream = (stream: DataStream) =>
    setSources((previous) => (previous.includes(stream) ? previous.filter((s) => s !== stream) : [...previous, stream]));

  const chooseTarget = (label: string) => {
    setTarget(label);
    setResult(null);
    // Start from every recording, so what to leave out is a decision rather than something to remember.
    setSelected(new Set(candidates.map((dataset) => dataset.id)));
  };

  const start = async () => {
    if (request === null) return;
    setError(null);
    setResult(null);
    setLog([]);
    try {
      await invoke<string>("start_label_training", { request });
    } catch (err) {
      setError(String(err));
    }
  };

  const cancel = async () => {
    try {
      await invoke("cancel_label_training");
    } catch (err) {
      setError(String(err));
    }
  };

  const canStart = desktopAvailable && request !== null && sources.length > 0 && plan !== null && plan.problem === null && running === null && environment?.available !== false;
  const name = (id: string) => datasets.find((dataset) => dataset.id === id)?.originalFilename ?? id;

  return (
    <Card id="lab-train" role="region" aria-label="Train a model" className="min-w-0">
      <CardHeader>
        <SectionHeader
          title="Train a model"
          description="Teach the app a label from your recordings."
          help={{
            label: "About training",
            content: "You choose the label, the recordings, what each other label means and what the model may read. The app decides which recordings train and which test, never the same one, so the score is about recordings the model has not seen. The result is a Draft: it does nothing until you approve and activate it. Training runs on this computer and needs uv; running a model does not.",
          }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {environment?.available === false && (
          <Alert variant="destructive" role="alert">
            <AlertTitle>Training is not available here</AlertTitle>
            <AlertDescription>{environment.detail}</AlertDescription>
          </Alert>
        )}
        {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}

        {running !== null && (
          <div className="flex flex-wrap items-center gap-2" role="status" aria-label="Training in progress">
            <Badge>Training…</Badge>
            <Button type="button" variant="outline" onClick={() => void cancel()}>Cancel</Button>
          </div>
        )}

        <div className="field">
          <div className="field-head"><Label htmlFor={`${uid}-label`}>Label to teach</Label></div>
          <select id={`${uid}-label`} className={NATIVE_SELECT} value={target} disabled={running !== null} onChange={(event) => chooseTarget(event.target.value)}>
            <option value="">Choose a label…</option>
            {usable.map((label) => <option key={label.id} value={label.id}>{label.displayName}</option>)}
          </select>
          {usable.length === 0 && <p className="field-hint">Add a label first (see Labels below).</p>}
        </div>

        {target !== "" && (
          <>
            <fieldset className="flex flex-col gap-2">
              <legend className="label">Recordings to use</legend>
              {candidates.length === 0 ? (
                <p className="field-hint">No recordings imported yet.</p>
              ) : (
                <ul className="flex flex-col gap-1" aria-label="Recordings to use">
                  {candidates.map((dataset) => (
                    <li key={dataset.id} className="flex items-center gap-2 text-sm">
                      <Checkbox checked={selected.has(dataset.id)} disabled={running !== null} onCheckedChange={() => toggleRecording(dataset.id)} aria-label={`Use ${dataset.originalFilename}`} />
                      <span>{dataset.originalFilename}</span>
                      <small className="text-muted-foreground">{datasetLabels(dataset).join(", ")}</small>
                      {hasLabel(dataset, target) && <Badge variant="secondary">has {target}</Badge>}
                    </li>
                  ))}
                </ul>
              )}
            </fieldset>

            {others.length > 0 && (
              <fieldset className="flex flex-col gap-2">
                <legend className="label">What the other labels mean</legend>
                <p className="field-hint">“Something else” teaches the model what is not the gesture. “Leave out” ignores that part of the recordings. Nothing is assumed: each label here has a role.</p>
                <ul className="flex flex-col gap-2" aria-label="Roles of the other labels">
                  {others.map((other) => (
                    <li key={other} className="flex items-center gap-2 text-sm">
                      <span className="min-w-32"><code>{other}</code></span>
                      <select aria-label={`Role of ${other}`} className={NATIVE_SELECT} value={roles[other] ?? "negative"} disabled={running !== null} onChange={(event) => setRoles((previous) => ({ ...previous, [other]: event.target.value as OtherRole }))}>
                        <option value="negative">Something else (not {target})</option>
                        <option value="exclude">Leave out</option>
                      </select>
                    </li>
                  ))}
                </ul>
              </fieldset>
            )}

            <div className="field">
              <div className="field-head"><Label htmlFor={`${uid}-method`}>Method</Label></div>
              <select id={`${uid}-method`} className={NATIVE_SELECT} value={method} disabled={running !== null} onChange={(event) => setMethod(event.target.value as TrainMethod)}>
                {METHODS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              <p className="field-hint">{METHODS.find((option) => option.value === method)?.summary}</p>
            </div>

            <fieldset className="flex flex-col gap-2">
              <legend className="label">What the model may read</legend>
              <ul className="flex flex-col gap-1" aria-label="Data the model may read">
                {STREAMS.map((stream) => (
                  <li key={stream.value} className="flex items-start gap-2 text-sm">
                    <Checkbox checked={sources.includes(stream.value)} disabled={running !== null} onCheckedChange={() => toggleStream(stream.value)} aria-label={stream.label} />
                    <span><strong>{stream.label}</strong> <small className="text-muted-foreground">{stream.summary}</small></span>
                  </li>
                ))}
              </ul>
              <p className="field-hint">The model only works while the watch sends everything it read. Pick as little as the gesture needs.</p>
            </fieldset>

            {plan && (
              <div role="status" aria-label="Training plan">
                {plan.problem ? (
                  <Alert variant="destructive"><AlertDescription>{plan.problem}</AlertDescription></Alert>
                ) : (
                  <p className="field-hint">
                    It will train on {plan.train.length} recording{plan.train.length === 1 ? "" : "s"} ({plan.train.map(name).join(", ")}) and test on {plan.evaluation.length} it never trains on ({plan.evaluation.map(name).join(", ")}).
                  </p>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              {running === null && <Button type="button" disabled={!canStart} onClick={() => void start()}>Train model</Button>}
              {sources.length === 0 && <span className="field-error">Choose at least one thing for the model to read.</span>}
            </div>
          </>
        )}

        {log.length > 0 && (
          <pre className="model-lab-log" aria-label="Training log">{log.join("\n")}</pre>
        )}

        {result && (
          <Alert variant={result.outcome === "deployable" ? "default" : "destructive"} role="status" aria-label="Training result">
            <AlertTitle>
              {result.outcome === "deployable" ? `A model for ${result.label} was added as a draft` : result.outcome === "cancelled" ? "Training was cancelled" : "Training did not produce a model"}
            </AlertTitle>
            <AlertDescription>
              {result.outcome === "deployable" && result.metrics ? (
                <>
                  <p>{describeMetrics(result.metrics)}</p>
                  <p>Review it under Label models: mark it evaluated, approve it, then activate it. Check it in Monitor before Live.</p>
                </>
              ) : (
                <p>{result.message}</p>
              )}
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
