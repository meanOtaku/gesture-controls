import { useCallback, useEffect, useState } from "react";
import { AnimatedNumber } from "../../../components/app/AnimatedNumber";
import { Card, CardContent } from "../../../components/ui/card";
import { useLabelModels } from "../hooks/useLabelModels";
import { useModelLabData } from "../hooks/useModelLabData";
import { datasetLabels } from "../types";
import { CompareCard } from "./CompareCard";
import { MistakesCard } from "./MistakesCard";
import { ThresholdCard } from "./ThresholdCard";
import { SealedTestCard } from "./SealedTestCard";
import { DetectionActivity } from "./DetectionActivity";
import { RuntimeSwitch } from "./RuntimeSwitch";
import { AdvancedSection } from "../../../components/app/AdvancedSection";
import { LabelModelsPanel } from "./LabelModelsPanel";
import { ModelInspector } from "./ModelInspector";
import { ModelPipeline } from "./ModelPipeline";
import { TrainingHistory } from "./TrainingHistory";
import { TrainPanel } from "./TrainPanel";

/**
 * Model Lab: teach the app a gesture one label at a time. The recordings it trains and tests on are kept on the Datasets
 * tab; here you train, look back at what was tried, then switch the models on and watch what they detect.
 */
export function ModelLab() {
  const desktopAvailable = "__TAURI_INTERNALS__" in window;
  const { datasets, labels } = useModelLabData(desktopAvailable);
  const { models, status, error: modelsError, refresh } = useLabelModels(desktopAvailable);
  const [inspecting, setInspecting] = useState<string | null>(null);

  // A model deleted while it was open is no longer there to look inside.
  useEffect(() => {
    if (inspecting !== null && models.length > 0 && !models.some((model) => model.id === inspecting)) setInspecting(null);
  }, [inspecting, models]);
  // Bring the inspector into view when a model is chosen.
  useEffect(() => {
    if (inspecting !== null) document.getElementById("lab-inspect")?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, [inspecting]);

  const showPipeline = useCallback(() => {
    const section = document.getElementById("lab-how");
    if (section instanceof HTMLDetailsElement) section.open = true;
    section?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, []);

  const coverageByLabel = new Map<string, number>();
  for (const dataset of datasets) {
    for (const label of datasetLabels(dataset)) coverageByLabel.set(label, (coverageByLabel.get(label) ?? 0) + 1);
  }
  const activeCount = models.filter((model) => model.state === "active").length;

  return (
    <main className="shell model-lab-shell">
      <header className="hero">
        <div>
          <h1>Model Lab</h1>
          <p className="subtitle">
            Train, activate and watch one model per label.
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
        <Card>{desktopAvailable ? <CardContent><RuntimeSwitch variant="page" /></CardContent> : <CardContent><span className="label">Runtime</span><strong className="text-numeric">Preview</strong><small>No model runs</small></CardContent>}</Card>
        <Card><CardContent><span className="label">Active models</span><strong className="text-numeric">{desktopAvailable ? <AnimatedNumber value={activeCount} /> : "—"}</strong><small>{desktopAvailable ? <><AnimatedNumber value={models.length} />{" registered"}</> : "Available in the desktop app"}</small></CardContent></Card>
        <Card><CardContent><span className="label">Recordings</span><strong className="text-numeric">{desktopAvailable ? <AnimatedNumber value={datasets.length} /> : "—"}</strong><small>{desktopAvailable ? <><AnimatedNumber value={coverageByLabel.size} />{" label"}{coverageByLabel.size === 1 ? "" : "s"}{" covered"}</> : "Available in the desktop app"}</small></CardContent></Card>
      </section>

      <nav className="lab-workflow" aria-label="Model Lab sections">
        <a href="#lab-train">Train</a><a href="#lab-labels">Models</a><a href="#lab-activity">Activity</a><a href="#lab-advanced">Advanced</a>
      </nav>

      <fieldset className="lab-workspace card-stack" disabled={!desktopAvailable} aria-label="Desktop model tools">
        <TrainPanel desktopAvailable={desktopAvailable} labels={labels} datasets={datasets} onShowPipeline={showPipeline} />
        <LabelModelsPanel desktopAvailable={desktopAvailable} models={models} status={status} loadError={modelsError} refresh={refresh} onInspect={setInspecting} />
        {inspecting !== null && <div id="lab-inspect"><ModelInspector id={inspecting} models={models} onClose={() => setInspecting(null)} /></div>}
        <DetectionActivity desktopAvailable={desktopAvailable} />
        <AdvancedSection id="lab-advanced" storageKey="modelLab" summary="Training history, mistakes, threshold, comparing models and the final test">
          <TrainingHistory desktopAvailable={desktopAvailable} labels={labels} datasets={datasets} refreshKey={models.map((model) => `${model.id}:${model.state}`).join(",")} />
          <MistakesCard desktopAvailable={desktopAvailable} models={models} datasets={datasets} />
          <ThresholdCard desktopAvailable={desktopAvailable} models={models} />
          <CompareCard desktopAvailable={desktopAvailable} models={models} datasets={datasets} />
          <SealedTestCard desktopAvailable={desktopAvailable} models={models} datasets={datasets} />
        </AdvancedSection>
        <AdvancedSection id="lab-how" storageKey="modelLabPipelines" title="How the models work" summary="The trees and the CNN, stage by stage, with what the research measured">
          <ModelPipeline />
        </AdvancedSection>
      </fieldset>
    </main>
  );
}
