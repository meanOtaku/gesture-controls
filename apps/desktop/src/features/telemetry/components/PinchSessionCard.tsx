import { invoke } from "@tauri-apps/api/core";
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
import { PINCH_HOLD, PINCH_IN, PINCH_OUT } from "../../gestureLibrary/pinchEdgeMarker";
import type { DatasetLabel } from "../../model-lab/types";
import { guidedRunner } from "../recording/guidedRunner";
import { planProblem, planSteps, totalMs, type GuidedPlan } from "../recording/guidedSession";
import { telemetryStore } from "../store/telemetryStore";
import { GuidedRunningView } from "./GuidedRunningView";

/** What the person can change about a pinch session; the rest of the plan is fixed. */
export interface PinchSettings {
  pinches: number;
  holdSeconds: number;
  minRestSeconds: number;
  maxRestSeconds: number;
}

export const DEFAULT_PINCH_SETTINGS: PinchSettings = { pinches: 20, holdSeconds: 1, minRestSeconds: 4, maxRestSeconds: 8 };
const STORAGE_KEY = "recorder.pinchSession";

function loadSettings(): PinchSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<PinchSettings> | null;
    if (stored && typeof stored === "object") return { ...DEFAULT_PINCH_SETTINGS, ...stored };
  } catch {
    // A missing or broken setting falls back to the default.
  }
  return DEFAULT_PINCH_SETTINGS;
}

function saveSettings(settings: PinchSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Remembering is a convenience.
  }
}

/**
 * The guided plan for a pinch session: cue "Pinch" with a buzz, hold, then let go, with still rests between. The session
 * only cues; the camera marks pinch in and pinch out where the fingers actually meet and part (`pinchEdgeMarker`).
 */
export function pinchPlan(settings: PinchSettings): GuidedPlan {
  return {
    label: PINCH_IN,
    cues: settings.pinches,
    holdMs: Math.round(settings.holdSeconds * 1000),
    minGapSeconds: settings.minRestSeconds,
    maxGapSeconds: settings.maxRestSeconds,
    everydayLabel: null,
    activities: [],
    labelCues: false,
    cueText: "Pinch",
  };
}

