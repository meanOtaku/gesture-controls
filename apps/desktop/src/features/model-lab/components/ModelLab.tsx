import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { GESTURE_DATASET_LABELS, type GestureDatasetLabel } from "../../telemetry/store/telemetryStore";

/** Mirrors `model_lab::TRAINING_EVENT` in src-tauri/src/model_lab.rs. */
const TRAINING_EVENT = "model-lab-training-event";

/** This is a local development runner, not a packaged app feature: the desktop app shells
 * out to `uv run --project tools/pinch-classifier pinch-classifier-train`, so training only
 * works from a full repository checkout with uv (https://docs.astral.sh/uv/) on PATH. */
export const DEV_RUNNER_NOTICE =
  "Training runs through a local development runner: the desktop app shells out to " +
  "`uv run --project tools/pinch-classifier pinch-classifier-train`. It only works from a full " +
  "repository checkout with uv (https://docs.astral.sh/uv/) installed and on PATH.";

export const EXPORT_UNAVAILABLE_REASON =
  "Model export and on-device deploy are not implemented in this slice; only training and " +
  "evaluation run through the desktop app today.";

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

/** Mirrors `TrainingStatus` in src-tauri/src/model_lab.rs (serde tag "phase", camelCase). */
type TrainingStatus =
  | { phase: "idle" }
  | { phase: "running"; jobId: string; datasetIds: string[]; startedAt: string }
  | { phase: "completed"; jobId: string; modelId: string; modelCard: ModelCard }
  | { phase: "failed"; jobId: string; message: string };

/** Mirrors `TrainingEvent` in src-tauri/src/model_lab.rs (serde tag "kind", camelCase). */
type TrainingEventPayload =
  | { kind: "started"; jobId: string; datasetIds: string[] }
  | { kind: "log"; jobId: string; message: string }
  | { kind: "completed"; jobId: string; modelId: string; modelCard: ModelCard }
  | { kind: "failed"; jobId: string; message: string }
  | { kind: "cancelled"; jobId: string };

/** Loose shape of model_card.json, written by tools/pinch-classifier/src/pinch_classifier/train.py. */
interface ModelCard {
  created_at?: string;
  classes?: string[];
  n_windows_train?: number;
  n_windows_test?: number;
  metrics?: {
    accuracy?: number;
    macro_f1?: number;
    false_activation_count?: number;
    false_activation_total_negative_windows?: number;
    false_activation_rate?: number | null;
  };
}

/** Mirrors `TrainedModelSummary` in src-tauri/src/model_lab.rs (serde camelCase). */
interface TrainedModelSummary {
  id: string;
  modelCard: ModelCard;
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("failed to read dataset CSV"));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsText(file);
  });
}

