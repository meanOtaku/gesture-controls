import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { OperationFeedback } from "../../../components/app/OperationFeedback";
import { Card, CardContent } from "../../../components/ui/card";
import { useLabelModels } from "../hooks/useLabelModels";
import { datasetLabels, type DatasetLabel, type DatasetSummary } from "../types";
import { DatasetManager } from "./DatasetManager";
import { DetectionActivity } from "./DetectionActivity";
import { LabelCoverage } from "./LabelCoverage";
import { LabelModelsPanel } from "./LabelModelsPanel";

/**
 * Model Lab: teach the app a gesture one label at a time. Models are listed and switched on first, because that is
 * what you come back to; recordings and label coverage follow.
 */
export function ModelLab() {
  const desktopAvailable = "__TAURI_INTERNALS__" in window;
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [labels, setLabels] = useState<DatasetLabel[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(new Set());
  const { models, status, error: modelsError, refresh } = useLabelModels(desktopAvailable);

  const refreshDatasets = useCallback(async () => {
    if (!desktopAvailable) return;
    setLoading(true);
    try {
      setDatasets(await invoke<DatasetSummary[]>("list_model_datasets"));
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [desktopAvailable]);

  useEffect(() => {
    void refreshDatasets();
  }, [refreshDatasets]);

  useEffect(() => {
    if (!desktopAvailable) return;
    void (async () => {
      try {
        const result = await invoke<DatasetLabel[]>("list_model_labels");
        setLabels(Array.isArray(result) ? result : []);
      } catch (err) {
        setError(String(err));
      }
    })();
  }, [desktopAvailable]);

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
        <a href="#lab-labels">Models</a><a href="#lab-activity">Activity</a><a href="#lab-coverage">Labels</a><a href="#lab-dataset">Recordings</a>
      </nav>

      <fieldset className="lab-workspace card-stack" disabled={!desktopAvailable} aria-label="Desktop model tools">
        <LabelModelsPanel desktopAvailable={desktopAvailable} models={models} status={status} loadError={modelsError} refresh={refresh} />
        <DetectionActivity desktopAvailable={desktopAvailable} />
        <LabelCoverage labels={labels} models={models} coverageByLabel={coverageByLabel} />
        <DatasetManager
          desktopAvailable={desktopAvailable}
          datasets={datasets}
          loading={loading}
          importing={importing}
          error={error}
          pendingDeleteIds={pendingDeleteIds}
          onImport={handleImport}
          onDelete={handleDelete}
        />
      </fieldset>
    </main>
  );
}
