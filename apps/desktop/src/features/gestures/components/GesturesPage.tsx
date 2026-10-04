import { SectionHeader } from "../../../components/app/SectionHeader";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import type { AutomationState, CalibrationState, HeuristicGestures, PitchDirection, RollDirection, SwipeDirection, TapKind } from "../../../shared/protocol/events";
import { useLabelModels } from "../../model-lab/hooks/useLabelModels";
import { WRIST_GESTURES, recipesUsingGesture, recipesUsingLabel, recipesUsingStem, type WristGesture } from "../gestureCatalog";
import { useFlash } from "../useFlash";
import { useLabelDetections } from "../useLabelDetections";

/** The latest recognition of a gesture family: which variant, and how many so far. */
export type LastRecognised = { id: string; count: number } | null;

type GesturesPageProps = {
  heuristics: HeuristicGestures | undefined;
  watchConnected: boolean;
  /** The STEM button is held down right now. */
  stemDown: boolean;
  shakeCount: number;
  lastSwipe: { direction: SwipeDirection; count: number } | null;
  lastTap: { kind: TapKind; count: number } | null;
  lastRoll: { direction: RollDirection; count: number } | null;
  lastPitch: { direction: PitchDirection; count: number } | null;
  calibration: CalibrationState | null;
  automation: AutomationState | null;
  onOpenModelLab: () => void;
  onOpenSettings: () => void;
};

function Chip({ lit, children }: { lit: boolean; children: React.ReactNode }) {
  return (
    <span className={`gesture-chip${lit ? " gesture-chip--lit" : ""}`} data-lit={lit} aria-label={`${children}${lit ? ", recognised just now" : ""}`}>
      {children}
    </span>
  );
}

function WristGestureCard({ gesture, last, on, usedBy }: { gesture: WristGesture; last: LastRecognised; on: boolean; usedBy: string[] }) {
  const lit = useFlash(last?.count ?? 0);
  return (
    <li className={`gesture-card${lit ? " gesture-card--lit" : ""}`} aria-label={gesture.name}>
      <div className="flex items-center justify-between gap-2">
        <strong>{gesture.name}</strong>
        <Badge variant={on ? "default" : "secondary"}>{on ? "On" : "Off in Settings"}</Badge>
      </div>
      <p className="field-hint">{gesture.how}</p>
      <div className="gesture-chips">
        {gesture.options.map((option) => <Chip key={option.id} lit={lit && last?.id === option.id}>{option.label}</Chip>)}
      </div>
      <small className="text-xs text-muted-foreground">
        {last ? `Recognised ${last.count} time${last.count === 1 ? "" : "s"} this session.` : "Not recognised yet this session."}
        {on ? "" : " Switch it on under Settings → Built-in gestures."}
        {usedBy.length > 0 ? ` Used by: ${usedBy.join(", ")}.` : ""}
      </small>
    </li>
  );
}

function StemCard({ down, usedBy }: { down: boolean; usedBy: string[] }) {
  return (
    <li className={`gesture-card${down ? " gesture-card--lit" : ""}`} aria-label="STEM button">
      <div className="flex items-center justify-between gap-2">
        <strong>STEM button</strong>
        <Badge variant={down ? "default" : "secondary"}>{down ? "Held" : "Released"}</Badge>
      </div>
      <p className="field-hint">Press and hold the button on the watch. It lights while it is held.</p>
      {usedBy.length > 0 && <small className="text-xs text-muted-foreground">Used by: {usedBy.join(", ")}.</small>}
    </li>
  );
}

function ModelCard({ label, score, detected, count, usedBy }: { label: string; score: number | undefined; detected: boolean; count: number; usedBy: string[] }) {
  const flash = useFlash(count);
  const lit = detected || flash;
  return (
    <li className={`gesture-card${lit ? " gesture-card--lit" : ""}`} aria-label={label}>
      <div className="flex items-center justify-between gap-2">
        <strong>{label}</strong>
        <Badge variant={detected ? "default" : "secondary"}>{detected ? "Detected" : "Not detected"}</Badge>
      </div>
      <div className="gesture-meter" role="meter" aria-label={`${label} score`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((score ?? 0) * 100)}>
        <div className="gesture-meter-fill" style={{ width: `${Math.round((score ?? 0) * 100)}%` }} />
      </div>
      <small className="text-xs text-muted-foreground">
        {score === undefined ? "No score yet." : `Score ${Math.round(score * 100)}%.`} Detected {count} time{count === 1 ? "" : "s"} this session.
        {usedBy.length > 0 ? ` Used by: ${usedBy.join(", ")}.` : ""}
      </small>
    </li>
  );
}

