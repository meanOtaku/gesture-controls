import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { getCameraController } from "../camera/cameraService";
import { CameraPicker } from "../camera/components/CameraPicker";
import { CameraPreview } from "../camera/components/CameraPreview";
import type { DatasetLabel } from "../model-lab/types";
import { analyse, scoreRule, MIN_FRAMES } from "./calibration";
import { HandSideCheck } from "./HandSideCheck";
import { CalibrationSession, GESTURE_SECONDS, NEGATIVE_MS, POSITIVE_MS, REST_SECONDS, type RecordLengths, type SessionSnapshot } from "./calibrationSession";
import {
  type Condition, type GestureDefinition, type HandChoice, type MeasureName,
  MAX_CONDITIONS, MAX_NAME_CHARS, MEASURES, definitionProblem, describeRule, measureInfo,
} from "./definition";

const SELECT = "recipe-select";
const LENGTHS_KEY = "gestureRecordLengths";

/** The recording lengths last chosen (remembered between sessions), or the defaults. */
function readLengths(): RecordLengths {
  try {
    const saved = JSON.parse(localStorage.getItem(LENGTHS_KEY) ?? "null") as Partial<RecordLengths> | null;
    const ok = (ms: unknown, options: readonly number[]) => typeof ms === "number" && options.includes(ms / 1000);
    if (saved && ok(saved.positiveMs, GESTURE_SECONDS) && ok(saved.negativeMs, REST_SECONDS)) return saved as RecordLengths;
  } catch {
    // Fall through to the defaults.
  }
  return { positiveMs: POSITIVE_MS, negativeMs: NEGATIVE_MS };
}
const percent = (value: number) => `${Math.round(value * 100)}%`;

const STEP_TEXT: Record<SessionSnapshot["step"], string> = {
  ready: "",
  getReady: "Get ready to make the gesture and hold it…",
  positive: "Hold the gesture. Move your hand a little: closer, further, turned slightly.",
  getReadyNegative: "Now relax your hand…",
  negative: "Do anything but the gesture: open hand, fist, pointing, relaxing, moving about.",
  done: "",
};

/** Why recorded frames were thrown away, in words, so a failed recording says what to change. */
function skippedWhy(skipped: SessionSnapshot["skipped"], hand: HandChoice): string {
  const parts: string[] = [];
  if (skipped.noHand > 0) parts.push(`${skipped.noHand} frames had no hand in view (keep your hand inside the picture and well lit)`);
  if (skipped.otherHand > 0) parts.push(`${skipped.otherHand} showed the other hand (this gesture is set to ${hand} hand only; if the line above the record button names the wrong hand when you raise your left, tick "Left and right are swapped")`);
  if (skipped.unmeasurable > 0) parts.push(`${skipped.unmeasurable} showed a hand that could not be measured`);
  return parts.length === 0 ? " The camera delivered no frames while recording." : ` Frames skipped: ${parts.join("; ")}.`;
}

type EditorProps = {
  initial: GestureDefinition;
  labels: DatasetLabel[];
  onSave: (definition: GestureDefinition) => Promise<string | null>;
  onCancel: () => void;
};

/**
 * Edits one gesture. The rule is found by recording: hold the gesture, then do everything else, and the measurements
 * that tell the two apart become the rule. The thresholds can then be adjusted by hand, with their effect on the
 * recorded frames shown as they change.
 */
