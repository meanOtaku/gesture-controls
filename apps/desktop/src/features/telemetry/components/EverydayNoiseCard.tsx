import { useMemo, useState, useSyncExternalStore } from "react";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { guidedRunner } from "../recording/guidedRunner";
import { EVERYDAY_NOISE, NOISE_ACTIVITIES, noisePlan, planProblem, planSteps, STILL, totalMs, type GuidedActivity } from "../recording/guidedSession";
import { GuidedRunningView } from "./GuidedRunningView";

const STORAGE_KEY = "recorder.noiseActivities";

/** The standard labels a stretch can be given, by what is shown. */
const KINDS: Record<string, string> = { [EVERYDAY_NOISE]: "Everyday noise", [STILL]: "Hand still" };

function loadActivities(): GuidedActivity[] {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as GuidedActivity[] | null;
    if (Array.isArray(stored)) return stored;
  } catch {
    // A missing or broken list falls back to the usual one.
  }
  return NOISE_ACTIVITIES;
}

function saveActivities(activities: GuidedActivity[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(activities));
  } catch {
    // Remembering is a convenience.
  }
}

const minutes = (ms: number) => `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;

/**
 * Everyday noise: a recording with no gesture in it, only everyday activity (typing, the phone, walking, …) labelled with
 * the standard label `everyday_noise`, and the hand at rest labelled `still`. Added to the training data, it teaches every
 * model what is not its gesture, most of all with "Learn from its own false alarms"; held out, it measures how often a
 * model fires in ordinary use.
 */
export function EverydayNoiseCard({ recording, watchConnected, onStop }: {
  recording: boolean;
  watchConnected: boolean;
  /** Stops the recording and saves it, as the recorder's Stop does. */
  onStop: () => void;
}) {
  const [activities, setActivities] = useState<GuidedActivity[]>(loadActivities);
  const [error, setError] = useState<string | null>(null);
  const session = useSyncExternalStore(guidedRunner.subscribe, guidedRunner.snapshot, guidedRunner.snapshot);

  const update = (next: GuidedActivity[]) => {
    setActivities(next);
    saveActivities(next);
  };
  const plan = useMemo(() => noisePlan(activities), [activities]);
  const problem = planProblem(plan);
  const length = useMemo(() => totalMs(planSteps(plan)), [plan]);

  const start = () => {
    setError(null);
    if (!guidedRunner.start(plan, Math.random, "noise")) setError("Could not start: stop the recording under way first.");
  };

  if (session?.source === "noise") {
    return (
      <GuidedRunningView
        session={session}
        nameOf={(id) => KINDS[id] ?? id}
        onStop={onStop}
        title="Everyday noise session"
        description="Do each activity as you normally would, and make no gesture. The recording stops and is saved by itself at the end."
      />
    );
  }

  const setActivity = (index: number, next: Partial<GuidedActivity>) => update(activities.map((entry, i) => (i === index ? { ...entry, ...next } : entry)));

  return (
    <Card role="region" aria-label="Everyday noise session" className="min-w-0">
      <CardHeader>
        <SectionHeader
          title="Everyday noise"
          description="Record ordinary use of your hand with no gesture, so every model learns what not to fire on."
          help={{
            label: "About everyday noise",
            content:
              "The app asks for one activity after another; you make no gesture at all. Each stretch gets one of the app's standard labels: Everyday noise while you use your hand, Hand still while it rests. Every model treats them as not its gesture, so there is no role to choose. Add the recording to the training data from Model Lab (From the Recorder), and tick Learn from its own false alarms when you train: the model is run over it, every moment it fires is added as an example of what is not the gesture, and it is trained again. Keep some everyday-noise recordings out of training: on those, its false activations an hour are what you would see in daily use. Record a session on each day you record pinches, in different places and positions.",
          }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!watchConnected && <p className="hint">Connect the watch (Watch page) first.</p>}
        <fieldset className="flex flex-col gap-2">
          <legend className="label">Activities, one after another</legend>
          <div className="noise-activity noise-activity-head" aria-hidden="true"><span>Activity</span><span>Seconds</span><span>Label</span><span /></div>
          {activities.map((entry, index) => (
            <div key={index} className="noise-activity">
              <Input aria-label={`Noise activity ${index + 1}`} value={entry.activity} disabled={recording} onChange={(event) => setActivity(index, { activity: event.target.value })} />
              <Input aria-label={`Seconds of noise activity ${index + 1}`} type="number" min={5} max={900} value={entry.seconds} disabled={recording} onChange={(event) => setActivity(index, { seconds: Number(event.target.value) })} />
              <select aria-label={`Label of noise activity ${index + 1}`} className="recipe-select" value={entry.label ?? EVERYDAY_NOISE} disabled={recording} onChange={(event) => setActivity(index, { label: event.target.value })}>
                {Object.entries(KINDS).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
              <Button type="button" variant="ghost" size="sm" disabled={recording} onClick={() => update(activities.filter((_, i) => i !== index))}>Remove</Button>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" disabled={recording} onClick={() => update([...activities, { activity: "Cook, wash up or tidy", seconds: 60, label: EVERYDAY_NOISE }])}>Add an activity</Button>
            <Button type="button" variant="ghost" size="sm" disabled={recording} onClick={() => update(NOISE_ACTIVITIES)}>Back to the usual list</Button>
          </div>
        </fieldset>
        {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" disabled={recording || !watchConnected || problem !== null} onClick={start}>Start everyday noise session</Button>
          <span className="hint">{problem ?? `About ${minutes(length)}.`}{recording && !problem ? " A recording is under way." : ""}</span>
        </div>
      </CardContent>
    </Card>
  );
}
