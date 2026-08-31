import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { GESTURE_DATASET_LABELS, type GestureDatasetLabel } from "../../telemetry/store/telemetryStore";

/** Milestone 10 desktop slice: no managed runner exists yet, so every control that would launch,
 * cancel, or export a real training run stays disabled with this reason instead of pretending to work. */
export const RUNNER_UNAVAILABLE_REASON =
  "Managed Tauri runner is the next integration slice. Training, cancelling, and exporting only work today through the offline tools/pinch-classifier CLI.";

type LabelRole = "positive" | "hold" | "negative";

const POSITIVE_LABELS: readonly GestureDatasetLabel[] = ["pinch_start", "pinch_release"];
const HOLD_LABEL: GestureDatasetLabel = "pinch_hold";

function roleFor(label: GestureDatasetLabel): LabelRole {
  if (POSITIVE_LABELS.includes(label)) return "positive";
  if (label === HOLD_LABEL) return "hold";
  return "negative";
}

const ROLE_COPY: Record<LabelRole, string> = {
  positive: "Trained class",
  hold: "Optional (--hold-handling)",
  negative: "Negative / background",
};

/** Mirrors `DatasetSummary` in src-tauri/src/model_lab.rs (serde camelCase). */
interface DatasetSummary {
  id: string;
  originalFilename: string;
  importedAt: string;
  label: string;
  rowCount: number;
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("failed to read dataset CSV"));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsText(file);
  });
}

