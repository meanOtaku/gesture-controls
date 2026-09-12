import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { usePendingActions } from "../hooks/usePendingActions";
import {
  DEPLOYABLE_CLASS_LABELS,
  appendRuntimeEvent,
  describeDiagnosticValue,
  describeWindow,
  type DatasetLabel,
  type DatasetSummary,
  type EnvironmentDiagnostic,
  type GestureIntent,
  type GesturePolicyDecision,
  type InferenceMode,
  type ModelIntentBinding,
  type ModelLifecycleState,
  type ModelRegistryView,
  type PpgWindowObservation,
  type ReplayReport,
  type RuntimeEvent,
  type TrainedModelSummary,
  type TrainingBackend,
  type TrainingEventPayload,
  type TrainingStatus,
} from "../types";
import { DatasetManager } from "./DatasetManager";
import { ModelLifecycleControls } from "./ModelLifecycleControls";
import { ModelRegistryTable } from "./ModelRegistryTable";
import { ReadinessPanel } from "./ReadinessPanel";
import { ReplayPanel } from "./ReplayPanel";
import { TrainingPanel } from "./TrainingPanel";

/** Mirrors `model_lab::TRAINING_EVENT` in src-tauri/src/model_lab.rs. */
const TRAINING_EVENT = "model-lab-training-event";
const MODEL_REGISTRY_EVENT = "model-registry-updated";
const PPG_WINDOW_OBSERVED_EVENT = "gesture-ppg-window-observed";
const GESTURE_POLICY_EVENT = "gesture-policy-decision";