export function GestureEditor({ initial, labels, onSave, onCancel }: EditorProps) {
  const camera = getCameraController();
  const cam = useSyncExternalStore(camera.subscribe, camera.getSnapshot, camera.getSnapshot);
  const [draft, setDraft] = useState<GestureDefinition>(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [lengths, setLengths] = useState<RecordLengths>(readLengths);
  const session = useRef(new CalibrationSession(initial.hand, lengths));
  const [snapshot, setSnapshot] = useState<SessionSnapshot>(() => session.current.snapshot(0));
  const [recorded, setRecorded] = useState<{ positive: SessionSnapshot["positive"]; negative: SessionSnapshot["negative"]; skipped: SessionSnapshot["skipped"] } | null>(null);
  const ids = { name: useId(), label: useId(), hand: useId(), hold: useId(), release: useId(), positive: useId(), rest: useId() };

  useEffect(() => {
    session.current = new CalibrationSession(draft.hand, lengths);
    setSnapshot(session.current.snapshot(0));
  }, [draft.hand, lengths]);

  useEffect(() => {
    if (cam.frame) session.current.onFrame(cam.frame);
  }, [cam.frame]);

  const running = snapshot.step !== "ready" && snapshot.step !== "done";
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      const now = performance.now();
      session.current.tick(now);
      const next = session.current.snapshot(now);
      setSnapshot(next);
      if (next.step === "done") setRecorded({ positive: next.positive, negative: next.negative, skipped: next.skipped });
    }, 100);
    return () => window.clearInterval(timer);
  }, [running]);

  // If the camera is turned off during a recording, stop it rather than finish with nothing.
  useEffect(() => {
    if (cam.status !== "on" && running) {
      session.current.reset();
      setSnapshot(session.current.snapshot(0));
    }
  }, [cam.status, running]);

  const analysis = useMemo(() => (recorded ? analyse(recorded.positive, recorded.negative) : null), [recorded]);
  const accuracy = recorded && draft.conditions.length > 0 ? scoreRule(draft.conditions, recorded.positive, recorded.negative) : null;
  const problem = definitionProblem(draft);

  const changeLengths = (change: Partial<RecordLengths>) => {
    const next = { ...lengths, ...change };
    setLengths(next);
    try {
      localStorage.setItem(LENGTHS_KEY, JSON.stringify(next));
    } catch {
      // The choice still holds for this session.
    }
  };
  const patch = (change: Partial<GestureDefinition>) => setDraft((d) => ({ ...d, ...change }));
  const patchCondition = (index: number, change: Partial<Condition>) =>
    setDraft((d) => ({ ...d, conditions: d.conditions.map((c, i) => (i === index ? { ...c, ...change } : c)) }));
  const number = (text: string, fallback: number) => (text.trim() === "" || !Number.isFinite(Number(text)) ? fallback : Number(text));

  const start = () => {
    setRecorded(null);
    session.current.start(performance.now());
    setSnapshot(session.current.snapshot(performance.now()));
  };
  const useAnalysis = () => {
    if (!analysis) return;
    patch({
      conditions: analysis.conditions,
      calibration: { positiveFrames: analysis.positiveFrames, negativeFrames: analysis.negativeFrames, balancedAccuracy: analysis.balancedAccuracy, calibratedAt: new Date().toISOString() },
    });
  };
  const addCondition = () => {
    const used = new Set(draft.conditions.map((c) => c.measure));
    const free = MEASURES.find((m) => !used.has(m.name));
    if (free) patch({ conditions: [...draft.conditions, { measure: free.name, direction: "below", enter: 0.3, exit: 0.4 }] });
  };
  const save = async () => {
    setSaving(true);
    const result = await onSave({ ...draft, name: draft.name.trim() });
    setSaving(false);
    if (result) setError(result);
  };

  const camOn = cam.status === "on";
  const counting = snapshot.step === "getReady" || snapshot.step === "getReadyNegative";
  const seconds = Math.ceil(snapshot.remainingMs / 1000);
  const framesNow = snapshot.step === "negative" ? snapshot.negative.length : snapshot.positive.length;

  return (
    <div className="gesture-editor flex flex-col gap-4" role="form" aria-label={initial.id ? `Edit ${initial.name}` : "New gesture"}>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="field">
          <div className="field-head"><Label htmlFor={ids.name} required>Name</Label></div>
          <Input id={ids.name} required aria-required="true" value={draft.name} maxLength={MAX_NAME_CHARS} placeholder="e.g. Pinch" onChange={(e) => patch({ name: e.target.value })} />
        </div>
        <div className="field">
          <div className="field-head"><Label htmlFor={ids.label}>Recorded as label</Label></div>
          <select id={ids.label} className={SELECT} value={draft.labelId ?? ""} onChange={(e) => patch({ labelId: e.target.value || null })}>
            <option value="">No label yet</option>
            {labels.filter((l) => !l.archivedAt).map((l) => <option key={l.id} value={l.id}>{l.displayName}</option>)}
          </select>
          <p className="field-hint">From the Labels tab, where you can add more.</p>
        </div>
        <div className="field">
          <div className="field-head"><Label htmlFor={ids.hand}>Hand</Label></div>
          <select id={ids.hand} className={SELECT} value={draft.hand} onChange={(e) => patch({ hand: e.target.value as HandChoice })}>
            <option value="either">Either hand</option>
            <option value="left">Left hand only</option>
            <option value="right">Right hand only</option>
          </select>
        </div>
      </div>

      <section className="flex flex-col gap-3" aria-label="Calibration">
        <h3 className="text-sm font-semibold">1. Show it to the camera</h3>
        <CameraPicker camera={camera} state={cam} />
        {!camOn ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={() => void camera.enable()} disabled={cam.status === "starting"}>{cam.status === "starting" ? "Starting…" : "Turn camera on"}</Button>
            <span className="hint">The camera must be on to calibrate. Nothing but hand landmarks is kept.</span>
          </div>
        ) : (
          <>
            <CameraPreview camera={camera} state={cam} hidden={false} />
            <HandSideCheck camera={cam} />
            <div className="flex flex-wrap items-end gap-3">
              <div className="field">
                <div className="field-head"><Label htmlFor={ids.positive}>Hold the gesture for</Label></div>
                <select id={ids.positive} className={SELECT} disabled={running} value={lengths.positiveMs / 1000} onChange={(e) => changeLengths({ positiveMs: Number(e.target.value) * 1000 })}>
                  {GESTURE_SECONDS.map((s) => <option key={s} value={s}>{s} seconds</option>)}
                </select>
              </div>
              <div className="field">
                <div className="field-head"><Label htmlFor={ids.rest}>Then everything else for</Label></div>
                <select id={ids.rest} className={SELECT} disabled={running} value={lengths.negativeMs / 1000} onChange={(e) => changeLengths({ negativeMs: Number(e.target.value) * 1000 })}>
                  {REST_SECONDS.map((s) => <option key={s} value={s}>{s} seconds</option>)}
                </select>
              </div>
            </div>
            <p className="field-hint">Longer recordings give the rule more to learn from. Move your hand about during both parts: closer, further, turned, in different light.</p>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" onClick={start} disabled={running || cam.frame?.hands.length === 0}>
                {recorded ? "Record again" : "Record gesture and background"}
              </Button>
              {running && <Button type="button" variant="outline" onClick={() => { session.current.reset(); setSnapshot(session.current.snapshot(0)); }}>Cancel</Button>}
              <span className="hint" role="status">
                {running ? `${STEP_TEXT[snapshot.step]} ${counting ? `${seconds}` : `${seconds}s left · ${framesNow} frames kept${snapshot.missedFrames > 0 ? `, ${snapshot.missedFrames} skipped` : ""}`}` : cam.frame?.hands.length === 0 ? "Put your hand in view to begin." : `About ${Math.round((3 + 3) + (lengths.positiveMs + lengths.negativeMs) / 1000)} seconds: a three-second countdown each time, ${lengths.positiveMs / 1000} holding the gesture, then ${lengths.negativeMs / 1000} of everything else.`}
              </span>
            </div>
            {running && snapshot.missedFrames > 5 && <p className="field-error" role="alert">Your hand keeps leaving view; those frames are not counted.</p>}
          </>
        )}
        {analysis && (
          <Alert variant={analysis.verdict === "good" || analysis.verdict === "okay" ? "default" : "destructive"} role="status">
            <AlertDescription>
              <strong>{analysis.verdict === "needsMoreFrames" ? `Not enough frames (need ${MIN_FRAMES} of each)` : `${percent(analysis.balancedAccuracy)} of recorded frames told apart correctly (${analysis.verdict})`}.</strong>{" "}
              {analysis.positiveFrames} gesture frames and {analysis.negativeFrames} other frames. {analysis.advice ?? ""}
              {recorded && analysis.verdict === "needsMoreFrames" && skippedWhy(recorded.skipped, draft.hand)}
              {analysis.conditions.length > 0 && <> Proposed rule: {describeRule({ conditions: analysis.conditions, hand: draft.hand })}.</>}
              {analysis.conditions.length > 0 && <div className="mt-2"><Button type="button" size="sm" onClick={useAnalysis}>Use this rule</Button></div>}
            </AlertDescription>
          </Alert>
        )}
      </section>

      <section className="flex flex-col gap-3" aria-label="Rule">
        <h3 className="text-sm font-semibold">2. The rule <span className="required-mark" aria-hidden="true">*</span></h3>
        {draft.conditions.length === 0 && <p className="hint">No rule yet. Record the gesture above, or add a condition yourself.</p>}
        {draft.conditions.map((condition, index) => (
          <div key={condition.measure} className="grid items-end gap-2 sm:grid-cols-[1.4fr_.8fr_.7fr_.7fr_auto]" role="group" aria-label={`Condition ${index + 1}`}>
            <div className="field">
              <div className="field-head"><Label>Measurement</Label></div>
              <select className={SELECT} aria-label={`Measurement ${index + 1}`} value={condition.measure} onChange={(e) => patchCondition(index, { measure: e.target.value as MeasureName })}>
                {MEASURES.map((m) => <option key={m.name} value={m.name} disabled={m.name !== condition.measure && draft.conditions.some((c) => c.measure === m.name)}>{m.label}</option>)}
              </select>
            </div>
            <div className="field">
              <div className="field-head"><Label>Must be</Label></div>
              <select className={SELECT} aria-label={`Direction ${index + 1}`} value={condition.direction} onChange={(e) => {
                const direction = e.target.value as Condition["direction"];
                patchCondition(index, { direction, exit: direction === "below" ? condition.enter + 0.1 : condition.enter - 0.1 });
              }}>
                <option value="below">below</option>
                <option value="above">above</option>
              </select>
            </div>
            <div className="field">
              <div className="field-head"><Label>Starts at</Label></div>
              <Input type="number" step="0.01" aria-label={`Start threshold ${index + 1}`} value={Number(condition.enter.toFixed(3))} onChange={(e) => patchCondition(index, { enter: number(e.target.value, condition.enter) })} />
            </div>
            <div className="field">
              <div className="field-head"><Label>Ends at</Label></div>
              <Input type="number" step="0.01" aria-label={`End threshold ${index + 1}`} value={Number(condition.exit.toFixed(3))} onChange={(e) => patchCondition(index, { exit: number(e.target.value, condition.exit) })} />
            </div>
            <Button type="button" variant="outline" aria-label={`Remove condition ${index + 1}`} onClick={() => patch({ conditions: draft.conditions.filter((_, i) => i !== index) })}>Remove</Button>
            <small className="hint sm:col-span-5">{measureInfo(condition.measure).hint} In {measureInfo(condition.measure).unit}.</small>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" onClick={addCondition} disabled={draft.conditions.length >= MAX_CONDITIONS}>Add condition</Button>
          {accuracy !== null && <Badge variant="outline">{percent(accuracy)} correct on the recorded frames</Badge>}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="field">
            <div className="field-head"><Label htmlFor={ids.hold}>Hold before it counts (ms)</Label></div>
            <Input id={ids.hold} type="number" min={0} max={2000} step={10} value={draft.minHoldMs} onChange={(e) => patch({ minHoldMs: number(e.target.value, draft.minHoldMs) })} />
            <p className="field-hint">Longer ignores brief accidental poses.</p>
          </div>
          <div className="field">
            <div className="field-head"><Label htmlFor={ids.release}>Forgive losing it for (ms)</Label></div>
            <Input id={ids.release} type="number" min={0} max={2000} step={10} value={draft.releaseGraceMs} onChange={(e) => patch({ releaseGraceMs: number(e.target.value, draft.releaseGraceMs) })} />
            <p className="field-hint">Longer stops a flickering hand ending it early.</p>
          </div>
        </div>
      </section>

      <p className="required-note"><span aria-hidden="true">*</span> Required. A gesture needs a name and at least one condition.</p>
      {(error || (problem && draft.name !== "")) && <p className="field-error" role="alert">{error ?? problem}</p>}
      <div className="flex gap-2">
        <Button type="button" onClick={() => void save()} disabled={saving || problem !== null}>{saving ? "Saving…" : "Save gesture"}</Button>
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