const minutes = (ms: number) => `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;

type Check = { id: string; done: boolean; text: string; fix?: { label: string; run: () => void | Promise<void> } };

/**
 * One place to record pinch in and pinch out: checks the watch, the labels, the camera and camera marking (each with a
 * fix), then runs a guided session that cues each pinch while the camera marks the touch and the release.
 */
export function PinchSessionCard({ recording, watchConnected, desktopAvailable, onStop }: {
  recording: boolean;
  watchConnected: boolean;
  desktopAvailable: boolean;
  /** Stops the recording and saves it, as the recorder's Stop does. */
  onStop: () => void;
}) {
  const [settings, setSettings] = useState<PinchSettings>(loadSettings);
  const [labels, setLabels] = useState<DatasetLabel[] | null>(null);
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
  }, [desktopAvailable]);
  useEffect(loadLabels, [loadLabels]);

  const update = (next: Partial<PinchSettings>) => {
    const merged = { ...settings, ...next };
    setSettings(merged);
    saveSettings(merged);
  };

  const live = (id: string) => labels?.some((label) => label.id === id && label.archivedAt === null) ?? false;
  const createLabels = async () => {
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

  const cameraReady = cam.status === "on" && cam.recordLandmarks;
  const checks: Check[] = [
    { id: "watch", done: watchConnected, text: watchConnected ? "Watch connected" : "Connect the watch (Watch page)" },
    {
      id: "labels",
      done: live(PINCH_IN) && live(PINCH_HOLD) && live(PINCH_OUT),
      text: live(PINCH_IN) && live(PINCH_HOLD) && live(PINCH_OUT) ? "Labels pinch in, pinch hold and pinch out" : "Add the labels pinch in, pinch hold and pinch out",
      fix: desktopAvailable ? { label: "Add them", run: createLabels } : undefined,
    },
    {
      id: "camera",
      done: cameraReady,
      text: cameraReady ? "Camera on, saving hand landmarks" : cam.status === "on" ? "Save hand landmarks (camera panel)" : "Turn the camera on",
      fix: cam.status === "on"
        ? { label: "Save them", run: () => camera.setRecordLandmarks(true) }
        : { label: "Turn on", run: () => camera.enable() },
    },
    { id: "marking", done: markingOn, text: markingOn ? "Camera marking on" : "Let the camera mark the recording", fix: { label: "Turn on", run: () => cameraAssist.setEnabled(true) } },
  ];
  const ready = checks.every((check) => check.done);
  const plan = pinchPlan(settings);
  const problem = planProblem(plan);
  const length = totalMs(planSteps(plan, () => 0.5));

  const start = () => {
    setError(null);
    // The recording's labels: pinch in, with pinch hold and pinch out beside it, and nothing else.
    telemetryStore.selectDatasetLabel(PINCH_IN);
    for (const extra of telemetryStore.getExtraLabels()) if (extra !== PINCH_OUT && extra !== PINCH_HOLD) telemetryStore.toggleExtraLabel(extra);
    for (const wanted of [PINCH_HOLD, PINCH_OUT]) if (!telemetryStore.getExtraLabels().includes(wanted)) telemetryStore.toggleExtraLabel(wanted);
    if (!guidedRunner.start(plan, Math.random, "pinch")) {
      setError("Could not start: stop the recording under way first.");
      return;
    }
    cameraAssist.arm([PINCH_IN, PINCH_HOLD, PINCH_OUT], []);
  };

  if (session?.source === "pinch") {
    return (
      <GuidedRunningView
        session={session}
        nameOf={() => "Pinch"}
        onStop={onStop}
        title="Pinch in / out session"
        description="Pinch at each cue, hold, and let go; keep your hand still in between. The camera marks pinch in, the hold and pinch out. The recording stops and is saved by itself at the end."
      />
    );
  }

  return (
    <Card role="region" aria-label="Pinch in / out session" className="min-w-0">
      <CardHeader>
        <SectionHeader
          title="Pinch in / out session"
          description="Record pinch in, pinch hold and pinch out, marked by the camera, in one go."
          help={{
            label: "About the pinch in / out session",
            content:
              "The app cues each pinch on screen and with a buzz on the watch, at random moments, with a still rest between. Touch thumb and index at the cue, hold, and let go when it says. The camera marks a short pinch in where the fingers meet, pinch hold while they stay together, and a short pinch out where they part, from their distance, so the labels sit on the real moments rather than on your reaction to the cue. Keep the hand still in the rests: models trained with the still-hand rule learn only from pinches made from a still hand. Train a model for each label you want detected afterwards in Model Lab.",
          }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ul className="flex flex-col gap-2" aria-label="Before you start">
          {checks.map((check) => (
            <li key={check.id} className="flex flex-wrap items-center gap-2 text-sm">
              {check.done ? <CheckCircle2 className="size-4 text-[var(--green)]" aria-hidden="true" /> : <Circle className="size-4 text-muted-foreground" aria-hidden="true" />}
              <span className={check.done ? "" : "text-muted-foreground"}>{check.text}</span>
              <span className="sr-only">{check.done ? "done" : "to do"}</span>
              {!check.done && check.fix && (
                <Button type="button" size="sm" variant="outline" disabled={recording} onClick={() => void check.fix?.run()}>{check.fix.label}</Button>
              )}
            </li>
          ))}
        </ul>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="field">
            <Label htmlFor="pinch-count">Pinches</Label>
            <Input id="pinch-count" type="number" min={1} max={500} value={settings.pinches} disabled={recording} onChange={(event) => update({ pinches: Math.round(Number(event.target.value)) })} />
          </div>
          <div className="field">
            <Label htmlFor="pinch-hold">Hold each (s)</Label>
            <Input id="pinch-hold" type="number" min={0.1} max={5} step={0.1} value={settings.holdSeconds} disabled={recording} onChange={(event) => update({ holdSeconds: Number(event.target.value) })} />
          </div>
          <div className="field">
            <Label htmlFor="pinch-min-rest">Still at least (s)</Label>
            <Input id="pinch-min-rest" type="number" min={1} max={60} value={settings.minRestSeconds} disabled={recording} onChange={(event) => update({ minRestSeconds: Number(event.target.value) })} />
          </div>
          <div className="field">
            <Label htmlFor="pinch-max-rest">Still at most (s)</Label>
            <Input id="pinch-max-rest" type="number" min={1} max={60} value={settings.maxRestSeconds} disabled={recording} onChange={(event) => update({ maxRestSeconds: Number(event.target.value) })} />
          </div>
        </div>
        {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" disabled={recording || !ready || problem !== null} onClick={start}>Start pinch session</Button>
          <span className="hint">
            {problem ?? (ready ? `About ${minutes(length)}.` : "Finish the checks above first.")}
            {recording && !problem ? " A recording is under way." : ""}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
