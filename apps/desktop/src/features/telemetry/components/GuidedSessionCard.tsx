import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import type { DatasetLabel } from "../../model-lab/types";
import { guidedRunner } from "../recording/guidedRunner";
import { loadPlan, planProblem, planSteps, prompt, savePlan, totalMs, type GuidedPlan } from "../recording/guidedSession";

const minutes = (ms: number) => `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;

type GuidedSessionCardProps = {
  /** Another recording is under way: a guided session cannot start. */
  recording: boolean;
  /** Stops the recording and saves it, as the recorder's Stop does. */
  onStop: () => void;
};

/**
 * A guided session: the app cues the gesture at random moments, on screen and with a buzz on the watch, and labels it as
 * it cues; then it asks for some everyday activity, labelled as not the gesture. No key to hold, and the labels all start
 * the same way.
 */
export function GuidedSessionCard({ recording, onStop }: GuidedSessionCardProps) {
  const [plan, setPlan] = useState<GuidedPlan>(loadPlan);
  const [labels, setLabels] = useState<DatasetLabel[]>([]);
  const [error, setError] = useState<string | null>(null);
  const session = useSyncExternalStore(guidedRunner.subscribe, guidedRunner.snapshot, guidedRunner.snapshot);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    invoke<DatasetLabel[]>("list_model_labels")
      .then((all) => setLabels((Array.isArray(all) ? all : []).filter((label) => label.archivedAt === null)))
      .catch(() => setLabels([]));
  }, []);

  const update = (next: Partial<GuidedPlan>) => {
    const merged = { ...plan, ...next };
    setPlan(merged);
    savePlan(merged);
  };
  const gestures = labels.filter((label) => label.role === "positiveGesture");
  const everyday = labels.filter((label) => label.role === "negativeBackground");
  const nameOf = (id: string) => labels.find((label) => label.id === id)?.displayName || id.replaceAll("_", " ");
  const problem = planProblem(plan);
  // Only the length matters before the session starts; the rests are drawn again when it does.
  const length = useMemo(() => totalMs(planSteps(plan, () => 0.5)), [plan]);

  const start = () => {
    setError(null);
    if (!guidedRunner.start(plan)) setError("Could not start: stop the recording under way first.");
  };

  if (session) {
    const elapsed = session.elapsedMs;
    const shown = elapsed === null ? { title: "Waiting for the watch…", detail: "The session starts with the first sample.", tone: "rest" as const } : prompt(session.steps, elapsed, nameOf);
    const total = totalMs(session.steps);
    return (
      <Card role="region" aria-label="Guided session" className="min-w-0">
        <CardHeader>
          <CardTitle>Guided session</CardTitle>
          <CardDescription>Follow the prompts. The recording stops and is saved by itself at the end.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className={`guided-prompt guided-${shown.tone}`} role="status" aria-live="assertive">
            <strong>{shown.title}</strong>
            <span>{shown.detail}</span>
          </div>
          <div className="guided-progress" aria-label="Session progress">
            <div style={{ width: `${Math.min(100, ((elapsed ?? 0) / total) * 100)}%` }} />
          </div>
          <p className="hint">
            {elapsed === null ? minutes(total) : `${minutes(Math.max(0, total - elapsed))} left`}
            {session.buzzFailed ? ". The watch could not be buzzed: follow the screen." : ""}
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => { guidedRunner.stop(); onStop(); }}>Stop and save</Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const activities = plan.activities;
  const setActivity = (index: number, next: Partial<GuidedPlan["activities"][number]>) =>
    update({ activities: activities.map((entry, i) => (i === index ? { ...entry, ...next } : entry)) });

  return (
    <Card role="region" aria-label="Guided session" className="min-w-0">
      <CardHeader>
        <CardTitle>Guided session</CardTitle>
        <CardDescription>
          The app tells you when to make the gesture, on screen and with a buzz on the watch, and labels it as it tells you,
          at random moments so you cannot anticipate them. Then it asks for some everyday activity, labelled as not the
          gesture. Each label starts at the cue, about your reaction time before the gesture: Label timing on the Labelling
          page measures that and moves them.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="field">
            <Label htmlFor="guided-label" required>Gesture</Label>
            <select id="guided-label" className="recipe-select" value={plan.label} disabled={recording} onChange={(event) => update({ label: event.target.value })}>
              <option value="">Choose…</option>
              {gestures.map((label) => <option key={label.id} value={label.id}>{label.displayName}</option>)}
            </select>
          </div>
          <div className="field">
            <Label htmlFor="guided-cues">How many times</Label>
            <Input id="guided-cues" type="number" min={1} max={500} value={plan.cues} disabled={recording} onChange={(event) => update({ cues: Math.round(Number(event.target.value)) })} />
          </div>
          <div className="field">
            <Label htmlFor="guided-hold">Hold each (s)</Label>
            <Input id="guided-hold" type="number" min={0.1} max={5} step={0.1} value={plan.holdMs / 1000} disabled={recording} onChange={(event) => update({ holdMs: Math.round(Number(event.target.value) * 1000) })} />
          </div>
          <div className="field">
            <Label htmlFor="guided-min-gap">Rest at least (s)</Label>
            <Input id="guided-min-gap" type="number" min={1} max={60} value={plan.minGapSeconds} disabled={recording} onChange={(event) => update({ minGapSeconds: Number(event.target.value) })} />
          </div>
          <div className="field">
            <Label htmlFor="guided-max-gap">Rest at most (s)</Label>
            <Input id="guided-max-gap" type="number" min={1} max={60} value={plan.maxGapSeconds} disabled={recording} onChange={(event) => update({ maxGapSeconds: Number(event.target.value) })} />
          </div>
          <div className="field">
            <Label htmlFor="guided-everyday">Everyday label</Label>
            <select id="guided-everyday" className="recipe-select" value={plan.everydayLabel ?? ""} disabled={recording} onChange={(event) => update({ everydayLabel: event.target.value || null })}>
              <option value="">None (leave unlabelled)</option>
              {everyday.map((label) => <option key={label.id} value={label.id}>{label.displayName}</option>)}
            </select>
            {everyday.length === 0 && <p className="field-hint">Add a label with the everyday-activity role on the Labels tab.</p>}
          </div>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="label">Everyday activity, after the cues</legend>
          {activities.map((entry, index) => (
            <div key={index} className="flex flex-wrap items-center gap-2">
              <Input aria-label={`Activity ${index + 1}`} className="max-w-sm" value={entry.activity} disabled={recording} onChange={(event) => setActivity(index, { activity: event.target.value })} />
              <Input aria-label={`Seconds of activity ${index + 1}`} className="w-24" type="number" min={5} max={900} value={entry.seconds} disabled={recording} onChange={(event) => setActivity(index, { seconds: Number(event.target.value) })} />
              <span className="hint">s</span>
              <Button type="button" variant="ghost" size="sm" disabled={recording} onClick={() => update({ activities: activities.filter((_, i) => i !== index) })}>Remove</Button>
            </div>
          ))}
          <div>
            <Button type="button" variant="outline" size="sm" disabled={recording} onClick={() => update({ activities: [...activities, { activity: "Walk around", seconds: 60 }] })}>Add an activity</Button>
          </div>
        </fieldset>
        {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" disabled={recording || problem !== null} onClick={start}>Start guided session</Button>
          <span className="hint">{problem ?? `About ${minutes(length)}.`}{recording && !problem ? " A recording is under way." : ""}</span>
        </div>
      </CardContent>
    </Card>
  );
}
