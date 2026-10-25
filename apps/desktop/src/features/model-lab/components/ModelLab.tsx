import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useState } from "react";
import { feedbackWithUndo, OperationFeedback } from "../../../components/app/OperationFeedback";
import { Button } from "../../../components/ui/button";
import { Card, CardContent } from "../../../components/ui/card";
import { useLabelModels } from "../hooks/useLabelModels";
import { useModelLabData } from "../hooks/useModelLabData";
import { datasetLabels, describeGaps, type DatasetSummary } from "../types";
import { DatasetManager } from "./DatasetManager";
import { CompareCard } from "./CompareCard";
import { MistakesCard } from "./MistakesCard";
import { ThresholdCard } from "./ThresholdCard";
import { SealedTestCard } from "./SealedTestCard";
import { DetectionActivity } from "./DetectionActivity";
import { LabelModelsPanel } from "./LabelModelsPanel";
import { RecorderRecordings } from "./RecorderRecordings";
import { TrainingHistory } from "./TrainingHistory";
import { TrainPanel } from "./TrainPanel";

/**
 * Model Lab: teach the app a gesture one label at a time. The sections follow the order you use them: add recordings
 * to the training data, check which labels they cover, train, look back at what was tried, then switch the models on
 * and watch what they detect.
 */
export function ModelLab({ onOpenLabels, onInspectModel, onOpenNetworkLab }: { onOpenLabels?: () => void; /** Opens the Network lab on this model, to look inside it. */ onInspectModel?: (id: string) => void; onOpenNetworkLab?: () => void }) {
  const desktopAvailable = "__TAURI_INTERNALS__" in window;
  const { datasets, labels, loading, error, setError, refreshDatasets } = useModelLabData(desktopAvailable);
  const [importing, setImporting] = useState(false);
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(new Set());
  const { models, status, error: modelsError, refresh } = useLabelModels(desktopAvailable);

  const handleImport = useCallback(
    async ({ filename, csvContent }: { filename: string; csvContent: string }) => {
      setImporting(true);
      try {
        await invoke("import_model_dataset", { filename, csvContent });
        setError(null);
        await refreshDatasets();
        OperationFeedback.success("Import recording", `Imported ${filename}.`);
      } catch (err) {
        setError(String(err));
        OperationFeedback.error("Import recording", String(err));
      } finally {
        setImporting(false);
      }
    },
    [refreshDatasets],
  );

  const handleImportFolder = useCallback(async () => {
    const chosen = await open({ directory: true, multiple: false, title: "Choose a recording folder (it holds ppg.csv and imu.csv)" });
    if (typeof chosen !== "string") return;
    setImporting(true);
    try {
      const made = await invoke<DatasetSummary>("import_model_dataset_folder", { path: chosen });
      setError(null);
      await refreshDatasets();
      const gaps = describeGaps(made?.gaps);
      OperationFeedback.success("Import recording folder", `Imported ${made?.originalFilename ?? "the folder"}.${gaps?.warn ? ` The watch stream stalled in it (${gaps.text}).` : ""}`);
    } catch (err) {
      setError(String(err));
      OperationFeedback.error("Import recording folder", String(err));
    } finally {
      setImporting(false);
    }
  }, [refreshDatasets]);

  const handleDelete = useCallback(
    async (id: string) => {
      setPendingDeleteIds((prev) => new Set(prev).add(id));
      try {
        await invoke("delete_model_dataset", { id });
        setError(null);
        await refreshDatasets();
        OperationFeedback.success("Delete recording", "Recording deleted.");
      } catch (err) {
        setError(String(err));
        OperationFeedback.error("Delete recording", String(err));
      } finally {
        setPendingDeleteIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [refreshDatasets],
  );

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
        <a href="#lab-recorder">From the Recorder</a><a href="#lab-dataset">Recordings</a><a href="#lab-coverage">Labels</a><a href="#lab-train">Train</a><a href="#lab-history">History</a><a href="#lab-labels">Models</a><a href="#lab-activity">Activity</a>
      </nav>

      <fieldset className="lab-workspace card-stack" disabled={!desktopAvailable} aria-label="Desktop model tools">
        <RecorderRecordings desktopAvailable={desktopAvailable} labels={labels} datasets={datasets} onAdded={() => void refreshDatasets()} />
        <DatasetManager
          desktopAvailable={desktopAvailable}
          labels={labels}
          datasets={datasets}
          loading={loading}
          importing={importing}
          error={error}
          pendingDeleteIds={pendingDeleteIds}
          onImport={handleImport}
          onImportFolder={handleImportFolder}
          onConverted={() => void refreshDatasets()}
          onDelete={handleDelete}
          onSeal={async (ids, sealed) => {
            const seal = async (which: boolean) => {
              await invoke("set_datasets_sealed", { ids, sealed: which });
              await refreshDatasets();
            };
            try {
              await seal(sealed);
              feedbackWithUndo(
                sealed ? "Sealed for the final test" : "Unsealed",
                `${ids.length} recording${ids.length === 1 ? "" : "s"}.`,
                () => void seal(!sealed).catch((err) => setError(String(err))),
              );
            } catch (err) {
              setError(String(err));
            }
          }}
        />
        <Card id="lab-coverage" role="region" aria-label="Labels">
          <CardContent className="flex flex-wrap items-center justify-between gap-3">
            <span><strong>Labels</strong> <small className="text-muted-foreground">Add, rename and archive labels on the Labels tab. {labels.filter((label) => label.archivedAt === null).length} in use here.</small></span>
            {onOpenLabels && <Button type="button" variant="outline" onClick={onOpenLabels}>Open Labels</Button>}
          </CardContent>
        </Card>
        <TrainPanel desktopAvailable={desktopAvailable} labels={labels} datasets={datasets} onOpenNetworkLab={onOpenNetworkLab} />
        <TrainingHistory desktopAvailable={desktopAvailable} labels={labels} datasets={datasets} refreshKey={models.map((model) => `${model.id}:${model.state}`).join(",")} />
        <LabelModelsPanel desktopAvailable={desktopAvailable} models={models} status={status} loadError={modelsError} refresh={refresh} onInspect={onInspectModel} />
        <MistakesCard desktopAvailable={desktopAvailable} models={models} />
        <ThresholdCard desktopAvailable={desktopAvailable} models={models} />
        <CompareCard desktopAvailable={desktopAvailable} models={models} />
        <SealedTestCard desktopAvailable={desktopAvailable} models={models} datasets={datasets} />
        <DetectionActivity desktopAvailable={desktopAvailable} />
      </fieldset>
    </main>
  );
}
