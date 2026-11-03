import { useMemo, useState, useSyncExternalStore } from "react";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { guidedRunner } from "../recording/guidedRunner";
import { NOISE_MAX_MINUTES, NOISE_MIN_MINUTES, NOISE_SUGGESTIONS, noiseRoutinePlan, planProblem } from "../recording/guidedSession";
import { GuidedRunningView } from "./GuidedRunningView";

const STORAGE_KEY = "recorder.noiseMinutes";
const DEFAULT_MINUTES = 10;

function loadMinutes(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? String(DEFAULT_MINUTES);
  } catch {
    return String(DEFAULT_MINUTES);
  }
}

function saveMinutes(minutes: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, minutes);
  } catch {
    // Remembering is a convenience.
  }
}

/**
 * Everyday noise: a few minutes of your ordinary routine with no gesture. The whole recording gets the app's standard label
 * `everyday_noise`, so there is nothing to label: every model treats it as not its gesture. Added to the training data, it
 * teaches a model what not to fire on, most of all with "Learn from its own false alarms"; held out, it measures how often a
 * model fires in ordinary use.
 */
export function EverydayNoiseCard({ recording, watchConnected, onStop }: {
  recording: boolean;
  watchConnected: boolean;
  /** Stops the recording and saves it, as the recorder's Stop does. */
  onStop: () => void;
}) {
  const [minutesText, setMinutesText] = useState(loadMinutes);
  const [error, setError] = useState<string | null>(null);
  const session = useSyncExternalStore(guidedRunner.subscribe, guidedRunner.snapshot, guidedRunner.snapshot);
  const minutes = Number(minutesText);
  const plan = useMemo(() => noiseRoutinePlan(minutes), [minutes]);
  const problem = Number.isFinite(minutes) && minutes >= NOISE_MIN_MINUTES ? planProblem(plan) : `Record ${NOISE_MIN_MINUTES} to ${NOISE_MAX_MINUTES} minutes.`;

  const start = () => {
    setError(null);
    if (!guidedRunner.start(plan, Math.random, "noise")) setError("Could not start: stop the recording under way first.");
  };

  if (session?.source === "noise") {
    return (
      <GuidedRunningView
        session={session}
        nameOf={() => "Everyday noise"}
        onStop={onStop}
        title="Everyday noise session"
        description="Go about your routine and make no gesture. The recording stops and is saved by itself at the end; Stop and save keeps what you have so far."
      />
    );
  }

  return (
    <Card role="region" aria-label="Everyday noise session" className="min-w-0">
      <CardHeader>
        <SectionHeader
          title="Everyday noise"
          description="Record your ordinary routine with no gesture, so every model learns what not to fire on."
          help={{
            label: "About everyday noise",
            content:
              "Wear the watch and go about your routine for a few minutes, making no gesture. There is nothing to label: the whole recording gets the app's standard label Everyday noise, which every model treats as not its gesture. Add it to the training data from Model Lab (From the Recorder) and tick Learn from its own false alarms when you train: the model is run over it, every moment it fires is added as an example of what is not the gesture, and it is trained again. Keep some of these recordings out of training: on those, its false activations an hour are what you would see in daily use. Record one on each day you record pinches, in different places and positions.",
          }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!watchConnected && <p className="hint">Connect the watch (Watch page) first.</p>}
        <div className="field max-w-48">
          <Label htmlFor="noise-minutes">Minutes</Label>
          <Input
            id="noise-minutes"
            type="number"
            min={NOISE_MIN_MINUTES}
            max={NOISE_MAX_MINUTES}
            value={minutesText}
            disabled={recording}
            onChange={(event) => {
              setMinutesText(event.target.value);
              saveMinutes(event.target.value);
            }}
          />
        </div>
        <p className="hint">Make no gesture. For example: {NOISE_SUGGESTIONS.join("; ")}.</p>
        {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" disabled={recording || !watchConnected || problem !== null} onClick={start}>Start everyday noise session</Button>
          {problem && <span className="hint">{problem}</span>}
          {recording && !problem && <span className="hint">A recording is under way.</span>}
        </div>
      </CardContent>
    </Card>
  );
}
