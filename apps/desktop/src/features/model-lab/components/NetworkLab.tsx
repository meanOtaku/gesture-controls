import { useEffect } from "react";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { useLabelModels } from "../hooks/useLabelModels";
import { useModelLabData } from "../hooks/useModelLabData";
import type { LabelModel } from "../labelModels";
import { ModelInspector } from "./ModelInspector";
import { TrainPanel } from "./TrainPanel";

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
 * The Network lab: design a neural network (the columns it reads, how many input neurons that makes, its layers and neurons),
 * train it, then look inside it (weights, heatmaps, how well it works), edit its weights by hand and fine-tune it. It is the
 * workbench for the networks; Model Lab is where the models are trained simply, reviewed and switched on.
 */
export function NetworkLab({ modelId, onModelChange }: { modelId: string | null; onModelChange: (id: string | null) => void }) {
  const desktopAvailable = "__TAURI_INTERNALS__" in window;
  const { datasets, labels } = useModelLabData(desktopAvailable);
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
            Design a neural network from your data's columns, train it, look inside it, edit its weights and fine-tune it.
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
        <a href="#lab-train">Build a network</a><a href="#lab-models">Look inside a model</a>
      </nav>

      <fieldset className="lab-workspace card-stack" disabled={!desktopAvailable} aria-label="Network tools">
        <TrainPanel desktopAvailable={desktopAvailable} labels={labels} datasets={datasets} lab />

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
              <p className="hint">No models yet. Build one above, or import one under Model Lab.</p>
            ) : (
              <ul className="flex flex-col gap-2" aria-label="Models">
                {models.map((model) => <ModelRow key={model.id} model={model} chosen={model.id === modelId} onChoose={() => onModelChange(model.id)} />)}
              </ul>
            )}
          </CardContent>
        </Card>

        {modelId !== null && <ModelInspector id={modelId} models={models} onClose={() => onModelChange(null)} />}
      </fieldset>
    </main>
  );
}
