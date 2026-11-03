import { useMemo, useState, useSyncExternalStore } from "react";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { RadioGroup, RadioGroupItem } from "../../../components/ui/radio-group";
import { guidedRunner } from "../recording/guidedRunner";
import { NOISE_KINDS, NOISE_MAX_MINUTES, NOISE_MIN_MINUTES, noiseActivity, noiseRoutinePlan, planProblem, type NoiseKind, type SupportAngle } from "../recording/guidedSession";
import { telemetryStore } from "../store/telemetryStore";
import { GuidedRunningView } from "./GuidedRunningView";

const STORAGE_KEY = "recorder.noiseSession";

interface NoiseSettings {
  kind: NoiseKind;
  angle: SupportAngle;
  /** The minutes typed for each kind. */
  minutes: Record<NoiseKind, string>;
}

const DEFAULTS: NoiseSettings = {
  kind: "active",
  angle: "flat",
  minutes: { active: String(NOISE_KINDS.active.minutes), still: String(NOISE_KINDS.still.minutes), supported: String(NOISE_KINDS.supported.minutes) },
};

function loadSettings(): NoiseSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<NoiseSettings> | null;
    if (stored && typeof stored === "object") {
      return {
        kind: stored.kind && stored.kind in NOISE_KINDS ? stored.kind : DEFAULTS.kind,
        angle: stored.angle === "angled" ? "angled" : "flat",
        minutes: { ...DEFAULTS.minutes, ...(stored.minutes ?? {}) },
      };
    }
  } catch {
    // A missing or broken setting falls back to the default.
  }
  return DEFAULTS;
}

function saveSettings(settings: NoiseSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Remembering is a convenience.
  }
}

/**
 * Everyday noise: a few minutes with no gesture, of one of three kinds, each its own standard label: active (your normal
 * routine, `everyday_noise`), still (the hand held as still as you can, `still`) or on a support (resting on a desk,
 * armrest or lap, flat or angled, `supported`). The whole recording gets the label, so there is nothing to mark: every model
 * treats it as not its gesture. Added to the training data, it teaches a model what not to fire on, most of all with "Learn
 * from its own false alarms"; held out, it measures how often a model fires in ordinary use.
 */
export function EverydayNoiseCard({ recording, watchConnected, onStop }: {
  recording: boolean;
  watchConnected: boolean;
  /** Stops the recording and saves it, as the recorder's Stop does. */
  onStop: () => void;
}) {
  const [settings, setSettings] = useState<NoiseSettings>(loadSettings);
  const [error, setError] = useState<string | null>(null);
  const session = useSyncExternalStore(guidedRunner.subscribe, guidedRunner.snapshot, guidedRunner.snapshot);
  const { kind, angle } = settings;
  const minutesText = settings.minutes[kind];
  const minutes = Number(minutesText);
  const plan = useMemo(() => noiseRoutinePlan(minutes, kind, angle), [minutes, kind, angle]);
  const problem = Number.isFinite(minutes) && minutes >= NOISE_MIN_MINUTES ? planProblem(plan) : `Record ${NOISE_MIN_MINUTES} to ${NOISE_MAX_MINUTES} minutes.`;

  const update = (next: Partial<NoiseSettings>) => {
    const merged = { ...settings, ...next };
    setSettings(merged);
    saveSettings(merged);
  };

  const start = () => {
    setError(null);
    // What it was goes with this recording's session details ("Doing"), so flat and angled can be told apart later. A
    // recording keeps the details it started with, so yours are put back at once for the next one.
    const before = telemetryStore.getSessionContext();
    telemetryStore.setSessionContext({ ...before, activity: noiseActivity(kind, angle) });
    const started = guidedRunner.start(plan, Math.random, "noise");
    telemetryStore.setSessionContext(before);
    if (!started) setError("Could not start: stop the recording under way first.");
  };

  if (session?.source === "noise") {
    return (
      <GuidedRunningView
        session={session}
        nameOf={() => "Everyday noise"}
        onStop={onStop}
        title="Everyday noise session"
        description="Make no gesture. The recording stops and is saved by itself at the end; Stop and save keeps what you have so far."
      />
    );
  }

  return (
    <Card role="region" aria-label="Everyday noise session" className="min-w-0">
      <CardHeader>
        <SectionHeader
          title="Everyday noise"
          description="Record a few minutes with no gesture, so every model learns what not to fire on."
          help={{
            label: "About everyday noise",
            content:
              "Wear the watch and make no gesture, for a few minutes of one kind: Active (your normal routine), Still (the hand held as still as you can) or On a support (resting on a desk, an armrest or your lap, flat or angled). There is nothing to label: the whole recording gets the kind's standard label (Everyday noise, Hand still or Hand on a support), which every model treats as not its gesture, and its session details say which kind it was. Add it to the training data from Model Lab (From the Recorder) and tick Learn from its own false alarms when you train. Keep some of these recordings out of training: on those, its false activations an hour are what you would see in daily use. Record each kind on each day you record pinches, in different places and positions.",
          }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!watchConnected && <p className="hint">Connect the watch (Watch page) first.</p>}
        <div className="flex flex-col gap-2">
          <span className="label">Type</span>
          <RadioGroup value={kind} onValueChange={(value) => update({ kind: value as NoiseKind })} className="flex flex-col gap-2" aria-label="Type of everyday noise">
            {(Object.keys(NOISE_KINDS) as NoiseKind[]).map((option) => (
              <label key={option} className="flex items-center gap-2 text-sm">
                <RadioGroupItem value={option} disabled={recording} /> {NOISE_KINDS[option].title}
              </label>
            ))}
          </RadioGroup>
        </div>
        {kind === "supported" && (
          <div className="flex flex-col gap-2">
            <span className="label">The hand on its support</span>
            <RadioGroup value={angle} onValueChange={(value) => update({ angle: value as SupportAngle })} className="flex flex-wrap gap-4" aria-label="Angle of the hand on its support">
              <label className="flex items-center gap-2 text-sm"><RadioGroupItem value="flat" disabled={recording} /> Flat</label>
              <label className="flex items-center gap-2 text-sm"><RadioGroupItem value="angled" disabled={recording} /> Angled</label>
            </RadioGroup>
          </div>
        )}
        <div className="field max-w-48">
          <Label htmlFor="noise-minutes">Minutes</Label>
          <Input
            id="noise-minutes"
            type="number"
            min={NOISE_MIN_MINUTES}
            max={NOISE_MAX_MINUTES}
            value={minutesText}
            disabled={recording}
            onChange={(event) => update({ minutes: { ...settings.minutes, [kind]: event.target.value } })}
          />
        </div>
        <p className="hint">Make no gesture. For example: {NOISE_KINDS[kind].suggestions}.</p>
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
