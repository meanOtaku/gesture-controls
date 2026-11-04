import { Button } from "../../../components/ui/button";
import { Card, CardContent } from "../../../components/ui/card";
import { useLabelModels } from "../hooks/useLabelModels";
import { useModelLabData } from "../hooks/useModelLabData";
import { datasetLabels } from "../types";
import { appNavigation } from "../../../shared/navigation/appNavigation";
import { CompareCard } from "./CompareCard";
import { MistakesCard } from "./MistakesCard";
import { ThresholdCard } from "./ThresholdCard";
import { SealedTestCard } from "./SealedTestCard";
import { DetectionActivity } from "./DetectionActivity";
import { AdvancedSection } from "../../../components/app/AdvancedSection";
import { LabelModelsPanel } from "./LabelModelsPanel";
import { TrainingHistory } from "./TrainingHistory";
import { TrainPanel } from "./TrainPanel";

/**
 * Model Lab: teach the app a gesture one label at a time. The recordings it trains and tests on are kept on the Datasets
 * tab; here you train, look back at what was tried, then switch the models on and watch what they detect.
 */
export function ModelLab({ onOpenLabels, onInspectModel, onOpenNetworkLab }: { onOpenLabels?: () => void; /** Opens the Network lab on this model, to look inside it. */ onInspectModel?: (id: string) => void; onOpenNetworkLab?: () => void }) {
  const desktopAvailable = "__TAURI_INTERNALS__" in window;
  const { datasets, labels } = useModelLabData(desktopAvailable);
  const { models, status, error: modelsError, refresh } = useLabelModels(desktopAvailable);

  const coverageByLabel = new Map<string, number>();
  for (const dataset of datasets) {
    for (const label of datasetLabels(dataset)) coverageByLabel.set(label, (coverageByLabel.get(label) ?? 0) + 1);
  }
  const activeCount = models.filter((model) => model.state === "active").length;
  const mode = status?.mode ?? "off";

  return (
    <main className="shell model-lab-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Spatial Gesture Control</p>
          <h1>Model Lab</h1>
          <p className="subtitle">
            Teach the app a gesture one label at a time. Each label has its own model; switch on the ones you want, and use them as steps in a recipe.
          </p>
        </div>
      </header>

      {!desktopAvailable && (
        <aside className="preview-notice" role="status">
          <span className="preview-icon" aria-hidden="true">i</span>
          <div>
            <strong>You’re viewing the browser preview</strong>
            <p>Models, recordings and detection need the desktop app. Open it with <code>npm start</code> from the project folder.</p>
          </div>
        </aside>
      )}

      <section className="overview-grid" aria-label="Model Lab overview">
        <Card><CardContent><span className="label">Runtime</span><strong className="text-numeric">{desktopAvailable ? mode : "Preview"}</strong><small>{mode === "live" ? "Detections can start recipes" : mode === "monitor" ? "Watching only; nothing acts" : "No model runs"}</small></CardContent></Card>
        <Card><CardContent><span className="label">Active models</span><strong className="text-numeric">{desktopAvailable ? activeCount : "—"}</strong><small>{desktopAvailable ? `${models.length} registered` : "Available in the desktop app"}</small></CardContent></Card>
        <Card><CardContent><span className="label">Recordings</span><strong className="text-numeric">{desktopAvailable ? datasets.length : "—"}</strong><small>{desktopAvailable ? `${coverageByLabel.size} label${coverageByLabel.size === 1 ? "" : "s"} covered` : "Available in the desktop app"}</small></CardContent></Card>
      </section>

      <nav className="lab-workflow" aria-label="Model Lab sections">
        <a href="#lab-dataset">Recordings</a><a href="#lab-train">Train</a><a href="#lab-labels">Models</a><a href="#lab-activity">Activity</a><a href="#lab-advanced">Advanced</a>
      </nav>

      <fieldset className="lab-workspace card-stack" disabled={!desktopAvailable} aria-label="Desktop model tools">
        <Card id="lab-dataset" role="region" aria-label="Recordings">
          <CardContent className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm">{datasets.length} recording{datasets.length === 1 ? "" : "s"} to train and test on, kept on the Datasets tab: name, group and seal them there, and add ones recorded elsewhere.</span>
            <Button type="button" variant="outline" onClick={() => appNavigation.open("datasets")}>Open Datasets</Button>
          </CardContent>
        </Card>
        <TrainPanel desktopAvailable={desktopAvailable} labels={labels} datasets={datasets} onOpenNetworkLab={onOpenNetworkLab} />
        <LabelModelsPanel desktopAvailable={desktopAvailable} models={models} status={status} loadError={modelsError} refresh={refresh} onInspect={onInspectModel} />
        <DetectionActivity desktopAvailable={desktopAvailable} />
        <AdvancedSection id="lab-advanced" storageKey="modelLab" summary="Training history, mistakes, threshold, comparing models, the final test, and labels">
          <TrainingHistory desktopAvailable={desktopAvailable} labels={labels} datasets={datasets} refreshKey={models.map((model) => `${model.id}:${model.state}`).join(",")} />
          <MistakesCard desktopAvailable={desktopAvailable} models={models} datasets={datasets} />
          <ThresholdCard desktopAvailable={desktopAvailable} models={models} />
          <CompareCard desktopAvailable={desktopAvailable} models={models} datasets={datasets} />
          <SealedTestCard desktopAvailable={desktopAvailable} models={models} datasets={datasets} />
          <Card id="lab-coverage" role="region" aria-label="Labels">
            <CardContent className="flex flex-wrap items-center justify-between gap-3">
              <span><strong>Labels</strong> <small className="text-muted-foreground">Add, rename and archive labels on the Labels tab. {labels.filter((label) => label.archivedAt === null).length} in use here.</small></span>
              {onOpenLabels && <Button type="button" variant="outline" onClick={onOpenLabels}>Open Labels</Button>}
            </CardContent>
          </Card>
        </AdvancedSection>
      </fieldset>
    </main>
  );
}
