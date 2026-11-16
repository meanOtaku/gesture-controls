import { invoke } from "@tauri-apps/api/core";
import { AnimatedText } from "../../../components/app/AnimatedNumber";
import { CheckCircle2, Circle } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { getCameraController } from "../../camera/cameraService";
import { cameraAssist } from "../../gestureLibrary/cameraAssist";
import { definitionsForLabels, type GestureDefinition } from "../../gestureLibrary/definition";
import { listGestureDefinitions } from "../../gestureLibrary/gestureLibraryApi";
import { PINCH_HOLD, PINCH_IN, PINCH_LABELS, PINCH_OUT } from "../../gestureLibrary/pinchEdgeMarker";
import { GestureMultiSelect } from "../../model-lab/components/GestureMultiSelect";
import type { DatasetLabel } from "../../model-lab/types";
import { guidedRunner } from "../recording/guidedRunner";
import { planProblem, planSteps, totalMs, type GuidedPlan } from "../recording/guidedSession";
import { telemetryStore } from "../store/telemetryStore";
import { GuidedRunningView } from "./GuidedRunningView";

/** Pinch in, hold and out as one choice: one cue ("Pinch"), the camera marking where the fingers meet and part. */
export const PINCH = "pinch";

/** What the person can change about a gesture session; the rest of the plan is fixed. */
export interface GestureSessionSettings {
  /** What to cue: label ids, and `PINCH` for pinch in / hold / out. */
  gestures: string[];
  /** How many times each gesture is cued. */
  each: number;
  holdSeconds: number;
  minRestSeconds: number;
  maxRestSeconds: number;
}

export const DEFAULT_SESSION_SETTINGS: GestureSessionSettings = { gestures: [PINCH], each: 20, holdSeconds: 1, minRestSeconds: 4, maxRestSeconds: 8 };
const STORAGE_KEY = "recorder.gestureSession";
const OLD_PINCH_KEY = "recorder.pinchSession";

function loadSettings(): GestureSessionSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<GestureSessionSettings> | null;
    if (stored && typeof stored === "object") {
      return { ...DEFAULT_SESSION_SETTINGS, ...stored, gestures: Array.isArray(stored.gestures) ? stored.gestures.filter((g) => typeof g === "string") : DEFAULT_SESSION_SETTINGS.gestures };
    }
    // The pinch session's settings, from before sessions took any gesture.
    const pinch = JSON.parse(localStorage.getItem(OLD_PINCH_KEY) ?? "null") as { pinches?: number; holdSeconds?: number; minRestSeconds?: number; maxRestSeconds?: number } | null;
    if (pinch && typeof pinch === "object") {
      return { ...DEFAULT_SESSION_SETTINGS, ...(pinch.pinches ? { each: pinch.pinches } : {}), ...(pinch.holdSeconds ? { holdSeconds: pinch.holdSeconds } : {}),
        ...(pinch.minRestSeconds ? { minRestSeconds: pinch.minRestSeconds } : {}), ...(pinch.maxRestSeconds ? { maxRestSeconds: pinch.maxRestSeconds } : {}) };
    }
  } catch {
    // A missing or broken setting falls back to the default.
  }
  return DEFAULT_SESSION_SETTINGS;
}

function saveSettings(settings: GestureSessionSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Remembering is a convenience.
  }
}

/** The label a choice is cued (and recorded) as: pinch in for `PINCH`, the label itself otherwise. */
const cueLabel = (gesture: string) => (gesture === PINCH ? PINCH_IN : gesture);

/** How each chosen gesture gets its labels: the camera's finger distance (pinch), its library gesture, or the cue. */
export type Marking = "pinch" | "camera" | "cue";

export function markingOf(gesture: string, definitions: GestureDefinition[], cameraMarks: boolean): Marking {
  if (gesture === PINCH) return "pinch";
  return cameraMarks && definitionsForLabels(definitions, [gesture]).length > 0 ? "camera" : "cue";
}

/**
 * The guided plan for a gesture session: each gesture cued `each` times, shuffled, with a buzz, a hold and a still rest
 * between. Pinch is cued "Pinch" and, like any gesture the camera marks, labelled by the camera; the session labels the
 * others itself, from the cue to the end of the hold.
 */