function formatPercent(value: number | null | undefined): string {
  return value == null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

export function ModelLab() {
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedDatasetIds, setSelectedDatasetIds] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<TrainingStatus>({ phase: "idle" });
  const [logs, setLogs] = useState<string[]>([]);
  const [trainedModels, setTrainedModels] = useState<TrainedModelSummary[]>([]);
  const [trainingError, setTrainingError] = useState<string | null>(null);
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

  const refreshTrainingStatus = useCallback(async () => {
    try {
      const result = await invoke<TrainingStatus>("get_training_status");
      setStatus(result);
    } catch (err) {
      setTrainingError(String(err));
    }
  }, []);

  const refreshTrainedModels = useCallback(async () => {
    try {
      const result = await invoke<TrainedModelSummary[]>("list_trained_models");
      setTrainedModels(result);
    } catch (err) {
      setTrainingError(String(err));
    }
  }, []);

  useEffect(() => {
    void refreshDatasets();
  }, [refreshDatasets]);

  useEffect(() => {
    void refreshTrainingStatus();
    void refreshTrainedModels();
  }, [refreshTrainingStatus, refreshTrainedModels]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<TrainingEventPayload>(TRAINING_EVENT, ({ payload }) => {
      switch (payload.kind) {
        case "started":
          setStatus({
            phase: "running",
            jobId: payload.jobId,
            datasetIds: payload.datasetIds,
            startedAt: new Date().toISOString(),
          });
          setLogs([]);
          setTrainingError(null);
          break;
        case "log":
          setLogs((prev) => [...prev, payload.message]);
          break;
        case "completed":
          setStatus({ phase: "completed", jobId: payload.jobId, modelId: payload.modelId, modelCard: payload.modelCard });
          void refreshTrainedModels();
          break;
        case "failed":
          setStatus({ phase: "failed", jobId: payload.jobId, message: payload.message });
          break;
        case "cancelled":
          setLogs((prev) => [...prev, "Training cancelled."]);
          setStatus({ phase: "idle" });
          break;
      }
    }).then((fn) => {
      if (cancelled) {
        fn();
        return;
      }
      unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [refreshTrainedModels]);

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
        setSelectedDatasetIds((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      } catch (err) {
        setError(String(err));
      }
    },
    [refreshDatasets],
  );

  const toggleDatasetSelected = useCallback((id: string) => {
    setSelectedDatasetIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleStartTraining = useCallback(async () => {
    const datasetIds = Array.from(selectedDatasetIds);
    if (datasetIds.length === 0 || status.phase === "running") return;
    setTrainingError(null);
    try {
      await invoke<string>("start_training_job", { datasetIds });
    } catch (err) {
      setTrainingError(String(err));
    }
  }, [selectedDatasetIds, status.phase]);

  const handleCancelTraining = useCallback(async () => {
    if (status.phase !== "running") return;
    try {
      await invoke("cancel_training_job", { jobId: status.jobId });
    } catch (err) {
      setTrainingError(String(err));
    }
  }, [status]);

  const coverageByLabel = new Map<string, number>();
  for (const dataset of datasets) {
    coverageByLabel.set(dataset.label, (coverageByLabel.get(dataset.label) ?? 0) + 1);
  }

  const isRunning = status.phase === "running";
  const sortedTrainedModels = [...trainedModels].sort((a, b) =>
    (b.modelCard.created_at ?? "").localeCompare(a.modelCard.created_at ?? ""),
  );

  return (
    <main className="shell model-lab-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Spatial Gesture Control</p>
          <h1>Model Lab</h1>
          <p className="subtitle">
            Turns labeled dataset recordings from the Live data tab into a trained pinch_start / pinch_release
            classifier. Training and evaluation run in-app through a local development runner; model export and
            on-device deploy are not implemented yet.
          </p>
        </div>
        <div className={`connection ${trainedModels.length > 0 ? "online" : "offline"}`}>
          <span className="pulse" />
          {trainedModels.length > 0
            ? `${trainedModels.length} trained model${trainedModels.length === 1 ? "" : "s"}`
            : "No trained model"}
        </div>
      </header>

      <section className="calibration-card" aria-label="Dataset">
        <div className="calibration-heading">
          <div><p className="eyebrow">Step 1</p><h2>Dataset</h2></div>
        </div>
        <p className="hint">
          Use the Live data tab&apos;s labeled dataset recorder to capture one CSV per session: pick a label,
          start recording, perform the gesture (or the background activity), stop, then Export Dataset CSV. Each
          exported file is one recording session, labeled uniformly for its whole duration. Check the sessions you
          want to train on below.
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
                <label className="model-lab-dataset-select">
                  <input
                    type="checkbox"
                    checked={selectedDatasetIds.has(dataset.id)}
                    onChange={() => toggleDatasetSelected(dataset.id)}
                    aria-label={`Select ${dataset.originalFilename}`}
                  />
                  <span className="label">
                    {dataset.originalFilename} &mdash; {dataset.label.replaceAll("_", " ")} ({dataset.rowCount} rows)
                  </span>
                </label>
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
        <p className="hint" role="status">{DEV_RUNNER_NOTICE}</p>
        <p className="hint">
          Defaults: 500&nbsp;ms windows, 150&nbsp;ms stride, 250&nbsp;ms max gap before splitting a session,
          3-sample minimum per window, <code>pinch_hold</code> excluded (change with{" "}
          <code>--hold-handling exclude|negative|class</code>), 25% of sessions held out, 200-tree RandomForest.
          You can also run the trainer manually from a terminal:
        </p>
        <div className="vector-row">
          <code>pinch-classifier-train --input session1.csv session2.csv --output-dir artifacts/</code>
        </div>
        <div className="recording-actions">
          <button onClick={() => void handleStartTraining()} disabled={selectedDatasetIds.size === 0 || isRunning}>
            {isRunning ? "Training…" : "Start training"}
          </button>
          <button onClick={() => void handleCancelTraining()} disabled={!isRunning}>Cancel</button>
        </div>
        {status.phase === "running" && (
          <p className="hint">
            Running job {status.jobId} on {status.datasetIds.length} dataset{status.datasetIds.length === 1 ? "" : "s"},
            started {status.startedAt}.
          </p>
        )}
        {status.phase === "completed" && (
          <p className="hint">Job {status.jobId} completed &mdash; trained model {status.modelId}.</p>
        )}
        {status.phase === "failed" && (
          <p className="calibration-error" role="alert">Training job {status.jobId} failed: {status.message}</p>
        )}
        {trainingError && <p className="calibration-error" role="alert">{trainingError}</p>}
        {logs.length > 0 && (
          <pre className="model-lab-log" aria-label="Training log">{logs.join("\n")}</pre>
        )}
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
        {sortedTrainedModels.length === 0 ? (
          <p className="hint">No trained models yet. Start a training run above to produce one.</p>
        ) : (
          <div className="vectors model-lab-models">
            {sortedTrainedModels.map((model) => (
              <div className="vector-row model-lab-label-row" key={model.id}>
                <span className="label">
                  {model.id}
                  {model.modelCard.created_at ? ` — ${model.modelCard.created_at}` : ""}
                </span>
                <span className="model-lab-coverage-count">
                  accuracy {formatPercent(model.modelCard.metrics?.accuracy)}, macro F1{" "}
                  {formatPercent(model.modelCard.metrics?.macro_f1)}, false-activation rate{" "}
                  {formatPercent(model.modelCard.metrics?.false_activation_rate)}
                </span>
              </div>
            ))}
          </div>
        )}
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
          <button disabled title={EXPORT_UNAVAILABLE_REASON}>Export model</button>
          <button disabled title={EXPORT_UNAVAILABLE_REASON}>Deploy to device</button>
        </div>
        <p className="hint">{EXPORT_UNAVAILABLE_REASON}</p>
      </section>
    </main>
  );
}
