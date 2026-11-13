import { useEffect } from "react";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { useLabelModels } from "../hooks/useLabelModels";
import { formatTime, modelName, newestFirst, type LabelModel } from "../labelModels";
import { CNN_MODEL, PULSE_MODEL, type ModelDescription } from "../training";
import { ModelInspector } from "./ModelInspector";
import { ModelStages } from "./ModelStages";

const STATE_TEXT: Record<string, string> = { draft: "Draft", evaluated: "Evaluated", approved: "Approved", active: "Active", archived: "Archived" };

/** One registered model, with a button to look inside it. */
function ModelRow({ model, chosen, onChoose }: { model: LabelModel; chosen: boolean; onChoose: () => void }) {
  return (
    <li className="flex flex-wrap items-center gap-3 text-sm">
      <strong>{model.label}</strong>
      {model.name && <span>{modelName(model)}</span>}
      <code>{model.id}</code>
      <span className="text-muted-foreground">{STATE_TEXT[model.state] ?? model.state}{model.imported ? " · imported" : ""} · {formatTime(model.createdAt)}</span>
      {model.monitorOnly && <Badge variant="outline">Monitor only</Badge>}
      <Button type="button" size="sm" variant={chosen ? "default" : "outline"} aria-pressed={chosen} aria-label={`Look inside ${model.id}`} onClick={onChoose}>
        {chosen ? "Looking inside" : "Look inside"}
      </Button>
    </li>
  );
}

/** One model the app trains: its pipeline, stage by stage, with what the research measured. */
function PipelineCard({ model, description, help, results, hint }: { model: ModelDescription; description: string; help: string; results: [string, string][]; hint: string }) {
  return (
    <Card role="region" aria-label={`${model.name} pipeline`} className="min-w-0">
      <CardHeader>
        <SectionHeader title={model.name} description={description} help={{ label: `About the ${model.name}`, content: help }} />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm">{model.summary}</p>
        <ModelStages stages={model.stages} />
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4" aria-label="Research results">
          {results.map(([name, value]) => <div key={name}><dt className="text-muted-foreground">{name}</dt><dd className="text-numeric">{value}</dd></div>)}
        </dl>
        <p className="field-hint">{hint}</p>
      </CardContent>
    </Card>
  );
}

/** The two kinds of model the app trains, stage by stage. */
export function ModelPipeline() {
  const trees = PULSE_MODEL.research;
  const cnn = CNN_MODEL.research;
  return (
    <div id="lab-pipeline" className="flex min-w-0 flex-col gap-4">
      <PipelineCard
        model={PULSE_MODEL}
        description="Trees: Model Lab's default. They train quickly and from little data; for pinches the CNN below catches more, and sooner."
        help="Chosen by the October 2026 research: of 26 methods and several ways of preparing the pulse signal, multi-scale z-scored derivatives with ExtraTrees had the best worst-case score on recordings the model never saw; adding the watch's motion raised it again and halved the false alarms on recordings without the gesture, and firing at the top of the score's climb caught more starts for the same false alarms. The research is in docs/research/ppg-imu-fusion-and-triggers-2026-10.md."
        results={[["Worst-case AUC", trees.worstAuc.toFixed(3)], ["Mean AUC", trees.meanAuc.toFixed(3)], ["Gesture starts caught", `${Math.round(trees.recall * 100)}%`], ["False alarms", `≈${trees.falsePerMinute.toFixed(1)} / min`]]}
        hint="Measured on 37 recordings, testing 20 times on recordings the model never trained on, firing on the peak at a cut-off of 0.65 (picked on those same tests, so a little optimistic). Your models choose their own cut-off, on their training recordings. One that does not pass the checks for going live can be activated, but it only runs in Monitor."
      />
      <PipelineCard
        model={CNN_MODEL}
        description="The CNN: choose it in Model Lab's Train card."
        help="It decides sooner than the trees. Since November 2026 each channel is scaled by its median and spread, because the earlier rolling scaling hid pinches for 8 to 10 seconds after heavy motion. The research is in docs/research/cnn-motion-hangover-2026-11.md."
        results={[["Pinch ins caught", `${Math.round(cnn.recall * 100)}%`], ["False alarms", `at most ${cnn.falsePerMinute.toFixed(0)} / min`], ["Decides after", `${cnn.delayMs} ms`], ["Inputs", String(CNN_MODEL.inputs)]]}
        hint={`${CNN_MODEL.trainingNote} Pinch ins from a still hand, against 64% for the trees on the same recordings, measured with the earlier rolling scaling. Your models choose their own cut-off, on their training recordings. One that does not pass the checks for going live can be activated, but it only runs in Monitor.`}
      />
    </div>
  );
}

/**
 * The Network lab: what each kind of model is, stage by stage, and a look inside each trained model (its inputs, how well it works,
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
          <p className="subtitle">The two kinds of model the app trains, and a look inside each one you have.</p>
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
        <a href="#lab-pipeline">The models</a><a href="#lab-models">Look inside a model</a>
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
                {newestFirst(models).map((model) => <ModelRow key={model.id} model={model} chosen={model.id === modelId} onChoose={() => onModelChange(model.id)} />)}
              </ul>
            )}
          </CardContent>
        </Card>

        {modelId !== null && <ModelInspector id={modelId} models={models} onClose={() => onModelChange(null)} />}
      </div>
    </main>
  );
}