/**
 * A place to try what is working: every built-in gesture and every loaded model, lighting up as it is recognised, so
 * you can see what the app sees before building a recipe from it. Nothing here acts on the computer.
 */
export function GesturesPage({ heuristics, watchConnected, stemDown, shakeCount, lastSwipe, lastTap, lastRoll, lastPitch, calibration, automation, onOpenModelLab, onOpenSettings }: GesturesPageProps) {
  const desktopAvailable = "__TAURI_INTERNALS__" in window;
  const { status } = useLabelModels(desktopAvailable);
  const detections = useLabelDetections(desktopAvailable);
  const recipes = automation?.recipes ?? [];
  const lasts: Record<string, LastRecognised> = {
    shake: shakeCount > 0 ? { id: "shake", count: shakeCount } : null,
    swipe: lastSwipe && { id: lastSwipe.direction, count: lastSwipe.count },
    tap: lastTap && { id: lastTap.kind, count: lastTap.count },
    roll: lastRoll && { id: lastRoll.direction, count: lastRoll.count },
    pitch: lastPitch && { id: lastPitch.direction, count: lastPitch.count },
  };
  const targets = (calibration?.targets ?? []).filter((target) => target.calibrated);
  const loaded = status?.loadedLabels ?? [];
  const mode = status?.mode ?? "off";

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Spatial Gesture Control</p>
          <h1>Gestures</h1>
          <p className="subtitle">Try what is working. Each gesture lights up when the app recognises it. Nothing here controls your computer; that is what recipes are for.</p>
        </div>
      </header>

      {!watchConnected && (
        <Alert role="status">
          <AlertDescription>The watch is not connected, so the wrist gestures and the STEM button cannot be recognised. Connect it on the Watch tab.</AlertDescription>
        </Alert>
      )}

      <Card role="region" aria-label="Wrist and hand gestures">
        <CardHeader>
          <SectionHeader
            title="Watch gestures"
            description="Built in and rule-based. Tune them under Settings."
            status={<Button type="button" variant="outline" onClick={onOpenSettings}>Open Settings</Button>}
          />
        </CardHeader>
        <CardContent>
          <ul className="gesture-grid" aria-label="Watch gestures">
            <StemCard down={stemDown} usedBy={recipesUsingStem(recipes)} />
            {WRIST_GESTURES.map((gesture) => (
              <WristGestureCard key={gesture.id} gesture={gesture} last={lasts[gesture.id] ?? null} on={heuristics?.[gesture.id] !== false} usedBy={recipesUsingGesture(recipes, gesture.id)} />
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card role="region" aria-label="Head locations">
        <CardHeader>
          <SectionHeader title="Head locations" description="The places you can look at to start a recipe. The one you are looking at lights up." />
        </CardHeader>
        <CardContent>
          {targets.length === 0 ? (
            <p className="hint">No location is calibrated yet. Calibrate one on the Headphones tab.</p>
          ) : (
            <div className="gesture-chips" role="list" aria-label="Calibrated locations">
              {targets.map((target) => (
                <span key={target.id} role="listitem">
                  <Chip lit={calibration?.activeTarget === target.id}>{target.name}</Chip>
                </span>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card role="region" aria-label="Model gestures">
        <CardHeader>
          <SectionHeader
            title="Model gestures"
            description="Active models you trained or imported, one per label."
            status={<Button type="button" variant="outline" onClick={onOpenModelLab}>Open Model Lab</Button>}
          />
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {mode === "off" && loaded.length > 0 && (
            <Alert role="status">
              <AlertDescription>The model runtime is Off, so nothing is being scored. Set it to Monitor in Model Lab to try these without anything acting.</AlertDescription>
            </Alert>
          )}
          {loaded.length === 0 ? (
            <p className="hint">No model is loaded. Import one in Model Lab, then approve and activate it, and it will show up here.</p>
          ) : (
            <ul className="gesture-grid" aria-label="Loaded models">
              {loaded.map((label) => (
                <ModelCard key={label} label={label} score={status?.lastScores[label]} detected={detections.detected.has(label)} count={detections.counts.get(label) ?? 0} usedBy={recipesUsingLabel(recipes, label)} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