export function sessionPlan(settings: GestureSessionSettings, marking: Record<string, Marking>, nameOf: (label: string) => string = (l) => l): GuidedPlan {
  const labels = settings.gestures.map(cueLabel);
  return {
    label: labels[0] ?? "",
    labels,
    cues: settings.each,
    holdMs: Math.round(settings.holdSeconds * 1000),
    minGapSeconds: settings.minRestSeconds,
    maxGapSeconds: settings.maxRestSeconds,
    everydayLabel: null,
    activities: [],
    cueLabelled: settings.gestures.filter((g) => marking[g] === "cue").map(cueLabel),
    cueTexts: Object.fromEntries(settings.gestures.map((g) => [cueLabel(g), g === PINCH ? "Pinch" : `${nameOf(g)} now`])),
  };
}

const minutes = (ms: number) => `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;

type Check = { id: string; done: boolean; text: string; fix?: { label: string; run: () => void | Promise<void> } };

/**
 * Records one or more of your gestures in one guided session: checks the watch and, when a gesture needs it, the labels and
 * the camera (each with a fix), then cues each gesture in a shuffled order. Pinch in / hold / out is marked by the camera
 * where the fingers meet and part; a gesture with a camera rule in the Gesture library is marked by the camera; any other
 * is labelled at the cue (it trails the gesture by your reaction time, which Labelling's label timing removes).
 */
export function GestureSessionCard({ recording, watchConnected, desktopAvailable, onStop }: {
  recording: boolean;
  watchConnected: boolean;
  desktopAvailable: boolean;
  /** Stops the recording and saves it, as the recorder's Stop does. */
  onStop: () => void;
}) {
  const [settings, setSettings] = useState<GestureSessionSettings>(loadSettings);
  const [labels, setLabels] = useState<DatasetLabel[] | null>(null);
  const [definitions, setDefinitions] = useState<GestureDefinition[]>([]);
  const [error, setError] = useState<string | null>(null);
  const session = useSyncExternalStore(guidedRunner.subscribe, guidedRunner.snapshot, guidedRunner.snapshot);
  const camera = getCameraController();
  const cam = useSyncExternalStore(camera.subscribe, camera.getSnapshot, camera.getSnapshot);
  const { enabled: markingOn } = useSyncExternalStore(cameraAssist.subscribe, cameraAssist.getSnapshot, cameraAssist.getSnapshot);

  const loadLabels = useCallback(() => {
    if (!desktopAvailable) return;
    invoke<DatasetLabel[]>("list_model_labels")
      .then((all) => setLabels(Array.isArray(all) ? all : []))
      .catch(() => setLabels([]));
    void listGestureDefinitions().then((found) => setDefinitions(found ?? [])).catch(() => setDefinitions([]));
  }, [desktopAvailable]);
  useEffect(loadLabels, [loadLabels]);

  const update = (next: Partial<GestureSessionSettings>) => {
    const merged = { ...settings, ...next };
    setSettings(merged);
    saveSettings(merged);
  };

  const live = (id: string) => labels?.some((label) => label.id === id && label.archivedAt === null) ?? false;
  const nameOf = (id: string) => (id === PINCH ? "Pinch" : labels?.find((label) => label.id === id)?.displayName ?? id.replaceAll("_", " "));
  // Every gesture label but the pinch ones, which are one choice.
  const options = [
    { id: PINCH, displayName: "Pinch (in / hold / out)" },
    ...(labels ?? []).filter((label) => label.archivedAt === null && label.role === "positiveGesture" && !label.standard && !PINCH_LABELS.includes(label.id))
      .map((label) => ({ id: label.id, displayName: label.displayName })),
  ];
  const chosen = settings.gestures.filter((g) => options.some((option) => option.id === g) || g === PINCH);
  const hasPinch = chosen.includes(PINCH);
  const cameraReady = cam.status === "on" && cam.recordLandmarks;
  const cameraMarks = cameraReady && markingOn;
  const marking: Record<string, Marking> = Object.fromEntries(chosen.map((g) => [g, markingOf(g, definitions, cameraMarks)]));
  const byCamera = chosen.filter((g) => marking[g] === "camera");
  const byCue = chosen.filter((g) => marking[g] === "cue");
  const withRule = chosen.filter((g) => g !== PINCH && definitionsForLabels(definitions, [g]).length > 0);

  const createPinchLabels = async () => {
    setError(null);
    try {
      for (const [id, displayName, description] of [
        [PINCH_IN, "Pinch in", "The moment thumb and index finger meet."],
        [PINCH_HOLD, "Pinch hold", "Thumb and index finger held together, between pinch in and pinch out."],
        [PINCH_OUT, "Pinch out", "The moment thumb and index finger part again."],
      ] as const) {
        if (!labels?.some((label) => label.id === id)) {
          await invoke("create_model_label", { input: { id, displayName, description, color: "#65e6ff", role: "positiveGesture" } });
        }
      }
    } catch (err) {
      setError(`Could not add the labels: ${String(err)}`);
    }
    loadLabels();
  };

  // The camera is needed for pinch, and lets a gesture with a library rule be marked where it is really made.
  const wantsCamera = hasPinch || withRule.length > 0;
  const checks: Check[] = [
    { id: "watch", done: watchConnected, text: watchConnected ? "Watch connected" : "Connect the watch (Watch page)" },
    { id: "gestures", done: chosen.length > 0, text: chosen.length > 0 ? `${chosen.length === 1 ? "One gesture" : `${chosen.length} gestures`} to record` : "Choose the gestures to record" },
    ...(hasPinch ? [{
      id: "labels",
      done: live(PINCH_IN) && live(PINCH_HOLD) && live(PINCH_OUT),
      text: live(PINCH_IN) && live(PINCH_HOLD) && live(PINCH_OUT) ? "Labels pinch in, pinch hold and pinch out" : "Add the labels pinch in, pinch hold and pinch out",
      fix: desktopAvailable ? { label: "Add them", run: createPinchLabels } : undefined,
    }] : []),
    ...(wantsCamera ? [{
      id: "camera",
      // Only pinch cannot do without it: the others are labelled at the cue instead.
      done: cameraReady || !hasPinch,
      text: cameraReady ? "Camera on, saving hand landmarks" : hasPinch ? (cam.status === "on" ? "Save hand landmarks (camera panel)" : "Turn the camera on") : "Camera off: turn it on to let it mark the gestures it has a rule for",
      fix: cameraReady ? undefined : cam.status === "on"
        ? { label: "Save them", run: () => camera.setRecordLandmarks(true) }
        : { label: "Turn on", run: () => camera.enable() },
    }, {
      id: "marking",
      done: markingOn || !hasPinch,
      text: markingOn ? "Camera marking on" : "Let the camera mark the recording",
      fix: markingOn ? undefined : { label: "Turn on", run: () => cameraAssist.setEnabled(true) },
    }] : []),
  ];
  const ready = checks.every((check) => check.done);
  const plan = sessionPlan({ ...settings, gestures: chosen }, marking, nameOf);
  const problem = chosen.length === 0 ? null : planProblem(plan);
  const length = totalMs(planSteps(plan, () => 0.5));

  const start = () => {
    setError(null);
    // The recording's labels: the gestures cued (pinch with its hold and out), and nothing else.
    const recorded = [...new Set(chosen.flatMap((g) => (g === PINCH ? [PINCH_IN, PINCH_HOLD, PINCH_OUT] : [g])))];
    telemetryStore.selectDatasetLabel(recorded[0]);
    for (const extra of telemetryStore.getExtraLabels()) if (!recorded.includes(extra)) telemetryStore.toggleExtraLabel(extra);
    for (const wanted of recorded.slice(1)) if (!telemetryStore.getExtraLabels().includes(wanted)) telemetryStore.toggleExtraLabel(wanted);
    if (!guidedRunner.start(plan, Math.random, "gesture")) {
      setError("Could not start: stop the recording under way first.");
      return;
    }
    const marked = [...(hasPinch ? [PINCH_IN, PINCH_HOLD, PINCH_OUT] : []), ...byCamera];
    if (marked.length > 0) cameraAssist.arm(marked, definitionsForLabels(definitions, byCamera));
  };

  if (session?.source === "gesture") {
    return (
      <GuidedRunningView
        session={session}
        nameOf={(label) => (label === PINCH_IN ? "Pinch" : nameOf(label))}
        onStop={onStop}
        title="Gesture session"
        description="Make each gesture at its cue, hold it, and let go; keep your hand still in between. The recording stops and is saved by itself at the end."
      />
    );
  }

  return (
    <Card role="region" aria-label="Gesture session" className="min-w-0">
      <CardHeader>
        <SectionHeader
          title="Gesture session"
          description="Record one or more gestures, cued in a shuffled order, in one go."
          help={{
            label: "About the gesture session",
            content:
              "Choose the gestures to record. The app cues each one the set number of times, in a shuffled order so you cannot anticipate which comes next, on screen and with a buzz on the watch, with a still rest between. Make the gesture at the cue, hold it, and let go when it says. Pinch is marked by the camera: a short pinch in where thumb and index meet, pinch hold while they stay together, and a short pinch out where they part. A gesture with a camera rule in the Gesture library is marked by the camera where it sees it, when the camera is on. Any other is labelled from the cue to the end of the hold, which trails the real gesture by your reaction time: Label timing on the Labelling page measures and removes that. Keep the hand still in the rests. Then train in Model Lab: one model per gesture, or several gestures in one CNN v2.",
          }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="field">
          <div className="field-head"><Label required>Gestures</Label></div>
          <GestureMultiSelect label="Gestures to record" placeholder="Choose one or more…" catalogue={labels ?? []} disabled={recording}
            options={options} value={chosen} onChange={(next) => update({ gestures: next })} />
          {chosen.length > 0 && (
            <p className="field-hint">
              {[
                hasPinch ? "Pinch: marked by the camera, from the finger distance." : "",
                byCamera.length > 0 ? `${byCamera.map(nameOf).join(", ")}: marked by the camera, from ${byCamera.length === 1 ? "its" : "their"} Gesture library rule.` : "",
                byCue.length > 0 ? `${byCue.map(nameOf).join(", ")}: labelled at the cue (fix the timing on the Labelling page).` : "",
              ].filter(Boolean).join(" ")}
            </p>
          )}
        </div>
        <ul className="flex flex-col gap-2" aria-label="Before you start">
          {checks.map((check) => (
            <li key={check.id} className="flex flex-wrap items-center gap-2 text-sm">
              {check.done ? <CheckCircle2 className="size-4 text-[var(--green)]" aria-hidden="true" /> : <Circle className="size-4 text-muted-foreground" aria-hidden="true" />}
              <span className={check.done ? "" : "text-muted-foreground"}>{check.text}</span>
              <span className="sr-only">{check.done ? "done" : "to do"}</span>
              {check.fix && (
                <Button type="button" size="sm" variant="outline" disabled={recording} onClick={() => void check.fix?.run()}>{check.fix.label}</Button>
              )}
            </li>
          ))}
        </ul>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="field">
            <Label htmlFor="session-each">{chosen.length > 1 ? "Each gesture, times" : "Times"}</Label>
            <Input id="session-each" type="number" min={1} max={500} value={settings.each} disabled={recording} onChange={(event) => update({ each: Math.round(Number(event.target.value)) })} />
          </div>
          <div className="field">
            <Label htmlFor="session-hold">Hold each (s)</Label>
            <Input id="session-hold" type="number" min={0.1} max={5} step={0.1} value={settings.holdSeconds} disabled={recording} onChange={(event) => update({ holdSeconds: Number(event.target.value) })} />
          </div>
          <div className="field">
            <Label htmlFor="session-min-rest">Still at least (s)</Label>
            <Input id="session-min-rest" type="number" min={1} max={60} value={settings.minRestSeconds} disabled={recording} onChange={(event) => update({ minRestSeconds: Number(event.target.value) })} />
          </div>
          <div className="field">
            <Label htmlFor="session-max-rest">Still at most (s)</Label>
            <Input id="session-max-rest" type="number" min={1} max={60} value={settings.maxRestSeconds} disabled={recording} onChange={(event) => update({ maxRestSeconds: Number(event.target.value) })} />
          </div>
        </div>
        {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" disabled={recording || !ready || problem !== null} onClick={start}>Start gesture session</Button>
          <span className="hint">
            {problem ?? (ready ? <AnimatedText>{`About ${minutes(length)}.`}</AnimatedText> : "Finish the checks above first.")}
            {recording && !problem ? " A recording is under way." : ""}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
