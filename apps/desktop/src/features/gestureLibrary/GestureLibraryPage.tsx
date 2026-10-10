import { useRef, useState, useSyncExternalStore } from "react";
import { SectionHeader } from "../../components/app/SectionHeader";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../components/ui/card";
import { getCameraController } from "../camera/cameraService";
import { CameraPicker } from "../camera/components/CameraPicker";
import { CameraPreview } from "../camera/components/CameraPreview";
import { OperationFeedback } from "../../components/app/OperationFeedback";
import { useLabelModels } from "../model-lab/hooks/useLabelModels";
import { AgreementTracker } from "./agreement";
import { AgreementPanel } from "./AgreementPanel";
import { blankDefinition, describeRule, type GestureDefinition } from "./definition";
import { SecondCameraPanel } from "./SecondCameraPanel";
import { HandSideCheck } from "./HandSideCheck";
import { GestureEditor } from "./GestureEditor";
import { useGestureLibrary } from "./useGestureLibrary";
import { useLiveGestures } from "./useLiveGestures";

const percent = (value: number) => `${Math.round(value * 100)}%`;

/**
 * Gestures defined from hand landmarks. Each is a short, readable rule over a few hand measurements, made by recording
 * the gesture and everything else and then adjustable by hand. They run on the camera alone, so none of this needs the
 * watch.
 */
export function GestureLibraryPage() {
  const { definitions, labels, error, loaded, save, remove } = useGestureLibrary();
  const camera = getCameraController();
  const cam = useSyncExternalStore(camera.subscribe, camera.getSnapshot, camera.getSnapshot);
  const tracker = useRef(new AgreementTracker()).current;
  const camera2 = getCameraController("secondary");
  const cam2 = useSyncExternalStore(camera2.subscribe, camera2.getSnapshot, camera2.getSnapshot);
  const states = useLiveGestures(definitions, cam, tracker, cam2);
  const { status } = useLabelModels("__TAURI_INTERNALS__" in window);
  const [editing, setEditing] = useState<GestureDefinition | null>(null);
  const labelName = (id: string | null) => (id ? labels.find((l) => l.id === id)?.displayName ?? id : "no label");

  if (editing) {
    return (
      <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Spatial Gesture Control</p>
          <h1>Gesture library</h1>
          <p className="subtitle">Define gestures from your hand's shape, calibrate them by showing them to the camera, and see them recognised live.</p>
        </div>
      </header>
      <Card role="region" aria-label="Edit gesture">
        <CardHeader><SectionHeader title={editing.id ? `Edit “${editing.name}”` : "New gesture"} description="Record it, check the rule, save." /></CardHeader>
        <CardContent>
          <GestureEditor
            initial={editing}
            labels={labels}
            onCancel={() => setEditing(null)}
            onSave={async (definition) => {
              const problem = await save(definition);
              if (!problem) {
                OperationFeedback.success("Save gesture", `Saved ${definition.name}.`);
                setEditing(null);
              }
              return problem;
            }}
          />
        </CardContent>
      </Card>
      </main>
    );
  }

  const on = cam.status === "on";
  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Spatial Gesture Control</p>
          <h1>Gesture library</h1>
          <p className="subtitle">Define gestures from your hand's shape, calibrate them by showing them to the camera, and see them recognised live.</p>
        </div>
      </header>
      <Card role="region" aria-label="Gesture library">
        <CardHeader>
          <SectionHeader
            title="Gesture library"
            description="Gestures the camera recognises from your hand's shape. No watch needed."
            status={<Button type="button" onClick={() => setEditing(blankDefinition())}>New gesture</Button>}
            help={{
              label: "About the gesture library",
              content: "A gesture here is a rule over a few measurements of your hand, like the distance from thumb to index fingertip. You make one by holding the gesture for a few seconds and then doing anything else; the measurements that tell the two apart become the rule, and you can adjust them. Gestures linked to a label can later be used to label recordings.",
            }}
          />
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
          {cam.error && <Alert variant="destructive" role="alert"><AlertDescription>{cam.error}</AlertDescription></Alert>}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant={on ? "outline" : "default"} disabled={cam.status === "starting"} onClick={() => (on ? camera.disable() : void camera.enable())}>
              {cam.status === "starting" ? "Starting…" : on ? "Turn camera off" : "Turn camera on"}
            </Button>
            {on && <Badge variant="outline">{cam.fps > 0 ? `${cam.fps.toFixed(0)} frames/s` : "waiting for frames"}</Badge>}
            {!on && <span className="hint">Turn the camera on to see your gestures recognised live.</span>}
          </div>
          <CameraPicker camera={camera} state={cam} />
          <CameraPreview camera={camera} state={cam} hidden={!on} />
          {on && <HandSideCheck camera={cam} secondary={cam2} />}
          {on && <SecondCameraPanel primary={camera} primaryState={cam} secondary={camera2} secondaryState={cam2} />}
          {loaded && definitions.length === 0 && <p className="hint">No gestures yet. Make one with “New gesture”.</p>}
          <ul className="flex flex-col gap-3" aria-label="Gestures">
            {definitions.map((definition) => {
              const state = states.get(definition.id);
              const held = on && state?.held === true;
              return (
                <li key={definition.id} className={`gesture-card${held ? " gesture-card--lit" : ""}`} aria-label={definition.name}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <strong>{definition.name}</strong>
                    <span className="flex items-center gap-2">
                      {on && <Badge variant={held ? "default" : "secondary"}>{held ? "Detected" : "Not detected"}</Badge>}
                      {definition.calibration && <Badge variant="outline">{percent(definition.calibration.balancedAccuracy)} on calibration</Badge>}
                    </span>
                  </div>
                  <p className="field-hint">{describeRule(definition)}</p>
                  <small className="text-xs text-muted-foreground">
                    Label: {labelName(definition.labelId)}. {on ? `Recognised ${state?.count ?? 0} time${state?.count === 1 ? "" : "s"} since the camera was turned on.` : ""}
                    {!definition.calibration ? " Not calibrated; thresholds were set by hand." : ""}
                  </small>
                  <div className="flex gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => setEditing(definition)}>Edit</Button>
                    <Button type="button" variant="outline" size="sm" onClick={async () => {
                      const problem = await remove(definition.id);
                      if (problem) OperationFeedback.error("Delete gesture", problem);
                    }}>Delete</Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>
      <AgreementPanel tracker={tracker} definitions={definitions} status={status} cameraOn={on} />
    </main>
  );
}