export function ModelLab() {
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refreshDatasets = useCallback(async () => {
    setLoading(true);
    try {
      const result = await invoke<DatasetSummary[]>("list_model_datasets");
      setDatasets(result);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshDatasets();
  }, [refreshDatasets]);

  const handleFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      setImporting(true);
      try {
        const csvContent = await readFileAsText(file);
        await invoke("import_model_dataset", { filename: file.name, csvContent });
        setError(null);
        await refreshDatasets();
      } catch (err) {
        setError(String(err));
      } finally {
        setImporting(false);
      }
    },
    [refreshDatasets],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await invoke("delete_model_dataset", { id });
        setError(null);
        await refreshDatasets();
      } catch (err) {
        setError(String(err));
      }
    },
    [refreshDatasets],
  );

  const coverageByLabel = new Map<string, number>();
  for (const dataset of datasets) {
    coverageByLabel.set(dataset.label, (coverageByLabel.get(dataset.label) ?? 0) + 1);
  }

  return (
    <main className="shell model-lab-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Spatial Gesture Control</p>
          <h1>Model Lab</h1>
          <p className="subtitle">
            Turns labeled dataset recordings from the Live data tab into a trained pinch_start / pinch_release
            classifier. This slice documents the real workflow end to end; it does not run training, evaluation,
            or export from inside the desktop app yet.
          </p>
        </div>
        <div className="connection offline"><span className="pulse" />No trained model</div>
      </header>

      <p className="calibration-warning" role="status">{RUNNER_UNAVAILABLE_REASON}</p>

      <section className="calibration-card" aria-label="Dataset">
        <div className="calibration-heading">
          <div><p className="eyebrow">Step 1</p><h2>Dataset</h2></div>
        </div>
        <p className="hint">
          Use the Live data tab&apos;s labeled dataset recorder to capture one CSV per session: pick a label,
          start recording, perform the gesture (or the background activity), stop, then Export Dataset CSV. Each
          exported file is one recording session, labeled uniformly for its whole duration.
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv"
          hidden
          onChange={(event) => {
            void handleFileChange(event);
          }}
        />
        <div className="recording-actions">
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
          >
            {importing ? "Importing…" : "Import dataset CSV"}
          </button>
        </div>
        {error && <p className="calibration-error" role="alert">{error}</p>}
        {loading ? (
          <p className="hint">Loading imported sessions&hellip;</p>
        ) : datasets.length === 0 ? (
          <p className="hint">No dataset sessions imported yet. Export a CSV from the Live data tab, then import it here.</p>
        ) : (
          <div className="vectors model-lab-datasets">
            {datasets.map((dataset) => (
              <div className="vector-row model-lab-label-row" key={dataset.id}>
                <span className="label">
                  {dataset.originalFilename} &mdash; {dataset.label.replaceAll("_", " ")} ({dataset.rowCount} rows)
                </span>
                <button onClick={() => void handleDelete(dataset.id)}>Delete</button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="calibration-card" aria-label="Label coverage">
        <div className="calibration-heading">
          <div><p className="eyebrow">Step 2</p><h2>Label coverage</h2></div>
        </div>
        <p className="hint">
          These are the recorder&apos;s fixed labels (<code>telemetryStore.GESTURE_DATASET_LABELS</code>). Only
          the pinch labels feed the classifier directly; every other label becomes the negative/background class
          used to measure false activations.
        </p>
        <div className="vectors model-lab-labels">
          {GESTURE_DATASET_LABELS.map((label) => {
            const role = roleFor(label);
            const count = coverageByLabel.get(label) ?? 0;
            return (
              <div className="vector-row model-lab-label-row" key={label}>
                <span className="label">{label.replaceAll("_", " ")}</span>
                <span className="model-lab-coverage-count">{count} session{count === 1 ? "" : "s"}</span>
                <span className={`model-lab-chip model-lab-chip--${role}`}>{ROLE_COPY[role]}</span>
              </div>
            );
          })}
        </div>
        <p className="hint">
          Record at least 2 separate session files per label you plan to train on: evaluation is a grouped
          holdout by session (<code>GroupShuffleSplit</code> on <code>session_id</code>), so a label with only
          one session has nothing to hold out. Aim for more sessions on <code>pinch_start</code> /{" "}
          <code>pinch_release</code> and on whichever everyday-activity labels are most likely to trigger false
          activations for you.
        </p>
      </section>

      <section className="calibration-card" aria-label="Training">
        <div className="calibration-heading">
          <div><p className="eyebrow">Step 3</p><h2>Training</h2></div>
        </div>
        <p className="hint">Run the baseline trainer against your exported sessions from a terminal:</p>
        <div className="vector-row">
          <code>pinch-classifier-train --input session1.csv session2.csv --output-dir artifacts/</code>
        </div>
        <p className="hint">
          Defaults: 500&nbsp;ms windows, 150&nbsp;ms stride, 250&nbsp;ms max gap before splitting a session,
          3-sample minimum per window, <code>pinch_hold</code> excluded (change with{" "}
          <code>--hold-handling exclude|negative|class</code>), 25% of sessions held out, 200-tree RandomForest.
          Run <code>pinch-classifier-train --help</code> for the full flag list.
        </p>
        <div className="recording-actions">
          <button disabled title={RUNNER_UNAVAILABLE_REASON}>Start training</button>
          <button disabled title={RUNNER_UNAVAILABLE_REASON}>Cancel</button>
        </div>
        <p className="hint">{RUNNER_UNAVAILABLE_REASON}</p>
      </section>

      <section className="calibration-card" aria-label="Evaluation">
        <div className="calibration-heading">
          <div><p className="eyebrow">Step 4</p><h2>Evaluation</h2></div>
        </div>
        <p className="hint">
          Each training run writes <code>model_card.json</code> next to <code>model.joblib</code>, with{" "}
          <code>accuracy</code>, <code>macro_f1</code>, a full <code>classification_report</code> and{" "}
          <code>confusion_matrix</code>, plus false-activation metrics that matter more than raw accuracy here:{" "}
          <code>false_activation_count</code>, <code>false_activation_total_negative_windows</code>, and{" "}
          <code>false_activation_rate</code> (negative test windows the model wrongly called an activation).
        </p>
        <p className="hint">
          No trained model exists yet, so there are no metrics to show. This tab does not parse or display{" "}
          <code>model_card.json</code> in this slice &mdash; read it directly from the CLI&apos;s output
          directory.
        </p>
      </section>

      <section className="calibration-card" aria-label="Export and deploy">
        <div className="calibration-heading">
          <div><p className="eyebrow">Step 5</p><h2>Export / Deploy</h2></div>
        </div>
        <p className="hint">
          Training only produces a scikit-learn <code>model.joblib</code>, loadable with{" "}
          <code>joblib.load</code>. TFLite/LiteRT conversion for on-device deployment is not implemented yet
          &mdash; <code>model_card.json</code>&apos;s <code>tflite_export</code> field says so explicitly. There
          is nothing to deploy to headphones or the watch from this app yet.
        </p>
        <div className="recording-actions">
          <button disabled title={RUNNER_UNAVAILABLE_REASON}>Export model</button>
          <button disabled title={RUNNER_UNAVAILABLE_REASON}>Deploy to device</button>
        </div>
        <p className="hint">{RUNNER_UNAVAILABLE_REASON}</p>
      </section>
    </main>
  );
}
