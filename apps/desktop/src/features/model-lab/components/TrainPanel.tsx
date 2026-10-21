import { invoke } from "@tauri-apps/api/core";
import { useEffect, useId, useState } from "react";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Alert, AlertDescription, AlertTitle } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { Checkbox } from "../../../components/ui/checkbox";
import { Label } from "../../../components/ui/label";
import { useTrainingRun } from "../hooks/useTrainingRun";
import { PULSE_MODEL, buildRequest, hasLabel, otherLabels, recordingsWithLabel, type OtherRole, type TrainPlan, type TrainerEnvironment } from "../training";
import { datasetLabels, inImportOrder, recordingNumber, type DatasetLabel, type DatasetSummary } from "../types";
import { LabelTiming } from "./LabelTiming";
import { TrainingRunView } from "./TrainingRunView";

type TrainPanelProps = {
  desktopAvailable: boolean;
  labels: DatasetLabel[];
  datasets: DatasetSummary[];
  /** Opens the Network lab, where the model's pipeline is shown. */
  onOpenNetworkLab?: () => void;
};

const NATIVE_SELECT = "recipe-select";

/**
 * Train a label's model from your recordings. You choose the label, the recordings and what each other label means; the
 * model is always the PPG pinch-start model. The app picks which recordings train and which test (never the same one) and
 * shows you that before anything runs. The result is a Draft you review before it can do anything.
 */
export function TrainPanel({ desktopAvailable, labels, datasets, onOpenNetworkLab }: TrainPanelProps) {
  const uid = useId();
  const run = useTrainingRun(desktopAvailable);
  const running = run.running;
  const [target, setTarget] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [roles, setRoles] = useState<Record<string, OtherRole>>({});
  const [research, setResearch] = useState(false);
  const [labelOffset, setLabelOffset] = useState(0);
  const [plan, setPlan] = useState<TrainPlan | null>(null);
  const [environment, setEnvironment] = useState<TrainerEnvironment | null>(null);
  const [error, setError] = useState<string | null>(null);

  const usable = labels.filter((label) => label.archivedAt === null);
  const candidates = inImportOrder(datasets.filter((dataset) => datasetLabels(dataset).length > 0));
  const others = otherLabels(datasets, selected, target);
  const request = target === "" ? null : buildRequest({ label: target, datasetIds: [...selected], others, roles, research, labelOffsetMs: labelOffset });
  const requestKey = JSON.stringify(request);

  useEffect(() => {
    if (!desktopAvailable) return;
    void invoke<TrainerEnvironment>("check_label_trainer").then(setEnvironment).catch(() => undefined);
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
      .catch((err) => { if (!stale) setPlan({ train: [], evaluation: [], problem: String(err), inputs: PULSE_MODEL.inputs }); });
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

  const chooseTarget = (label: string) => {
    setTarget(label);
    run.clearResult();
    // Start from every recording, so what to leave out is a decision rather than something to remember.
    setSelected(new Set(candidates.map((dataset) => dataset.id)));
  };

  const start = async () => {
    if (request === null) return;
    setError(null);
    run.reset();
    try {
      await invoke<string>("start_label_training", { request });
    } catch (err) {
      setError(String(err));
    }
  };

  const canStart = desktopAvailable && request !== null && plan !== null && plan.problem === null && running === null && environment?.available !== false;
  const name = (id: string) => datasets.find((dataset) => dataset.id === id)?.originalFilename ?? id;

  return (
    <Card id="lab-train" role="region" aria-label="Train a model" className="min-w-0">
      <CardHeader>
        <SectionHeader
          title="Train a model"
          description="Teach the app a label from your recordings."
          help={{
            label: "About training",
            content: "You choose the label, the recordings and what each other label means. The app decides which recordings train and which test, never the same one, so the score is about recordings the model has not seen. The result is a Draft: it does nothing until you approve and activate it. A model that does not pass the checks for going live can still be activated, but it only runs in Monitor. Training runs on this computer and needs uv; running a model does not.",
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

        <section aria-label="The model" className="rounded-md border p-3 text-sm">
          <p><strong>{PULSE_MODEL.name}</strong> <Badge variant="secondary">pulse sensor and motion</Badge></p>
          <p className="field-hint">{PULSE_MODEL.summary}</p>
          <p className="field-hint">
            In the research (37 recordings, 20 tests on recordings it never saw) it scored a worst-case AUC of {PULSE_MODEL.research.worstAuc} and caught about {Math.round(PULSE_MODEL.research.recall * 100)}% of gesture starts, with about {PULSE_MODEL.research.falsePerMinute.toFixed(1)} false alarms a minute.{" "}
            {onOpenNetworkLab ? <Button type="button" variant="link" className="h-auto p-0" onClick={onOpenNetworkLab}>See its pipeline in the Network lab</Button> : null}
          </p>
        </section>

        <div className="field">
          <div className="field-head"><Label htmlFor={`${uid}-label`} required>Label to teach</Label></div>
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
                      <span>{dataset.sequence ? <strong className="mr-2 font-mono">{recordingNumber(dataset)}</strong> : null}{dataset.originalFilename}</span>
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
                <p className="field-hint">“Something else” teaches the model what is not the gesture: their starts are the hardest thing for it to tell apart. “Leave out” ignores that part of the recordings. Nothing is assumed: each label here has a role.</p>
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

            <LabelTiming request={request} offset={labelOffset} onOffset={setLabelOffset} disabled={running !== null} />

            {plan && (
              <div role="status" aria-label="Training plan">
                {plan.problem ? (
                  <Alert variant="destructive"><AlertDescription>{plan.problem}</AlertDescription></Alert>
                ) : (
                  <>
                    <p className="field-hint">
                      It will train on {plan.train.length} recording{plan.train.length === 1 ? "" : "s"} ({plan.train.map(name).join(", ")}) and test on {plan.evaluation.length} it never trains on ({plan.evaluation.map(name).join(", ")}).
                    </p>
                    {recordingsWithLabel(datasets, plan.train, target) < 2 && (
                      <Alert role="note">
                        <AlertDescription>
                          Only {recordingsWithLabel(datasets, plan.train, target)} recording with {target} to train on. A model trained on a single session usually memorises it and fails on the next. Three or more recordings, in different positions, work much better.
                        </AlertDescription>
                      </Alert>
                    )}
                  </>
                )}
              </div>
            )}

            <div className="flex items-start gap-2 text-sm">
              <Checkbox checked={research} disabled={running !== null} onCheckedChange={() => setResearch((value) => !value)} aria-label="Also run research checks" />
              <span><strong>Also run research checks</strong> <small className="text-muted-foreground">After training, retrain the same model on a quarter, half and three quarters of the data, and on all but one recording at a time, to see how far its score can be trusted. It takes several times longer, and the results are in the model&apos;s Inspect view.</small></span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {running === null && <Button type="button" disabled={!canStart} onClick={() => void start()}>Train model</Button>}
            </div>
          </>
        )}

        <TrainingRunView run={run} />
      </CardContent>
    </Card>
  );
}