export function ModelLab() {
  const desktopAvailable = "__TAURI_INTERNALS__" in window;
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [labels, setLabels] = useState<DatasetLabel[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedDatasetIds, setSelectedDatasetIds] = useState<Set<string>>(new Set());
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(new Set());
  const [trainingBackend, setTrainingBackend] = useState<TrainingBackend>("tflite");
  const [status, setStatus] = useState<TrainingStatus>({ phase: "idle" });
  const [logs, setLogs] = useState<string[]>([]);
  const [trainedModels, setTrainedModels] = useState<TrainedModelSummary[]>([]);
  const [trainingError, setTrainingError] = useState<string | null>(null);
  const [registry, setRegistry] = useState<ModelRegistryView | null>(null);
  const [runtimeEvents, setRuntimeEvents] = useState<RuntimeEvent[]>([]);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [environmentDiagnostics, setEnvironmentDiagnostics] = useState<EnvironmentDiagnostic[]>([]);
  const [environmentError, setEnvironmentError] = useState<string | null>(null);
  const [bindingDrafts, setBindingDrafts] = useState<Record<string, Record<string, GestureIntent>>>({});
  const [bindingError, setBindingError] = useState<string | null>(null);
  const { isPending, run } = usePendingActions();

  const refreshDatasets = useCallback(async () => {
    if (!desktopAvailable) return;
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
  }, [desktopAvailable]);

  const refreshLabels = useCallback(async () => {
    if (!desktopAvailable) return;
    try {
      const result = await invoke<DatasetLabel[]>("list_model_labels");
      setLabels(Array.isArray(result) ? result : []);
    } catch (err) {
      setError(String(err));
    }
  }, [desktopAvailable]);

  const refreshTrainingStatus = useCallback(async () => {
    if (!desktopAvailable) return;
    try {
      const result = await invoke<TrainingStatus>("get_training_status");
      setStatus(result);
    } catch (err) {
      setTrainingError(String(err));
    }
  }, [desktopAvailable]);

  const refreshTrainedModels = useCallback(async () => {
    if (!desktopAvailable) return;
    try {
      const result = await invoke<TrainedModelSummary[]>("list_trained_models");
      setTrainedModels(result);
    } catch (err) {
      setTrainingError(String(err));
    }
  }, [desktopAvailable]);

  const refreshRegistry = useCallback(async () => {
    if (!desktopAvailable) return;
    try {
      setRegistry(await invoke<ModelRegistryView>("get_model_registry"));
      setRuntimeError(null);
    } catch (err) {
      setRuntimeError(String(err));
    }
  }, [desktopAvailable]);

  const refreshEnvironmentDiagnostics = useCallback(async () => {
    if (!desktopAvailable) return;
    try {
      const result = await invoke<EnvironmentDiagnostic[]>("get_environment_diagnostics");
      setEnvironmentDiagnostics(Array.isArray(result) ? result : []);
      setEnvironmentError(null);
    } catch (err) {
      setEnvironmentError(String(err));
    }
  }, [desktopAvailable]);

  useEffect(() => {
    void refreshDatasets();
  }, [refreshDatasets]);

  useEffect(() => {
    void refreshLabels();
  }, [refreshLabels]);

  useEffect(() => {
    void refreshTrainingStatus();
    void refreshTrainedModels();
  }, [refreshTrainingStatus, refreshTrainedModels]);

  useEffect(() => {
    void refreshRegistry();
  }, [refreshRegistry]);

  useEffect(() => {
    void refreshEnvironmentDiagnostics();
  }, [refreshEnvironmentDiagnostics]);

  useEffect(() => {
    if (!desktopAvailable) return;
    let cancelled = false;
    const unlistens: (() => void)[] = [];
    const addListener = <T,>(event: string, handler: (payload: T) => void) => {
      void listen<T>(event, ({ payload }) => { if (!cancelled) handler(payload); }).then((unlisten) => {
        if (cancelled) unlisten();
        else unlistens.push(unlisten);
      }).catch((err) => {
        if (!cancelled) setRuntimeError(`Could not subscribe to inference updates: ${String(err)}`);
      });
    };
    addListener<ModelRegistryView>(MODEL_REGISTRY_EVENT, setRegistry);
    addListener<PpgWindowObservation>(PPG_WINDOW_OBSERVED_EVENT, (observation) => {
      setRuntimeEvents((previous) => appendRuntimeEvent(previous, { kind: "window", observation }));
    });
    addListener<GesturePolicyDecision>(GESTURE_POLICY_EVENT, (decision) => {
      setRuntimeEvents((previous) => appendRuntimeEvent(previous, { kind: "decision", decision }));
    });
    return () => {
      cancelled = true;
      unlistens.forEach((unlisten) => unlisten());
    };
  }, [desktopAvailable]);

  useEffect(() => {
    if (!desktopAvailable) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<TrainingEventPayload>(TRAINING_EVENT, ({ payload }) => {
      if (cancelled) return;
      switch (payload.kind) {
        case "started":
          setStatus({
            phase: "running",
            jobId: payload.jobId,
            datasetIds: payload.datasetIds,
            backend: payload.backend,
            startedAt: new Date().toISOString(),
          });
          setLogs([]);
          setTrainingError(null);
          break;
        case "log":
          setLogs((prev) => [...prev, payload.message].slice(-500));
          break;
        case "completed":
          setStatus({
            phase: "completed",
            jobId: payload.jobId,
            modelId: payload.modelId,
            backend: payload.backend,
            modelCard: payload.modelCard,
          });
          void refreshTrainedModels();
          void refreshRegistry();
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
    }).catch((err) => {
      if (!cancelled) setTrainingError(`Could not subscribe to training updates: ${String(err)}`);
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [desktopAvailable, refreshRegistry, refreshTrainedModels]);

  const handleImport = useCallback(
    async ({ filename, csvContent }: { filename: string; csvContent: string }) => {
      setImporting(true);
      try {
        await invoke("import_model_dataset", { filename, csvContent });
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
      setPendingDeleteIds((prev) => new Set(prev).add(id));
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
      await invoke<string>("start_training_job", { datasetIds, backend: trainingBackend });
    } catch (err) {
      setTrainingError(String(err));
    }
  }, [selectedDatasetIds, status.phase, trainingBackend]);

  const handleCancelTraining = useCallback(async () => {
    if (status.phase !== "running") return;
    try {
      await invoke("cancel_training_job", { jobId: status.jobId });
    } catch (err) {
      setTrainingError(String(err));
    }
  }, [status]);

  const handleInferenceMode = useCallback(async (mode: InferenceMode) => {
    try {
      setRegistry(await invoke<ModelRegistryView>("set_inference_mode", { mode }));
      setRuntimeError(null);
    } catch (err) {
      setRuntimeError(String(err));
    }
  }, []);

  const handleLifecycleTransition = useCallback(async (id: string, to: ModelLifecycleState) => {
    try {
      setRegistry(await invoke<ModelRegistryView>("transition_model_state", { id, to }));
      setRuntimeError(null);
    } catch (err) {
      setRuntimeError(String(err));
    }
  }, []);

  const handleActivate = useCallback(async (id: string) => {
    try {
      setRegistry(await invoke<ModelRegistryView>("activate_model", { id }));
      setRuntimeError(null);
    } catch (err) {
      setRuntimeError(String(err));
    }
  }, []);

  const handleRollback = useCallback(async () => {
    try {
      setRegistry(await invoke<ModelRegistryView>("rollback_active_model"));
      setRuntimeError(null);
    } catch (err) {
      setRuntimeError(String(err));
    }
  }, []);

  const handleDraftChange = useCallback((modelId: string, classLabel: string, intent: GestureIntent) => {
    setBindingDrafts((previous) => ({
      ...previous,
      [modelId]: { ...previous[modelId], [classLabel]: intent },
    }));
  }, []);

  const handleSaveBindings = useCallback(
    async (modelId: string) => {
      const model = registry?.models.find((entry) => entry.id === modelId);
      if (!model) return;
      const draft = bindingDrafts[modelId] ?? {};
      const bindings: ModelIntentBinding[] = DEPLOYABLE_CLASS_LABELS.map((classLabel) => {
        const existing = model.intentBindings.find((entry) => entry.classLabel === classLabel);
        const intent: GestureIntent = draft[classLabel] ?? existing?.intent ?? "noAction";
        return { classLabel, intent };
      });
      setBindingError(null);
      try {
        setRegistry(await invoke<ModelRegistryView>("set_model_intent_bindings", { id: modelId, bindings }));
      } catch (err) {
        setBindingError(String(err));
      }
    },
    [registry, bindingDrafts],
  );

  const handleReplay = useCallback(
    async ({ modelId, datasetIds, maxOutcomes }: { modelId: string; datasetIds: string[]; maxOutcomes: number }) =>
      invoke<ReplayReport>("replay_model_dataset", { modelId, datasetIds, maxOutcomes }),
    [],
  );

  const coverageByLabel = new Map<string, number>();
  for (const dataset of datasets) {
    coverageByLabel.set(dataset.label, (coverageByLabel.get(dataset.label) ?? 0) + 1);
  }

  const isRunning = status.phase === "running";
  const trainedModelById = new Map(trainedModels.map((model) => [model.id, model]));
  const deployableModelIds = (registry?.models ?? [])
    .filter((model) =>
      (model.state === "approved" || model.state === "active")
      && trainedModelById.get(model.id)?.backend === "tflite")
    .map((model) => model.id);

  return (
    <main className="shell model-lab-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Spatial Gesture Control</p>
          <h1>Model Lab</h1>
          <p className="subtitle">
            Build a gesture model from your recordings. Import sessions, train a candidate, then review it before enabling desktop control.
          </p>
        </div>
        <div className={`connection ${trainedModels.length > 0 ? "online" : "offline"}`}>
          <span className="pulse" />
          {!desktopAvailable ? "Browser preview" : trainedModels.length > 0
            ? `${trainedModels.length} trained model${trainedModels.length === 1 ? "" : "s"}`
            : "No trained model"}
        </div>
      </header>

      {!desktopAvailable && <aside className="preview-notice" role="status">
        <span className="preview-icon" aria-hidden="true">i</span>
        <div><strong>You’re viewing the browser preview</strong><p>Import, training, and inference need the desktop app. Open it with <code>npm start</code> from the project folder. Your saved datasets and models are available there.</p></div>
      </aside>}
      <div className="lab-summary" aria-label="Model Lab overview">
        <div><span className="label">Imported sessions</span><strong>{desktopAvailable ? datasets.length : "—"}</strong><small>{desktopAvailable ? `${selectedDatasetIds.size} selected for training` : "Available in the desktop app"}</small></div>
        <div><span className="label">Trained models</span><strong>{desktopAvailable ? trainedModels.length : "—"}</strong><small>{desktopAvailable ? isRunning ? "Training in progress" : "Ready for your next experiment" : "Available in the desktop app"}</small></div>
        <div><span className="label">Desktop control</span><strong>{desktopAvailable ? registry?.inferenceMode ?? "Checking" : "Preview"}</strong><small>{registry?.activeModelId ? "A model is active" : "No active model"}</small></div>
      </div>
      <nav className="lab-workflow" aria-label="Model workflow">
        <a href="#lab-dataset">01 · Import</a><a href="#lab-coverage">02 · Labels</a><a href="#lab-training">03 · Train</a><a href="#lab-evaluation">04 · Review</a><a href="#lab-replay">05 · Replay</a><a href="#lab-deployment">06 · Activate</a>
      </nav>
      {runtimeError && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{runtimeError}</AlertDescription>
        </Alert>
      )}
      <fieldset className="lab-workspace" disabled={!desktopAvailable} aria-label="Desktop model tools">
        <ReadinessPanel
          desktopAvailable={desktopAvailable}
          diagnostics={environmentDiagnostics}
          error={environmentError}
          onRecheck={refreshEnvironmentDiagnostics}
        />

        <DatasetManager
          desktopAvailable={desktopAvailable}
          datasets={datasets}
          labels={labels}
          loading={loading}
          importing={importing}
          error={error}
          selectedDatasetIds={selectedDatasetIds}
          pendingDeleteIds={pendingDeleteIds}
          coverageByLabel={coverageByLabel}
          onImport={handleImport}
          onDelete={handleDelete}
          onToggleSelected={toggleDatasetSelected}
        />

        <TrainingPanel
          trainingBackend={trainingBackend}
          onBackendChange={setTrainingBackend}
          status={status}
          logs={logs}
          trainingError={trainingError}
          selectedCount={selectedDatasetIds.size}
          onStart={() => void handleStartTraining()}
          onCancel={() => void handleCancelTraining()}
        />

        <ModelRegistryTable trainedModels={trainedModels} />

        <ReplayPanel deployableModelIds={deployableModelIds} datasets={datasets} onReplay={handleReplay} />

        <ModelLifecycleControls
          registry={registry}
          trainedModelById={trainedModelById}
          bindingDrafts={bindingDrafts}
          bindingError={bindingError}
          isPending={isPending}
          run={run}
          onDraftChange={handleDraftChange}
          onSaveBindings={handleSaveBindings}
          onTransition={handleLifecycleTransition}
          onActivate={handleActivate}
          onRollback={handleRollback}
        />

        <Card role="region" aria-label="Live inference diagnostics" className="min-w-0">
          <CardHeader>
            <SectionHeader
              title="Live inference diagnostics"
              description={
                registry?.activeModelId
                  ? `Active model: ${registry.activeModelId}. Monitor records decisions without desktop actions; Live permits bound safe intents.`
                  : "Inference is fail-closed: activate a validated LiteRT bundle with complete safe-intent bindings before Monitor or Live can run."
              }
              help={{
                label: "About inference modes",
                content: "Off runs no inference. Monitor evaluates windows and logs decisions without ever touching desktop controls. Live is the only mode that may act on bound safe intents.",
              }}
              status={
                <Badge variant={registry && registry.inferenceMode !== "off" ? "default" : "secondary"}>
                  {registry ? registry.inferenceMode : desktopAvailable ? "Checking" : "Desktop only"}
                </Badge>
              }
            />
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="recording-actions">
              {(["off", "monitor", "live"] as const).map((mode) => (
                <button
                  key={mode}
                  className={registry?.inferenceMode === mode ? "recording" : undefined}
                  disabled={!registry || (mode !== "off" && !registry.activeModelId)}
                  onClick={() => void handleInferenceMode(mode)}
                >
                  {mode[0].toUpperCase() + mode.slice(1)}
                </button>
              ))}
            </div>
            {runtimeEvents.length === 0 ? (
              <p className="hint">No desktop inference windows observed in this session.</p>
            ) : (
              <div className="vectors model-lab-models" aria-label="Recent inference events">
                {runtimeEvents.map((event, index) => (
                  <div className="vector-row model-lab-label-row" key={`${event.kind}-${index}`}>
                    {event.kind === "window" ? (
                      <span className="label">Window #{event.observation.sequence}: {describeWindow(event.observation)}</span>
                    ) : (
                      <span className="label">{event.decision.live ? "Live" : "Monitor"} {event.decision.intent}: {describeDiagnosticValue(event.decision.reason)}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </fieldset>
    </main>
  );
}
