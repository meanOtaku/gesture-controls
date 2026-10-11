import { useEffect } from "react";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { useLabelModels } from "../hooks/useLabelModels";
import type { LabelModel } from "../labelModels";
import { ModelInspector } from "./ModelInspector";
import { DesignResults } from "./DesignResults";
import { FineTunePlans } from "./FineTunePlans";
import { NetworkDesigns } from "./NetworkDesigns";
import { useTrainingRun } from "../hooks/useTrainingRun";
import { TrainingRunView } from "./TrainingRunView";

const STATE_TEXT: Record<string, string> = { draft: "Draft", evaluated: "Evaluated", approved: "Approved", active: "Active", archived: "Archived" };

/** One registered model, with a button to look inside it. */
function ModelRow({ model, chosen, onChoose }: { model: LabelModel; chosen: boolean; onChoose: () => void }) {
  return (
    <li className="flex flex-wrap items-center gap-3 text-sm">
      <strong>{model.label}</strong>
      <code>{model.id}</code>
      <span className="text-muted-foreground">{STATE_TEXT[model.state] ?? model.state}{model.imported ? " · imported" : ""}</span>
      <Button type="button" size="sm" variant={chosen ? "default" : "outline"} aria-pressed={chosen} aria-label={`Look inside ${model.id}`} onClick={onChoose}>
        {chosen ? "Looking inside" : "Look inside"}
      </Button>
    </li>
  );
}

/**
 * The Network lab: design the networks (the columns a model reads, how many input neurons that makes, its layers and neurons)
 * that Model Lab trains with, then look inside a trained model (weights, heatmaps, how well it works), edit its weights by hand
 * and fine-tune it. Training itself happens in Model Lab.
 */
export function NetworkLab({ modelId, onModelChange }: { modelId: string | null; onModelChange: (id: string | null) => void }) {
  const desktopAvailable = "__TAURI_INTERNALS__" in window;
  const run = useTrainingRun(desktopAvailable);
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
          <p className="subtitle">
            Design the networks models are trained with, look inside a trained model, edit its weights and fine-tune it.
          </p>
        </div>
      </header>

      {!desktopAvailable && (
        <aside className="preview-notice" role="status">
          <span className="preview-icon" aria-hidden="true">i</span>
          <div>
            <strong>You’re viewing the browser preview</strong>
            <p>Networks need the desktop app. Open it with <code>npm start</code> from the project folder.</p>
          </div>
        </aside>
      )}

      <nav className="lab-workflow" aria-label="Network lab sections">
        <a href="#lab-designs">Network designs</a><a href="#lab-plans">Fine-tune plans</a><a href="#lab-results">Results by design</a><a href="#lab-models">Look inside a model</a>
      </nav>

      <fieldset className="lab-workspace card-stack" disabled={!desktopAvailable} aria-label="Network tools">
        <NetworkDesigns desktopAvailable={desktopAvailable} />
        <FineTunePlans desktopAvailable={desktopAvailable} />

        <DesignResults desktopAvailable={desktopAvailable} refreshKey={models.map((model) => `${model.id}:${model.state}`).join(",")} onInspect={onModelChange} />

        <Card id="lab-models" role="region" aria-label="Your models" className="min-w-0">
          <CardHeader>
            <SectionHeader
              title="Your models"
              description="Choose one to see its inputs, weights and charts, to edit its weights and to fine-tune it."
              help={{ label: "About your models", content: "These are the models trained here or imported. Looking inside a model shows how it is built and how well it works on recordings it never trained on; a model trained in this app can also be edited and fine-tuned, which makes a new model and leaves this one as it is." }}
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

        {(run.running !== null || run.curve.length > 0 || run.result !== null) && (
          <Card id="lab-run" role="region" aria-label="Training progress" className="min-w-0">
            <CardHeader><SectionHeader title="Training progress" description="Fine-tuning a model runs here; models are trained from Model Lab." /></CardHeader>
            <CardContent className="flex flex-col gap-4"><TrainingRunView run={run} /></CardContent>
          </Card>
        )}

        {modelId !== null && <ModelInspector id={modelId} models={models} onClose={() => onModelChange(null)} />}
      </fieldset>
    </main>
  );
}
