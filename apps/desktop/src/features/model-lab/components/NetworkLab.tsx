import { useEffect } from "react";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { useLabelModels } from "../hooks/useLabelModels";
import type { LabelModel } from "../labelModels";
import { PULSE_MODEL } from "../training";
import { ModelInspector } from "./ModelInspector";

const STATE_TEXT: Record<string, string> = { draft: "Draft", evaluated: "Evaluated", approved: "Approved", active: "Active", archived: "Archived" };

/** One registered model, with a button to look inside it. */
function ModelRow({ model, chosen, onChoose }: { model: LabelModel; chosen: boolean; onChoose: () => void }) {
  return (
    <li className="flex flex-wrap items-center gap-3 text-sm">
      <strong>{model.label}</strong>
      <code>{model.id}</code>
      <span className="text-muted-foreground">{STATE_TEXT[model.state] ?? model.state}{model.imported ? " · imported" : ""}</span>
      {model.monitorOnly && <Badge variant="outline">Monitor only</Badge>}
      <Button type="button" size="sm" variant={chosen ? "default" : "outline"} aria-pressed={chosen} aria-label={`Look inside ${model.id}`} onClick={onChoose}>
        {chosen ? "Looking inside" : "Look inside"}
      </Button>
    </li>
  );
}

/** The model's pipeline, stage by stage, with what the research measured. */
export function ModelPipeline() {
  const { research } = PULSE_MODEL;
  return (
    <Card id="lab-pipeline" role="region" aria-label="Model pipeline" className="min-w-0">
      <CardHeader>
        <SectionHeader
          title={PULSE_MODEL.name}
          description="The one model the app trains, for every label."
          help={{
            label: "About this model",
            content: "Chosen by the October 2026 research: of 26 methods and several ways of preparing the pulse signal, multi-scale z-scored derivatives with ExtraTrees had the best worst-case score on recordings the model never saw; adding the watch's motion raised it again and halved the false alarms on recordings without the gesture, and firing at the top of the score's climb caught more starts for the same false alarms. The research is in docs/research/ppg-imu-fusion-and-triggers-2026-10.md.",
          }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm">{PULSE_MODEL.summary}</p>
        <ol className="flex flex-wrap items-stretch gap-2" aria-label="Pipeline stages">
          {PULSE_MODEL.stages.map((stage, index) => (
            <li key={stage.title} className="flex items-center gap-2">
              <div className="rounded-md border px-3 py-2 text-sm" style={{ maxWidth: 190 }}>
                <strong className="block">{stage.title}</strong>
                <small className="text-muted-foreground">{stage.detail}</small>
              </div>
              {index < PULSE_MODEL.stages.length - 1 && <span aria-hidden="true">→</span>}
            </li>
          ))}
        </ol>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4" aria-label="Research results">
          <div><dt className="text-muted-foreground">Worst-case AUC</dt><dd className="text-numeric">{research.worstAuc.toFixed(3)}</dd></div>
          <div><dt className="text-muted-foreground">Mean AUC</dt><dd className="text-numeric">{research.meanAuc.toFixed(3)}</dd></div>
          <div><dt className="text-muted-foreground">Gesture starts caught</dt><dd className="text-numeric">{Math.round(research.recall * 100)}%</dd></div>
          <div><dt className="text-muted-foreground">False alarms</dt><dd className="text-numeric">≈{research.falsePerMinute.toFixed(1)} / min</dd></div>
        </dl>
        <p className="field-hint">
          Measured on 37 recordings, testing 20 times on recordings the model never trained on, firing on the peak at a cut-off of 0.65 (picked on those same tests, so a little optimistic). Your models choose their own cut-off, on their training recordings. One that does not pass the checks for going live can be activated, but it only runs in Monitor.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * The Network lab: what the model is, stage by stage, and a look inside each trained model (its inputs, how well it works,
 * the research checks). Training happens in Model Lab.
 */
export function NetworkLab({ modelId, onModelChange }: { modelId: string | null; onModelChange: (id: string | null) => void }) {
  const desktopAvailable = "__TAURI_INTERNALS__" in window;
  const { models } = useLabelModels(desktopAvailable);

  // A model that was deleted while it was open is no longer there to look inside.
  useEffect(() => {
    if (modelId !== null && models.length > 0 && !models.some((model) => model.id === modelId)) onModelChange(null);
  }, [modelId, models, onModelChange]);

  return (
    <main className="shell model-lab-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Spatial Gesture Control</p>
          <h1>Network lab</h1>
          <p className="subtitle">The model the app trains, and a look inside each one you have.</p>
        </div>
      </header>

      {!desktopAvailable && (
        <aside className="preview-notice" role="status">
          <span className="preview-icon" aria-hidden="true">i</span>
          <div>
            <strong>You’re viewing the browser preview</strong>
            <p>Your models need the desktop app. Open it with <code>npm start</code> from the project folder.</p>
          </div>
        </aside>
      )}

      <nav className="lab-workflow" aria-label="Network lab sections">
        <a href="#lab-pipeline">The model</a><a href="#lab-models">Look inside a model</a>
      </nav>

      <div className="lab-workspace card-stack">
        <ModelPipeline />

        <Card id="lab-models" role="region" aria-label="Your models" className="min-w-0">
          <CardHeader>
            <SectionHeader
              title="Your models"
              description="Choose one to see its inputs and how well it works on recordings it never trained on."
              help={{ label: "About your models", content: "These are the models trained here or imported. Looking inside a model shows how it is built, which inputs it leans on, and how well it works on recordings it never trained on." }}
            />
          </CardHeader>
          <CardContent>
            {models.length === 0 ? (
              <p className="hint">No models yet. Train one in Model Lab, or import one there.</p>
            ) : (
              <ul className="flex flex-col gap-2" aria-label="Models">
                {models.map((model) => <ModelRow key={model.id} model={model} chosen={model.id === modelId} onChoose={() => onModelChange(model.id)} />)}
              </ul>
            )}
          </CardContent>
        </Card>

        {modelId !== null && <ModelInspector id={modelId} models={models} onClose={() => onModelChange(null)} />}
      </div>
    </main>
  );
}
